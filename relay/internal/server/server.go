// Package server wires the relay together: a /health endpoint and a /ws
// WebSocket endpoint that runs the pairing rendezvous and the zero-knowledge
// session router (DESIGN §5). The relay forwards opaque payloads and only reads
// the outer envelope (for routing + the notify push hint).
package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coder/websocket"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/bedcoder/relay/internal/envelope"
	"github.com/bedcoder/relay/internal/hub"
	"github.com/bedcoder/relay/internal/pairing"
	"github.com/bedcoder/relay/internal/push"
	"github.com/bedcoder/relay/internal/store"
)

// maxStatusIDs caps the number of session ids /sessions/status accepts in one
// request, to keep the in-memory scan bounded.
const maxStatusIDs = 200

type Server struct {
	hub             *hub.Hub
	rv              *pairing.Rendezvous
	store           *store.Store
	pusher          push.Pusher
	preview         *previewState
	previewLimiters *previewLimiterRegistry

	previewBaseDomain  string
	originPatterns     []string
	insecureSkipOrigin bool
	connSeq            atomic.Uint64
}

type Options struct {
	// AllowedOrigins are exact Origin patterns for browser clients; "*" allows
	// any origin (dev only). Native apps send no Origin and are unaffected.
	AllowedOrigins []string
	// PreviewBaseDomain is the parent domain whose subdomains carry preview
	// traffic: a request to "<port>-<token>.<PreviewBaseDomain>" is routed to
	// the matching session's agent. Empty disables host-based preview (used by
	// tests that don't exercise the HTTP layer through Handler()).
	PreviewBaseDomain string
}

func New(h *hub.Hub, rv *pairing.Rendezvous, st *store.Store, p push.Pusher, opts Options) *Server {
	s := &Server{
		hub:               h,
		rv:                rv,
		store:             st,
		pusher:            p,
		preview:           newPreviewState(),
		previewLimiters:   newPreviewLimiterRegistry(loadPreviewLimits()),
		previewBaseDomain: strings.ToLower(strings.TrimSpace(opts.PreviewBaseDomain)),
	}
	for _, o := range opts.AllowedOrigins {
		if o == "*" {
			s.insecureSkipOrigin = true
		} else {
			s.originPatterns = append(s.originPatterns, originHost(o))
		}
	}
	return s
}

