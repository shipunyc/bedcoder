// Package push abstracts push notifications. The relay only ever passes a
// session ID and a notify hint — it never sees message content (DESIGN §5.1).
package push

import "sync"

// Hint mirrors the protocol NotifyHint values.
type Hint string

const (
	PermissionNeeded Hint = "permission_needed"
	TaskCompleted    Hint = "task_completed"
	ErrorOccurred    Hint = "error_occurred"
)

// Pusher delivers a notification for a session.
type Pusher interface {
	Push(sessionID string, hint Hint) error
}

// Noop drops all pushes (default until FCM is wired in Phase 1.1.7+).
type Noop struct{}

func (Noop) Push(string, Hint) error { return nil }

// Mock records pushes for tests. Safe for concurrent use.
type Mock struct {
	mu    sync.Mutex
	calls []Call
}

type Call struct {
	SessionID string
	Hint      Hint
}

func (m *Mock) Push(sessionID string, hint Hint) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, Call{SessionID: sessionID, Hint: hint})
	return nil
}

// Calls returns a snapshot of the recorded pushes.
func (m *Mock) Calls() []Call {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Call(nil), m.calls...)
}
