package server

import (
	"context"
	"os"
	"strconv"
	"sync"

	"golang.org/x/time/rate"
)

// Per-session rate limiting for preview traffic. The relay's preview path is a
// deliberate zero-knowledge carve-out and a candidate for abuse — one user
// pulling a multi-MB asset can saturate the free public relay. We give each
// session a token bucket (bandwidth) and a semaphore (concurrent in-flight
// requests), keyed by sid (the same key previewState.tokens uses).

const (
	// Conservative defaults — protect the free public relay from a single user.
	// Operators self-hosting can raise via env. 50 KB/s sustained covers a small
	// page plus a few assets; 256 KB burst lets the first paint be snappy.
	defaultPreviewBPS         = 50 * 1024  // bytes / second
	defaultPreviewBurst       = 256 * 1024 // bytes
	defaultPreviewConcurrency = 16         // in-flight requests per session
)

// previewLimits is the resolved configuration. All fields are positive.
type previewLimits struct {
	bps         int
	burst       int
	concurrency int
}

// loadPreviewLimits returns the defaults overridden by BEDCODER_PREVIEW_BPS /
// BEDCODER_PREVIEW_BURST / BEDCODER_PREVIEW_CONCURRENCY (positive integers).
func loadPreviewLimits() previewLimits {
	return previewLimits{
		bps:         envInt("BEDCODER_PREVIEW_BPS", defaultPreviewBPS),
		burst:       envInt("BEDCODER_PREVIEW_BURST", defaultPreviewBurst),
		concurrency: envInt("BEDCODER_PREVIEW_CONCURRENCY", defaultPreviewConcurrency),
	}
}

func envInt(name string, def int) int {
	v := os.Getenv(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// previewSessionLimiter pairs one bandwidth bucket and one concurrency
// semaphore for a single session. Created lazily on first use, dropped when the
// session disconnects.
type previewSessionLimiter struct {
	bw  *rate.Limiter
	sem chan struct{}
}

// acquire takes a concurrency slot, blocking until one is free or ctx is done.
// Returns a release function to defer; the function is safe to call once.
func (l *previewSessionLimiter) acquire(ctx context.Context) (func(), error) {
	select {
	case l.sem <- struct{}{}:
		return func() { <-l.sem }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// previewLimiterRegistry hands out per-sid limiters, lazily creating them on
// first use and dropping them when a session disconnects.
type previewLimiterRegistry struct {
	mu     sync.Mutex
	limits previewLimits
	bySID  map[string]*previewSessionLimiter
}

func newPreviewLimiterRegistry(limits previewLimits) *previewLimiterRegistry {
	return &previewLimiterRegistry{
		limits: limits,
		bySID:  map[string]*previewSessionLimiter{},
	}
}

// forSID returns the limiter for sid, creating it on first call.
func (r *previewLimiterRegistry) forSID(sid string) *previewSessionLimiter {
	r.mu.Lock()
	defer r.mu.Unlock()
	if l, ok := r.bySID[sid]; ok {
		return l
	}
	l := &previewSessionLimiter{
		bw:  rate.NewLimiter(rate.Limit(r.limits.bps), r.limits.burst),
		sem: make(chan struct{}, r.limits.concurrency),
	}
	r.bySID[sid] = l
	return l
}

// drop releases the limiter for sid (call when the agent disconnects).
func (r *previewLimiterRegistry) drop(sid string) {
	r.mu.Lock()
	delete(r.bySID, sid)
	r.mu.Unlock()
}
