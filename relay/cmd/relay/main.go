// Command relay is the bedcoder zero-knowledge WebSocket relay (DESIGN §5).
package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/bedcoder/relay/internal/hub"
	"github.com/bedcoder/relay/internal/pairing"
	"github.com/bedcoder/relay/internal/push"
	"github.com/bedcoder/relay/internal/server"
	"github.com/bedcoder/relay/internal/store"
	"github.com/bedcoder/relay/internal/version"
)

func main() {
	addr := env("BEDCODER_ADDR", ":8787")
	dbPath := env("BEDCODER_DB", "bedcoder.db")
	origins := splitNonEmpty(os.Getenv("BEDCODER_ALLOWED_ORIGINS"))

	st, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	rv := pairing.New()

	// Push: standards-based Web Push (VAPID) only when a keypair is configured;
	// otherwise a no-op. Generate a keypair once and set BEDCODER_VAPID_PUBLIC /
	// BEDCODER_VAPID_PRIVATE (+ optional BEDCODER_VAPID_SUBJECT). No Firebase.
	var pusher push.Pusher = push.Noop{}
	if pub, priv := os.Getenv("BEDCODER_VAPID_PUBLIC"), os.Getenv("BEDCODER_VAPID_PRIVATE"); pub != "" && priv != "" {
		subject := env("BEDCODER_VAPID_SUBJECT", "mailto:admin@bedcoder.org")
		pusher = push.NewWebPushPusher(pub, priv, subject, func(sid string) (string, bool) {
			s, err := st.Get(sid)
			if err != nil || s.PushSubscription == "" {
				return "", false
			}
			return s.PushSubscription, true
		})
		log.Printf("Web Push (VAPID) enabled")
	}

	srv := server.New(hub.New(), rv, st, pusher, server.Options{AllowedOrigins: origins})

	// Periodically drop expired, never-claimed pairing slots.
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			rv.Sweep()
		}
	}()

	log.Printf("bedcoder-relay %s listening on %s (origins=%v)", version.Version, addr, origins)
	hs := &http.Server{Addr: addr, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	if err := hs.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitNonEmpty(s string) []string {
	var out []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}
