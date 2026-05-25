package server

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vmihailenco/msgpack/v5"

	"github.com/bedcoder/relay/internal/hub"
	"github.com/bedcoder/relay/internal/pairing"
	"github.com/bedcoder/relay/internal/push"
	"github.com/bedcoder/relay/internal/store"
)

func newPreviewServer(t *testing.T) (*Server, *hub.Hub) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	h := hub.New()
	return New(h, pairing.New(), st, push.Noop{}, Options{}), h
}

func TestParsePreviewPath(t *testing.T) {
	cases := []struct {
		in          string
		token, path string
		port        int
		ok          bool
	}{
		{"/p/tok/3000/", "tok", "/", 3000, true},
		{"/p/tok/3000/foo/bar", "tok", "/foo/bar", 3000, true},
		{"/p/tok/3000", "tok", "/", 3000, true},
		{"/p/tok/notaport/", "", "", 0, false},
		{"/p/tok/", "", "", 0, false},
		{"/p//3000/", "", "", 0, false},
		{"/other/x", "", "", 0, false},
	}
	for _, c := range cases {
		tok, port, path, ok := parsePreviewPath(c.in)
		if ok != c.ok || tok != c.token || port != c.port || path != c.path {
			t.Errorf("parsePreviewPath(%q) = (%q,%d,%q,%v), want (%q,%d,%q,%v)",
				c.in, tok, port, path, ok, c.token, c.port, c.path, c.ok)
		}
	}
}

func TestPreviewUnknownToken(t *testing.T) {
	s, _ := newPreviewServer(t)
	rec := httptest.NewRecorder()
	s.handlePreviewHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/nope/3000/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}

func TestPreviewAgentOffline(t *testing.T) {
	s, _ := newPreviewServer(t)
	s.preview.register("tok", "S1") // token registered, but no agent connected
	rec := httptest.NewRecorder()
	s.handlePreviewHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/tok/3000/", nil))
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
	s.handlePreviewHTTP(rec, httptest.NewRequest(http.MethodGet, "/p/tok/3000/index", nil))

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
