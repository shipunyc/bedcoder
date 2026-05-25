// Package store persists anonymous session metadata in embedded SQLite.
// It stores no message content and no keys — only a sessions table (DESIGN §5.3).
package store

import (
	"database/sql"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db  *sql.DB
	now func() time.Time
}

type Session struct {
	ID               string
	CreatedAt        int64
	LastActive       int64
	PushSubscription string // Web Push subscription JSON (endpoint + keys)
}

// Open opens (or creates) the SQLite database at dsn, e.g. "bedcoder.db" or
// ":memory:" for tests, and ensures the schema exists.
func Open(dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		session_id        TEXT PRIMARY KEY,
		created_at        INTEGER NOT NULL,
		last_active       INTEGER NOT NULL,
		push_subscription TEXT
	)`); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Upsert records a session (or refreshes last_active if it already exists).
func (s *Store) Upsert(id string) error {
	now := s.now().UnixMilli()
	_, err := s.db.Exec(`INSERT INTO sessions (session_id, created_at, last_active)
		VALUES (?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET last_active = excluded.last_active`,
		id, now, now)
	return err
}

// Touch refreshes last_active for an existing session.
func (s *Store) Touch(id string) error {
	_, err := s.db.Exec(`UPDATE sessions SET last_active = ? WHERE session_id = ?`,
		s.now().UnixMilli(), id)
	return err
}

// SetPushSubscription binds a Web Push subscription (JSON) to a session.
func (s *Store) SetPushSubscription(id, subscription string) error {
	_, err := s.db.Exec(`UPDATE sessions SET push_subscription = ? WHERE session_id = ?`, subscription, id)
	return err
}

// Get returns the session, or sql.ErrNoRows if it does not exist.
func (s *Store) Get(id string) (*Session, error) {
	row := s.db.QueryRow(
		`SELECT session_id, created_at, last_active, COALESCE(push_subscription, '')
		 FROM sessions WHERE session_id = ?`, id)
	var sess Session
	if err := row.Scan(&sess.ID, &sess.CreatedAt, &sess.LastActive, &sess.PushSubscription); err != nil {
		return nil, err
	}
	return &sess, nil
}
