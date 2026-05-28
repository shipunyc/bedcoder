package server

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/bedcoder/relay/internal/hub"
	"github.com/bedcoder/relay/internal/pairing"
	"github.com/bedcoder/relay/internal/push"
	"github.com/bedcoder/relay/internal/store"
)

const testPreviewBase = "relay.test"

// previewReq builds a request that the Host-based dispatcher will recognize as
// a preview request: Host="<port>-<token>.<base>", path on the proxied server.
func previewReq(token string, port int, path string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://example.invalid"+path, nil)
	r.Host = strconv.Itoa(port) + "-" + token + "." + testPreviewBase
	return r
}

func newPreviewServer(t *testing.T) (*Server, *hub.Hub) {
	t.Helper()
	// Lift the rate-limit defaults so existing tests aren't accidentally paced
	// by the 50 KB/s default; tests that exercise rate limiting set explicit values.
	t.Setenv("BEDCODER_PREVIEW_BPS", "100000000")
	t.Setenv("BEDCODER_PREVIEW_BURST", "100000000")
	t.Setenv("BEDCODER_PREVIEW_CONCURRENCY", "1024")
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	h := hub.New()
	return New(h, pairing.New(), st, push.Noop{}, Options{PreviewBaseDomain: testPreviewBase}), h
}

func TestParsePreviewHost(t *testing.T) {
	cases := []struct {
		in    string
		port  int
		token string
		ok    bool
	}{
		{"3000-tok." + testPreviewBase, 3000, "tok", true},
		{"3000-tok." + testPreviewBase + ":443", 3000, "tok", true}, // host:port stripped
		{"3000-TOK.RELAY.TEST", 3000, "tok", true},                  // case-insensitive
		{"65535-tok." + testPreviewBase, 65535, "tok", true},
		{"3000-tok.foo." + testPreviewBase, 0, "", false},        // multi-label rejected
		{"abc-tok." + testPreviewBase, 0, "", false},             // non-numeric port
		{"0-tok." + testPreviewBase, 0, "", false},               // port out of range
		{"70000-tok." + testPreviewBase, 0, "", false},           // port out of range
		{"-tok." + testPreviewBase, 0, "", false},                // empty port
		{"3000-." + testPreviewBase, 0, "", false},               // empty token
		{"3000tok." + testPreviewBase, 0, "", false},             // missing dash
		{testPreviewBase, 0, "", false},                          // bare base
		{"3000-tok.relay.bedcoder.org", 0, "", false},            // wrong base
		{"", 0, "", false},
	}
	for _, c := range cases {
		p, tok, ok := parsePreviewHost(c.in, testPreviewBase)
		if ok != c.ok || p != c.port || tok != c.token {
			t.Errorf("parsePreviewHost(%q) = (%d,%q,%v), want (%d,%q,%v)",
				c.in, p, tok, ok, c.port, c.token, c.ok)
		}
	}
}

func TestHandlerRoutesPreviewByHost(t *testing.T) {
	s, _ := newPreviewServer(t)
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "http://example.invalid/", nil)
	r.Host = "3000-nope." + testPreviewBase
	s.Handler().ServeHTTP(rec, r)
	// Unknown token → 404 from the preview handler (proves dispatcher reached it).
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 (preview handler), got %d", rec.Code)
	}
}

func TestHandlerFallsThroughForNonPreviewHost(t *testing.T) {
	s, _ := newPreviewServer(t)
	rec := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "http://example.invalid/health", nil)
	r.Host = testPreviewBase // base domain itself → mux
	s.Handler().ServeHTTP(rec, r)
	if rec.Code != http.StatusOK || rec.Body.String() != "ok" {
		t.Fatalf("want 200/ok from /health, got %d / %q", rec.Code, rec.Body.String())
	}
}

func TestPreviewUnknownToken(t *testing.T) {
	s, _ := newPreviewServer(t)
	rec := httptest.NewRecorder()
	s.handlePreviewHostHTTP(rec, previewReq("nope", 3000, "/"), 3000, "nope")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestPreviewAgentOffline(t *testing.T) {
	s, _ := newPreviewServer(t)
	s.preview.register("tok", "S1") // token registered, but no agent connected
	rec := httptest.NewRecorder()
	s.handlePreviewHostHTTP(rec, previewReq("tok", 3000, "/"), 3000, "tok")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("want 502, got %d", rec.Code)
	}
}

