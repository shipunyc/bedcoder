package store

import (
	"database/sql"
	"errors"
	"testing"
)

func TestUpsertAndGet(t *testing.T) {
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer s.Close()

	if err := s.Upsert("sess-1"); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	got, err := s.Get("sess-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.ID != "sess-1" || got.CreatedAt == 0 || got.LastActive == 0 {
		t.Fatalf("unexpected session: %+v", got)
	}
	if got.PushSubscription != "" {
		t.Fatalf("expected empty push subscription, got %q", got.PushSubscription)
	}
}

func TestSetPushSubscription(t *testing.T) {
	s, _ := Open(":memory:")
	defer s.Close()
	_ = s.Upsert("sess-1")
	if err := s.SetPushSubscription("sess-1", `{"endpoint":"x"}`); err != nil {
		t.Fatalf("set subscription: %v", err)
	}
	got, _ := s.Get("sess-1")
	if got.PushSubscription != `{"endpoint":"x"}` {
		t.Fatalf("push subscription = %q", got.PushSubscription)
	}
}

func TestGetMissingReturnsNoRows(t *testing.T) {
	s, _ := Open(":memory:")
	defer s.Close()
	_, err := s.Get("nope")
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("expected ErrNoRows, got %v", err)
	}
}

func TestUpsertIsIdempotent(t *testing.T) {
	s, _ := Open(":memory:")
	defer s.Close()
	_ = s.Upsert("sess-1")
	first, _ := s.Get("sess-1")
	_ = s.Upsert("sess-1")
	second, _ := s.Get("sess-1")
	if first.CreatedAt != second.CreatedAt {
		t.Fatal("created_at should not change on re-upsert")
	}
}
