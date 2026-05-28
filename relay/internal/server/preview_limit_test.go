package server

import (
	"context"
	"testing"
	"time"
)

func TestLoadPreviewLimitsDefaults(t *testing.T) {
	t.Setenv("BEDCODER_PREVIEW_BPS", "")
	t.Setenv("BEDCODER_PREVIEW_BURST", "")
	t.Setenv("BEDCODER_PREVIEW_CONCURRENCY", "")
	l := loadPreviewLimits()
	if l.bps != defaultPreviewBPS || l.burst != defaultPreviewBurst || l.concurrency != defaultPreviewConcurrency {
		t.Errorf("defaults: got %+v", l)
	}
}

func TestLoadPreviewLimitsEnvOverride(t *testing.T) {
	t.Setenv("BEDCODER_PREVIEW_BPS", "200000")
	t.Setenv("BEDCODER_PREVIEW_BURST", "500000")
	t.Setenv("BEDCODER_PREVIEW_CONCURRENCY", "32")
	l := loadPreviewLimits()
	if l.bps != 200000 || l.burst != 500000 || l.concurrency != 32 {
		t.Errorf("overrides: got %+v", l)
	}
}

func TestLoadPreviewLimitsRejectsBadValues(t *testing.T) {
	// Non-numeric / non-positive values fall back to defaults.
	t.Setenv("BEDCODER_PREVIEW_BPS", "garbage")
	t.Setenv("BEDCODER_PREVIEW_BURST", "0")
	t.Setenv("BEDCODER_PREVIEW_CONCURRENCY", "-1")
	l := loadPreviewLimits()
	if l.bps != defaultPreviewBPS || l.burst != defaultPreviewBurst || l.concurrency != defaultPreviewConcurrency {
		t.Errorf("bad-input fallback failed: %+v", l)
	}
}

func TestRegistryReusesAndDrops(t *testing.T) {
	r := newPreviewLimiterRegistry(previewLimits{bps: 1000, burst: 1000, concurrency: 4})
	a := r.forSID("S1")
	b := r.forSID("S1")
	if a != b {
		t.Errorf("forSID should return the same limiter for the same sid")
	}
	c := r.forSID("S2")
	if a == c {
		t.Errorf("different sids should get distinct limiters")
	}
	r.drop("S1")
	d := r.forSID("S1")
	if d == a {
		t.Errorf("after drop, a fresh limiter should be created")
	}
}

func TestConcurrencyAcquireBlocksAtCap(t *testing.T) {
	l := &previewSessionLimiter{sem: make(chan struct{}, 2)}
	ctx := context.Background()
	rel1, err := l.acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rel2, err := l.acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Third acquire should block until one releases.
	ctxQuick, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	if _, err := l.acquire(ctxQuick); err == nil {
		t.Errorf("expected blocked acquire to time out at the concurrency cap")
	}

	rel1()
	// Now a fresh acquire succeeds.
	rel3, err := l.acquire(ctx)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	rel2()
	rel3()
}
