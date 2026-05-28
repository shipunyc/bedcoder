package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/vmihailenco/msgpack/v5"

	"github.com/bedcoder/relay/internal/envelope"
	"github.com/bedcoder/relay/internal/hub"
	"github.com/bedcoder/relay/internal/pairing"
	"github.com/bedcoder/relay/internal/push"
	"github.com/bedcoder/relay/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *push.Mock, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	pm := &push.Mock{}
	srv := New(hub.New(), pairing.New(), st, pm, Options{AllowedOrigins: []string{"*"}})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); _ = st.Close() })
	return ts, pm, st
}

func dial(t *testing.T, ts *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws" + query
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", query, err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	return c
}

func send(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	b, err := msgpack.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func recvPair(t *testing.T, c *websocket.Conn) pairMsg {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m pairMsg
	if err := msgpack.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func recvEnvelope(t *testing.T, c *websocket.Conn) *envelope.Envelope {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	e, err := envelope.Unmarshal(data)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestPairingHandshakeAndRouting(t *testing.T) {
	ts, pm, _ := newTestServer(t)

	agent := dial(t, ts, "?role=agent&sid=S1")
	send(t, agent, pairMsg{Type: "register", Code: "ABCDEFG2", Commit: []byte{1, 2, 3}})

	app := dial(t, ts, "?role=app")
	send(t, app, pairMsg{Type: "claim", Code: "ABCDEFG2"})

	if m := recvPair(t, app); m.Type != "commit" || m.SID != "S1" || !bytes.Equal(m.Commit, []byte{1, 2, 3}) {
		t.Fatalf("bad commit: %+v", m)
	}

	send(t, app, pairMsg{Type: "responder", AppEphPub: []byte{4, 5}})
	if m := recvPair(t, agent); m.Type != "responder" || !bytes.Equal(m.AppEphPub, []byte{4, 5}) {
		t.Fatalf("agent missing responder: %+v", m)
	}

	send(t, agent, pairMsg{Type: "reveal", AgentEphPub: []byte{6, 7}, Salt: []byte{8}})
	if m := recvPair(t, app); m.Type != "reveal" || !bytes.Equal(m.AgentEphPub, []byte{6, 7}) {
		t.Fatalf("app missing reveal: %+v", m)
	}

	send(t, app, pairMsg{Type: "confirm"})
	if m := recvPair(t, agent); m.Type != "confirm" {
		t.Fatalf("agent missing confirm: %+v", m)
	}

	send(t, agent, pairMsg{Type: "key", WrappedKey: []byte{9}})
	if m := recvPair(t, app); m.Type != "key" || !bytes.Equal(m.WrappedKey, []byte{9}) {
		t.Fatalf("app missing key: %+v", m)
	}

	// Session plane: app -> agent
	send(t, app, &envelope.Envelope{V: 1, SID: "S1", From: "app", Ch: "terminal", Seq: 0, Ts: 1, Encrypted: []byte{10}})
	if e := recvEnvelope(t, agent); e.From != "app" || e.SID != "S1" {
		t.Fatalf("agent missing app envelope: %+v", e)
	}

	// agent -> app with a notify hint -> push fired
	send(t, agent, &envelope.Envelope{V: 1, SID: "S1", From: "agent", Ch: "terminal", Seq: 0, Ts: 2, Notify: "permission_needed", Encrypted: []byte{11}})
	if e := recvEnvelope(t, app); e.From != "agent" {
		t.Fatalf("app missing agent envelope: %+v", e)
	}

	waitFor(t, func() bool { return len(pm.Calls()) == 1 })
	calls := pm.Calls()
	if calls[0].SessionID != "S1" || calls[0].Hint != push.PermissionNeeded {
		t.Fatalf("unexpected push: %+v", calls[0])
	}
}

func TestPushTokenRegistration(t *testing.T) {
	ts, _, st := newTestServer(t)

	agent := dial(t, ts, "?role=agent&sid=S1")
	send(t, agent, pairMsg{Type: "register", Code: "ABCDEFG2", Commit: []byte{1}})

	app := dial(t, ts, "?role=app")
	send(t, app, pairMsg{Type: "claim", Code: "ABCDEFG2"})
	if m := recvPair(t, app); m.Type != "commit" { // app conn now bound to S1
		t.Fatalf("expected commit, got %+v", m)
	}

	send(t, app, pairMsg{Type: "push", Subscription: `{"endpoint":"https://push.example/abc"}`})
	waitFor(t, func() bool {
		s, err := st.Get("S1")
		return err == nil && s.PushSubscription == `{"endpoint":"https://push.example/abc"}`
	})
}

func TestClaimUnknownCodeReturnsError(t *testing.T) {
	ts, _, _ := newTestServer(t)
	app := dial(t, ts, "?role=app")
	send(t, app, pairMsg{Type: "claim", Code: "NOPE9999"})
	if m := recvPair(t, app); m.Type != "error" || m.Error == "" {
		t.Fatalf("expected error reply, got %+v", m)
	}
}

func TestSessionsDoNotCross(t *testing.T) {
	ts, _, _ := newTestServer(t)
	agent1 := dial(t, ts, "?role=agent&sid=S1")
	app2 := dial(t, ts, "?role=app&sid=S2") // different session, reconnect path

	// agent1 -> (its app) should not reach app2 in S2.
	send(t, agent1, &envelope.Envelope{V: 1, SID: "S1", From: "agent", Ch: "terminal", Seq: 0, Ts: 1, Encrypted: []byte{1}})

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if _, _, err := app2.Read(ctx); err == nil {
		t.Fatal("app2 received a message meant for another session")
	}
}

func TestOriginAllowlist(t *testing.T) {
	st, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	// Configured with a full URL (scheme included) on purpose — it must be
	// normalized to a host pattern and still match the browser Origin.
	srv := New(hub.New(), pairing.New(), st, &push.Mock{}, Options{
		AllowedOrigins: []string{"https://good.example"},
	})
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { ts.Close(); _ = st.Close() })

	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=app"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	allowed, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://good.example"}},
	})
	if err != nil {
		t.Fatalf("allowed origin was rejected: %v", err)
	}
	_ = allowed.CloseNow()

	if c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.example"}},
	}); err == nil {
		_ = c.CloseNow()
		t.Fatal("disallowed origin was accepted")
	}
}

