package hub

import (
	"bytes"
	"context"
	"testing"

	"github.com/bedcoder/relay/internal/envelope"
)

func fakeConn(id, sid, role string, sink *[][]byte) *Conn {
	return &Conn{
		ID:   id,
		SID:  sid,
		Role: role,
		Send: func(_ context.Context, data []byte) error {
			*sink = append(*sink, append([]byte(nil), data...))
			return nil
		},
	}
}

func TestRouteAgentToApp(t *testing.T) {
	h := New()
	var appInbox [][]byte
	agent := fakeConn("a1", "S1", "agent", nil)
	app := fakeConn("p1", "S1", "app", &appInbox)
	h.Register(agent)
	h.Register(app)

	n := h.Route(context.Background(), agent, []byte("hello"))
	if n != 1 || len(appInbox) != 1 || string(appInbox[0]) != "hello" {
		t.Fatalf("agent->app routing failed: n=%d inbox=%v", n, appInbox)
	}
}

func TestRouteDoesNotCrossSessions(t *testing.T) {
	h := New()
	var otherInbox [][]byte
	agent := fakeConn("a1", "S1", "agent", nil)
	other := fakeConn("p2", "S2", "app", &otherInbox)
	h.Register(agent)
	h.Register(other)

	n := h.Route(context.Background(), agent, []byte("hi"))
	if n != 0 || len(otherInbox) != 0 {
		t.Fatalf("message leaked across sessions: n=%d inbox=%v", n, otherInbox)
	}
}

// The relay routes by sid only; the channel is irrelevant and the encrypted
// payload stays opaque. Phase 2 adds the tunnel/files channels — verify they
// pass through byte-for-byte, exactly like terminal (DESIGN §5.2; invariant 3).
func TestRoutePassesThroughAnyChannelUnchanged(t *testing.T) {
	for _, ch := range []string{"terminal", "tunnel", "files", "screen"} {
		t.Run(ch, func(t *testing.T) {
			h := New()
			var appInbox [][]byte
			agent := fakeConn("a1", "S1", "agent", nil)
			app := fakeConn("p1", "S1", "app", &appInbox)
			h.Register(agent)
			h.Register(app)

			env := &envelope.Envelope{
				V: 1, SID: "S1", From: "agent", Ch: ch, Seq: 7, Ts: 1700000000,
				Encrypted: []byte{0xDE, 0xAD, 0xBE, 0xEF}, // opaque to the relay
			}
			raw, err := env.Marshal()
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			n := h.Route(context.Background(), agent, raw)
			if n != 1 || len(appInbox) != 1 {
				t.Fatalf("%s: expected 1 delivery, got n=%d inbox=%d", ch, n, len(appInbox))
			}
			if !bytes.Equal(appInbox[0], raw) {
				t.Fatalf("%s: frame mutated in transit", ch)
			}
		})
	}
}

func TestUnregisterRemovesConn(t *testing.T) {
	h := New()
	app := fakeConn("p1", "S1", "app", nil)
	h.Register(app)
	h.Unregister(app)
	if got := h.Peers("S1", "app"); len(got) != 0 {
		t.Fatalf("expected no peers after unregister, got %d", len(got))
	}
}
