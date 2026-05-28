package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/bedcoder/relay/internal/hub"
)

// randID returns a short random hex id for request correlation.
func randID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Preview reverse-proxy (Phase 2.1, DESIGN §5 preview carve-out).
//
// This is a DELIBERATE exception to the zero-knowledge invariant, scoped to
// preview traffic only: a public URL https://<port>-<token>.<base>/<path> is
// served by the relay, which forwards the HTTP request to the session's agent
// over its WebSocket (plaintext `pv` control frames) and streams back what the
// agent fetched from localhost:<port>. The chat/files/terminal channels stay
// end-to-end encrypted. The per-session token gates who can reach a dev server.
//
// Subdomain routing (instead of path-prefix) means each preview is mounted at
// the root "/", so dev servers that assume root path (Vite, Next.js, Rails dev)
// work without any HTML/CSS body rewriting.

const previewTimeout = 30 * time.Second

// previewMsg is a relay<->agent preview control frame (msgpack, plaintext).
// Discriminated by `pv` (preview version) so it's distinct from pairing (`type`)
// and session envelopes (`v`).
type previewMsg struct {
	PV      int               `msgpack:"pv"`
	Op      string            `msgpack:"op"` // register | req | res
	Token   string            `msgpack:"token,omitempty"`
	ID      string            `msgpack:"id,omitempty"`
	Port    int               `msgpack:"port,omitempty"`
	Method  string            `msgpack:"method,omitempty"`
	Path    string            `msgpack:"path,omitempty"`
	Headers map[string]string `msgpack:"headers,omitempty"`
	BodyB64 string            `msgpack:"bodyB64,omitempty"`
	Status  int               `msgpack:"status,omitempty"`
	Error   string            `msgpack:"error,omitempty"`
}

// previewState holds the token->sid registry and in-flight request correlation.
type previewState struct {
	mu      sync.RWMutex
	tokens  map[string]string // token -> sid
	pending sync.Map          // request id -> chan previewMsg
}

func newPreviewState() *previewState {
	return &previewState{tokens: map[string]string{}}
}

func (p *previewState) register(token, sid string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.tokens[token] = sid
}

func (p *previewState) sidFor(token string) (string, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	sid, ok := p.tokens[token]
	return sid, ok
}

// removeSID drops every token pointing at a session (agent disconnected).
func (p *previewState) removeSID(sid string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for tok, s := range p.tokens {
		if s == sid {
			delete(p.tokens, tok)
		}
	}
}

// handlePreviewFrame processes an agent's `pv` control frame (register / res).
func (s *Server) handlePreviewFrame(conn *hub.Conn, raw []byte) {
	var m previewMsg
	if err := msgpack.Unmarshal(raw, &m); err != nil {
		return
	}
	switch m.Op {
	case "register":
		if conn.Role == "agent" && conn.SID != "" && m.Token != "" {
			s.preview.register(m.Token, conn.SID)
		}
	case "res":
		if ch, ok := s.preview.pending.Load(m.ID); ok {
			select {
			case ch.(chan previewMsg) <- m:
			default:
			}
		}
	}
}

// handlePreviewHostHTTP serves a request to "<port>-<token>.<base>/<path>" by
// proxying through the session's agent. port/token come from parsePreviewHost.
func (s *Server) handlePreviewHostHTTP(w http.ResponseWriter, r *http.Request, port int, token string) {
	path := r.URL.Path
	if path == "" {
		path = "/"
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}

	sid, ok := s.preview.sidFor(token)
	if !ok {
		http.Error(w, "unknown preview token", http.StatusNotFound)
		return
	}
	agents := s.hub.Peers(sid, "agent")
	if len(agents) == 0 {
		http.Error(w, "agent offline", http.StatusBadGateway)
		return
	}

	// Per-session rate limiting: one user can't saturate the free public relay.
	// Acquire a concurrency slot first (cheap if the cap isn't hit); the response
	// write below paces the body through the same session's bandwidth bucket.
	limiter := s.previewLimiters.forSID(sid)
	release, err := limiter.acquire(r.Context())
	if err != nil {
		http.Error(w, "client closed", http.StatusGatewayTimeout)
		return
	}
	defer release()

	body, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20)) // cap request body at 8MB
	headers := forwardRequestHeaders(r.Header)
	req := previewMsg{
		PV: 1, Op: "req", ID: randID(), Port: port, Method: r.Method, Path: path,
		Headers: headers,
	}
	if len(body) > 0 {
		req.BodyB64 = base64.StdEncoding.EncodeToString(body)
	}

	ch := make(chan previewMsg, 1)
	s.preview.pending.Store(req.ID, ch)
	defer s.preview.pending.Delete(req.ID)

	frame, err := msgpack.Marshal(&req)
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	if err := agents[0].Send(r.Context(), frame); err != nil {
		http.Error(w, "agent send failed", http.StatusBadGateway)
		return
	}

	select {
	case res := <-ch:
		writePreviewResponse(r.Context(), w, res, limiter)
	case <-time.After(previewTimeout):
		http.Error(w, "preview timed out", http.StatusGatewayTimeout)
	case <-r.Context().Done():
	}
}

