// Package pairing implements the relay's pairing rendezvous: short-lived slots
// keyed by an 8-char pairing code that match an agent with an app, then relay
// the commitment/SAS handshake between them (DESIGN §4.8 / §1.1.3). The relay
// only shuttles opaque bytes; it never learns the session key or SAS.
package pairing

import (
	"errors"
	"sync"
	"time"

	"github.com/bedcoder/relay/internal/hub"
)

const (
	SlotTTL         = 5 * time.Minute
	RateWindow      = time.Minute
	ClaimsPerWindow = 30
)

var (
	ErrNoSlot         = errors.New("no such pairing code")
	ErrExpired        = errors.New("pairing code expired")
	ErrAlreadyClaimed = errors.New("pairing code already claimed")
	ErrRateLimited    = errors.New("too many pairing attempts")
)

// Slot holds the state for one in-progress pairing.
type Slot struct {
	Code      string
	SID       string
	Commit    []byte
	Agent     *hub.Conn
	App       *hub.Conn
	ExpiresAt time.Time
}

type Rendezvous struct {
	mu          sync.Mutex
	slots       map[string]*Slot
	now         func() time.Time
	windowStart time.Time
	windowCount int
}

func New() *Rendezvous {
	return &Rendezvous{slots: map[string]*Slot{}, now: time.Now}
}

// Register creates (or replaces) a slot for an agent that is offering a code.
func (r *Rendezvous) Register(code, sid string, commit []byte, agent *hub.Conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.slots[code] = &Slot{
		Code:      code,
		SID:       sid,
		Commit:    commit,
		Agent:     agent,
		ExpiresAt: r.now().Add(SlotTTL),
	}
}

// Claim binds an app to the slot for code. It enforces a global rate limit, slot
// expiry, and single-claim (first app wins).
func (r *Rendezvous) Claim(code string, app *hub.Conn) (*Slot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.allowClaimLocked() {
		return nil, ErrRateLimited
	}
	s := r.slots[code]
	if s == nil {
		return nil, ErrNoSlot
	}
	if r.now().After(s.ExpiresAt) {
		delete(r.slots, code)
		return nil, ErrExpired
	}
	if s.App != nil {
		return nil, ErrAlreadyClaimed
	}
	s.App = app
	return s, nil
}

func (r *Rendezvous) Get(code string) *Slot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.slots[code]
}

func (r *Rendezvous) Remove(code string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.slots, code)
}

// Sweep drops expired slots; call periodically.
func (r *Rendezvous) Sweep() {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	for code, s := range r.slots {
		if now.After(s.ExpiresAt) {
			delete(r.slots, code)
		}
	}
}

func (r *Rendezvous) allowClaimLocked() bool {
	t := r.now()
	if t.Sub(r.windowStart) >= RateWindow {
		r.windowStart = t
		r.windowCount = 0
	}
	r.windowCount++
	return r.windowCount <= ClaimsPerWindow
}