type statusResp struct {
	Sessions []struct {
		ID          string `json:"id"`
		AgentOnline bool   `json:"agentOnline"`
	} `json:"sessions"`
}

func getStatus(t *testing.T, ts *httptest.Server, ids string) statusResp {
	t.Helper()
	resp, err := http.Get(ts.URL + "/sessions/status?ids=" + ids)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	var out statusResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestSessionsStatusReflectsLiveAgents(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// No agents anywhere -> both offline.
	r := getStatus(t, ts, "S1,S2")
	if len(r.Sessions) != 2 {
		t.Fatalf("expected 2 entries, got %+v", r.Sessions)
	}
	for _, s := range r.Sessions {
		if s.AgentOnline {
			t.Fatalf("expected %s offline, got online", s.ID)
		}
	}

	// Bring an agent online for S1.
	agent := dial(t, ts, "?role=agent&sid=S1")
	defer agent.CloseNow()

	// Poll until the handler observes the registration (Register happens
	// after Accept on the server goroutine).
	waitFor(t, func() bool {
		r := getStatus(t, ts, "S1,S2")
		var s1, s2 bool
		for _, s := range r.Sessions {
			if s.ID == "S1" {
				s1 = s.AgentOnline
			}
			if s.ID == "S2" {
				s2 = s.AgentOnline
			}
		}
		return s1 && !s2
	})

	// Close the agent; status returns to offline.
	_ = agent.Close(websocket.StatusNormalClosure, "bye")
	waitFor(t, func() bool {
		r := getStatus(t, ts, "S1")
		return len(r.Sessions) == 1 && !r.Sessions[0].AgentOnline
	})
}

func TestSessionsStatusEdgeCases(t *testing.T) {
	ts, _, _ := newTestServer(t)

	// Empty ids -> empty list, 200 OK.
	r := getStatus(t, ts, "")
	if len(r.Sessions) != 0 {
		t.Fatalf("expected empty, got %+v", r.Sessions)
	}

	// Duplicate ids deduped; whitespace trimmed.
	r = getStatus(t, ts, "S1,%20S1%20,,S2")
	if len(r.Sessions) != 2 {
		t.Fatalf("expected dedup to 2 entries, got %+v", r.Sessions)
	}

	// Non-GET rejected with 405.
	resp, err := http.Post(ts.URL+"/sessions/status", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.StatusCode)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within timeout")
}