// originHost normalizes an allowed origin to a host pattern, since
// coder/websocket matches OriginPatterns against the Origin header's host.
// Accepts "https://app.vercel.app", "app.vercel.app", or "*.vercel.app".
func originHost(o string) string {
	o = strings.TrimSpace(o)
	if i := strings.Index(o, "://"); i >= 0 {
		o = o[i+3:]
	}
	if i := strings.IndexByte(o, '/'); i >= 0 {
		o = o[:i]
	}
	return o
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/sessions/status", s.handleSessionStatus)

	// Preview reverse-proxy: requests whose Host is "<port>-<token>.<base>" are
	// routed to the matching session's agent (see preview.go). The base domain
	// itself (relay.bedcoder.org) keeps serving /ws + /health + /sessions/status.
	if s.previewBaseDomain == "" {
		return mux
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if port, token, ok := parsePreviewHost(r.Host, s.previewBaseDomain); ok {
			s.handlePreviewHostHTTP(w, r, port, token)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// handleSessionStatus reports whether each requested session currently has at
// least one live agent WebSocket connection. The relay never persists this; it
// is derived in-memory from the hub. Used by the app's session list to show
// online/offline indicators (no secrets are exposed — session ids are not
// secret in the zero-knowledge model).
//
// Request:  GET /sessions/status?ids=sid1,sid2,...
// Response: {"sessions":[{"id":"sid1","agentOnline":true}, ...]}
func (s *Server) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	type entry struct {
		ID          string `json:"id"`
		AgentOnline bool   `json:"agentOnline"`
	}
	type response struct {
		Sessions []entry `json:"sessions"`
	}

	out := response{Sessions: []entry{}}
	raw := strings.TrimSpace(r.URL.Query().Get("ids"))
	if raw != "" {
		seen := make(map[string]struct{})
		for _, id := range strings.Split(raw, ",") {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			out.Sessions = append(out.Sessions, entry{
				ID:          id,
				AgentOnline: len(s.hub.Peers(id, "agent")) > 0,
			})
			if len(out.Sessions) >= maxStatusIDs {
				break
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// pairMsg is the relay's view of a pairing-plane message. Binary fields are
// opaque; the relay only matches/forwards them.
type pairMsg struct {
	Type         string `msgpack:"type"`
	Code         string `msgpack:"code,omitempty"`
	Commit       []byte `msgpack:"commit,omitempty"`
	SID          string `msgpack:"sid,omitempty"`
	AppEphPub    []byte `msgpack:"appEphPub,omitempty"`
	AgentEphPub  []byte `msgpack:"agentEphPub,omitempty"`
	Salt         []byte `msgpack:"salt,omitempty"`
	WrappedKey   []byte `msgpack:"wrappedKey,omitempty"`
	Error        string `msgpack:"error,omitempty"`
	Subscription string `msgpack:"subscription,omitempty"`
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:     s.originPatterns,
		InsecureSkipVerify: s.insecureSkipOrigin,
	})
	if err != nil {
		return
	}
	defer c.CloseNow()

	role := r.URL.Query().Get("role")
	sid := r.URL.Query().Get("sid")
	if role != "agent" && role != "app" {
		_ = c.Close(websocket.StatusPolicyViolation, "role must be agent or app")
		return
	}
	if role == "agent" && sid == "" {
		_ = c.Close(websocket.StatusPolicyViolation, "agent requires sid")
		return
	}

	var writeMu sync.Mutex
	conn := &hub.Conn{
		ID:   strconv.FormatUint(s.connSeq.Add(1), 10),
		SID:  sid,
		Role: role,
		Send: func(ctx context.Context, data []byte) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return c.Write(ctx, websocket.MessageBinary, data)
		},
	}

	// Agents (and reconnecting apps that already know their sid) join the
	// session plane immediately; first-time apps join after pairing completes.
	if sid != "" {
		s.hub.Register(conn)
		_ = s.store.Upsert(sid)
	}
	defer func() {
		if conn.SID != "" {
			s.hub.Unregister(conn)
		}
		if conn.Role == "agent" && conn.SID != "" {
			s.preview.removeSID(conn.SID)         // drop this session's preview tokens
			s.previewLimiters.drop(conn.SID)      // and its rate-limit buckets
		}
		if conn.Code != "" {
			s.rv.Remove(conn.Code)
		}
	}()

	ctx := r.Context()
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			s.dispatch(ctx, conn, data)
		}
	}
}

func (s *Server) dispatch(ctx context.Context, conn *hub.Conn, raw []byte) {
	// Pairing messages carry "type"; session envelopes carry "v"; preview control
	// frames carry "pv" (relay<->agent, plaintext — see preview.go).
	var probe struct {
		Type string `msgpack:"type"`
		V    *int   `msgpack:"v"`
		PV   *int   `msgpack:"pv"`
	}
	if err := msgpack.Unmarshal(raw, &probe); err != nil {
		return
	}
	switch {
	case probe.PV != nil:
		s.handlePreviewFrame(conn, raw)
	case probe.Type != "":
		s.handlePairing(ctx, conn, raw)
	case probe.V != nil:
		s.handleEnvelope(ctx, conn, raw)
	}
}

func (s *Server) handlePairing(ctx context.Context, conn *hub.Conn, raw []byte) {
	var m pairMsg
	if err := msgpack.Unmarshal(raw, &m); err != nil {
		return
	}
	switch m.Type {
	case "register": // agent -> relay: offer a code
		if conn.Role != "agent" || conn.SID == "" || m.Code == "" {
			return
		}
		conn.Code = m.Code
		s.rv.Register(m.Code, conn.SID, m.Commit, conn)

	case "claim": // app -> relay: claim a code
		if conn.Role != "app" {
			return
		}
		slot, err := s.rv.Claim(m.Code, conn)
		if err != nil {
			_ = conn.Send(ctx, mustEncode(pairMsg{Type: "error", Error: err.Error()}))
			return
		}
		conn.Code = m.Code
		conn.SID = slot.SID // adopt the session id for later routing
		_ = conn.Send(ctx, mustEncode(pairMsg{Type: "commit", Commit: slot.Commit, SID: slot.SID}))

	case "responder", "confirm": // app -> agent
		if slot := s.rv.Get(conn.Code); slot != nil && slot.Agent != nil {
			_ = slot.Agent.Send(ctx, raw)
		}

	case "reveal": // agent -> app
		if slot := s.rv.Get(conn.Code); slot != nil && slot.App != nil {
			_ = slot.App.Send(ctx, raw)
		}

	case "key": // agent -> app, then promote the app into the session plane
		slot := s.rv.Get(conn.Code)
		if slot == nil || slot.App == nil {
			return
		}
		_ = slot.App.Send(ctx, raw)
		s.hub.Register(slot.App)
		slot.App.Code = ""
		conn.Code = ""
		s.rv.Remove(slot.Code)

	case "push": // app -> relay: register a Web Push subscription for this session
		if conn.SID != "" && m.Subscription != "" {
			_ = s.store.SetPushSubscription(conn.SID, m.Subscription)
		}
	}
}

func (s *Server) handleEnvelope(ctx context.Context, conn *hub.Conn, raw []byte) {
	if conn.SID == "" {
		return // not yet bound to a session
	}
	s.hub.Route(ctx, conn, raw)
	_ = s.store.Touch(conn.SID)
	// Read the notify hint from the outer frame to fire a push without ever
	// decrypting the payload.
	if env, err := envelope.Unmarshal(raw); err == nil && env.Notify != "" {
		_ = s.pusher.Push(conn.SID, push.Hint(env.Notify))
	}
}

func mustEncode(m pairMsg) []byte {
	b, _ := msgpack.Marshal(&m)
	return b
}
