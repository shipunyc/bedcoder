// Package hub tracks live connections per session and routes raw frames between
// the agent and app of the same session. It never inspects the encrypted payload.
package hub

import (
	"context"
	"sync"
)

// Conn is one websocket connection. Send writes a raw binary frame; it must be
// safe for concurrent use (the server serializes writes internally).
type Conn struct {
	ID   string
	SID  string
	Role string // "agent" | "app"
	Code string // pairing code while pairing; empty afterwards
	Send func(ctx context.Context, data []byte) error
}

// Hub is the connection registry, keyed by session id then connection id.
type Hub struct {
	mu    sync.RWMutex
	conns map[string]map[string]*Conn
}

func New() *Hub {
	return &Hub{conns: map[string]map[string]*Conn{}}
}

func (h *Hub) Register(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[c.SID] == nil {
		h.conns[c.SID] = map[string]*Conn{}
	}
	h.conns[c.SID][c.ID] = c
}

func (h *Hub) Unregister(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m := h.conns[c.SID]; m != nil {
		delete(m, c.ID)
		if len(m) == 0 {
			delete(h.conns, c.SID)
		}
	}
}

// Peers returns the connections of the given role in a session.
func (h *Hub) Peers(sid, role string) []*Conn {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var out []*Conn
	for _, c := range h.conns[sid] {
		if c.Role == role {
			out = append(out, c)
		}
	}
	return out
}

// Route forwards raw to the opposite role in the sender's session and returns
// how many peers it was delivered to.
func (h *Hub) Route(ctx context.Context, sender *Conn, raw []byte) int {
	target := "app"
	if sender.Role == "app" {
		target = "agent"
	}
	peers := h.Peers(sender.SID, target)
	for _, p := range peers {
		_ = p.Send(ctx, raw)
	}
	return len(peers)
}