func TestPreviewProxiesThroughAgent(t *testing.T) {
	s, h := newPreviewServer(t)
	s.preview.register("tok", "S1")

	// A fake agent: when the relay sends it a preview req, decode it and feed a
	// preview res back through the relay (as the real agent would over its WS).
	agent := &hub.Conn{ID: "a1", SID: "S1", Role: "agent"}
	agent.Send = func(_ context.Context, data []byte) error {
		var m previewMsg
		if err := msgpack.Unmarshal(data, &m); err != nil || m.Op != "req" {
			return nil
		}
		res, _ := msgpack.Marshal(&previewMsg{
			PV: 1, Op: "res", ID: m.ID, Status: 200,
			Headers: map[string]string{"Content-Type": "text/html"},
			BodyB64: base64.StdEncoding.EncodeToString([]byte("<h1>hi from " + m.Path + "</h1>")),
		})
		go s.handlePreviewFrame(agent, res)
		return nil
	}
	h.Register(agent)

	rec := httptest.NewRecorder()
	s.handlePreviewHostHTTP(rec, previewReq("tok", 3000, "/index"), 3000, "tok")

	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/html" {
		t.Fatalf("content-type = %q", ct)
	}
	body, _ := io.ReadAll(rec.Body)
	if !strings.Contains(string(body), "hi from /index") {
		t.Fatalf("unexpected body: %q", body)
	}
}

func TestPreviewForwardsPathAndQuery(t *testing.T) {
	s, h := newPreviewServer(t)
	s.preview.register("tok", "S1")

	var seenPath string
	agent := &hub.Conn{ID: "a1", SID: "S1", Role: "agent"}
	agent.Send = func(_ context.Context, data []byte) error {
		var m previewMsg
		if err := msgpack.Unmarshal(data, &m); err != nil || m.Op != "req" {
			return nil
		}
		seenPath = m.Path
		res, _ := msgpack.Marshal(&previewMsg{PV: 1, Op: "res", ID: m.ID, Status: 200})
		go s.handlePreviewFrame(agent, res)
		return nil
	}
	h.Register(agent)

	r := httptest.NewRequest(http.MethodGet, "http://example.invalid/foo/bar?a=1&b=2", nil)
	r.Host = "3000-tok." + testPreviewBase
	rec := httptest.NewRecorder()
	s.handlePreviewHostHTTP(rec, r, 3000, "tok")
	if seenPath != "/foo/bar?a=1&b=2" {
		t.Fatalf("path forwarded = %q, want /foo/bar?a=1&b=2", seenPath)
	}
}

func TestPreviewRateLimitsResponseBody(t *testing.T) {
	// Tight bucket so a body bigger than burst takes measurable time. With
	// burst=512 and bps=512, a 2048-byte body needs 3 refills → ≥ 3 seconds.
	t.Setenv("BEDCODER_PREVIEW_BPS", "512")
	t.Setenv("BEDCODER_PREVIEW_BURST", "512")
	t.Setenv("BEDCODER_PREVIEW_CONCURRENCY", "16")

	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	h := hub.New()
	s := New(h, pairing.New(), st, push.Noop{}, Options{PreviewBaseDomain: testPreviewBase})
	s.preview.register("tok", "S1")

	agent := &hub.Conn{ID: "a1", SID: "S1", Role: "agent"}
	agent.Send = func(_ context.Context, data []byte) error {
		var m previewMsg
		if err := msgpack.Unmarshal(data, &m); err != nil || m.Op != "req" {
			return nil
		}
		buf := make([]byte, 2048)
		res, _ := msgpack.Marshal(&previewMsg{
			PV: 1, Op: "res", ID: m.ID, Status: 200,
			Headers: map[string]string{"Content-Type": "application/octet-stream"},
			BodyB64: base64.StdEncoding.EncodeToString(buf),
		})
		go s.handlePreviewFrame(agent, res)
		return nil
	}
	h.Register(agent)

	rec := httptest.NewRecorder()
	start := time.Now()
	s.handlePreviewHostHTTP(rec, previewReq("tok", 3000, "/big"), 3000, "tok")
	elapsed := time.Since(start)

	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}
	if got := rec.Body.Len(); got != 2048 {
		t.Fatalf("body len = %d, want 2048", got)
	}
	// 2048 bytes with burst=512 + bps=512: first 512 instant, then 3 × ~1s waits.
	// Allow some slack but reject anything that suggests no rate limiting.
	if elapsed < 2500*time.Millisecond {
		t.Errorf("expected ≥ 2.5s due to rate limit, got %v", elapsed)
	}
}

func TestPreviewLimiterDroppedOnAgentDisconnect(t *testing.T) {
	s, _ := newPreviewServer(t)
	// Force a limiter to be created, then simulate disconnect cleanup.
	first := s.previewLimiters.forSID("S1")
	s.previewLimiters.drop("S1")
	second := s.previewLimiters.forSID("S1")
	if first == second {
		t.Errorf("expected a fresh limiter after drop")
	}
}

func TestPreviewRegisterAndRemoveViaFrames(t *testing.T) {
	s, _ := newPreviewServer(t)
	conn := &hub.Conn{ID: "a1", SID: "S1", Role: "agent", Send: func(context.Context, []byte) error { return nil }}

	reg, _ := msgpack.Marshal(&previewMsg{PV: 1, Op: "register", Token: "tok"})
	s.handlePreviewFrame(conn, reg)
	if sid, ok := s.preview.sidFor("tok"); !ok || sid != "S1" {
		t.Fatalf("register failed: sid=%q ok=%v", sid, ok)
	}

	s.preview.removeSID("S1")
	if _, ok := s.preview.sidFor("tok"); ok {
		t.Fatalf("token should be gone after removeSID")
	}
}
