package pairing

import (
	"errors"
	"testing"
	"time"

	"github.com/bedcoder/relay/internal/hub"
)

func newWithClock(t0 time.Time) (*Rendezvous, *time.Time) {
	now := t0
	r := New()
	r.now = func() time.Time { return now }
	return r, &now
}

func TestRegisterAndClaim(t *testing.T) {
	r, _ := newWithClock(time.Unix(0, 0))
	agent := &hub.Conn{ID: "a", SID: "S1", Role: "agent"}
	r.Register("CODE1234", "S1", []byte{1, 2, 3}, agent)

	app := &hub.Conn{ID: "p", Role: "app"}
	slot, err := r.Claim("CODE1234", app)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if slot.SID != "S1" || slot.Agent != agent || slot.App != app {
		t.Fatalf("unexpected slot: %+v", slot)
	}
}

func TestClaimUnknownCode(t *testing.T) {
	r, _ := newWithClock(time.Unix(0, 0))
	if _, err := r.Claim("NOPE", &hub.Conn{}); !errors.Is(err, ErrNoSlot) {
		t.Fatalf("expected ErrNoSlot, got %v", err)
	}
}

func TestClaimExpired(t *testing.T) {
	r, now := newWithClock(time.Unix(0, 0))
	r.Register("CODE1234", "S1", nil, &hub.Conn{})
	*now = now.Add(SlotTTL + time.Second)
	if _, err := r.Claim("CODE1234", &hub.Conn{}); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

func TestSingleClaim(t *testing.T) {
	r, _ := newWithClock(time.Unix(0, 0))
	r.Register("CODE1234", "S1", nil, &hub.Conn{})
	if _, err := r.Claim("CODE1234", &hub.Conn{ID: "first"}); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if _, err := r.Claim("CODE1234", &hub.Conn{ID: "second"}); !errors.Is(err, ErrAlreadyClaimed) {
		t.Fatalf("expected ErrAlreadyClaimed, got %v", err)
	}
}

func TestRateLimit(t *testing.T) {
	r, _ := newWithClock(time.Unix(0, 0))
	var lastErr error
	for i := 0; i < ClaimsPerWindow+5; i++ {
		_, lastErr = r.Claim("NOPE", &hub.Conn{})
	}
	if !errors.Is(lastErr, ErrRateLimited) {
		t.Fatalf("expected ErrRateLimited after burst, got %v", lastErr)
	}
}

func TestSweepRemovesExpired(t *testing.T) {
	r, now := newWithClock(time.Unix(0, 0))
	r.Register("CODE1234", "S1", nil, &hub.Conn{})
	*now = now.Add(SlotTTL + time.Second)
	r.Sweep()
	if r.Get("CODE1234") != nil {
		t.Fatal("expected expired slot to be swept")
	}
}