func writePreviewResponse(ctx context.Context, w http.ResponseWriter, res previewMsg, limiter *previewSessionLimiter) {
	if res.Error != "" {
		http.Error(w, "preview error: "+res.Error, http.StatusBadGateway)
		return
	}

	var body []byte
	if res.BodyB64 != "" {
		if b, err := base64.StdEncoding.DecodeString(res.BodyB64); err == nil {
			body = b
		}
	}

	for k, v := range res.Headers {
		if isHopByHop(k) {
			continue
		}
		w.Header().Set(k, v)
	}
	status := res.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if len(body) > 0 {
		_ = writeRateLimited(ctx, w, body, limiter)
	}
}

// writeRateLimited paces body chunks through the session's bandwidth bucket so
// no single session can drown the relay. Flushes after each chunk so the browser
// sees progressive bytes (it's a normal-looking slow connection, not one big
// stall + flood at the end).
func writeRateLimited(ctx context.Context, w http.ResponseWriter, body []byte, limiter *previewSessionLimiter) error {
	burst := limiter.bw.Burst()
	flusher, _ := w.(http.Flusher)
	for len(body) > 0 {
		chunk := len(body)
		if chunk > burst {
			chunk = burst
		}
		if err := limiter.bw.WaitN(ctx, chunk); err != nil {
			return err
		}
		if _, err := w.Write(body[:chunk]); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		body = body[chunk:]
	}
	return nil
}

// parsePreviewHost splits "<port>-<token>.<base>" → (port, token). Host may
// include ":<port>" suffix (non-standard listening port) — strip it first.
// Match is case-insensitive (DNS is). Returns ok=false for anything that
// doesn't fit the schema or doesn't sit under base.
func parsePreviewHost(host, base string) (port int, token string, ok bool) {
	host = strings.ToLower(host)
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	suffix := "." + strings.ToLower(base)
	if !strings.HasSuffix(host, suffix) {
		return 0, "", false
	}
	label := host[:len(host)-len(suffix)]
	// The subdomain must be a single label — reject "<port>-<token>.foo.<base>"
	// (would be ambiguous; tokens are flat hex, no dots).
	if label == "" || strings.ContainsRune(label, '.') {
		return 0, "", false
	}
	dash := strings.IndexByte(label, '-')
	if dash <= 0 || dash == len(label)-1 {
		return 0, "", false
	}
	p, err := strconv.Atoi(label[:dash])
	if err != nil || p < 1 || p > 65535 {
		return 0, "", false
	}
	return p, label[dash+1:], true
}

// forwardRequestHeaders copies a safe subset of the browser's request headers.
func forwardRequestHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for _, k := range []string{"Accept", "Accept-Language", "Content-Type", "User-Agent", "Cookie", "Range"} {
		if v := h.Get(k); v != "" {
			out[k] = v
		}
	}
	return out
}

func isHopByHop(k string) bool {
	switch http.CanonicalHeaderKey(k) {
	case "Connection", "Keep-Alive", "Transfer-Encoding", "Upgrade", "Proxy-Authorization", "Proxy-Authenticate", "Te", "Trailer":
		return true
	}
	return false
}
