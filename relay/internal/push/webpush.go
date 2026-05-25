package push

import (
	"encoding/json"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// SubscriptionResolver returns the Web Push subscription JSON registered for a
// session, if any. Keeps this package decoupled from the store.
type SubscriptionResolver func(sessionID string) (string, bool)

// WebPushPusher sends standards-based Web Push notifications (VAPID, RFC 8030/
// 8292) directly to the browser's push service — no Firebase. It is only
// constructed when the relay is configured with a VAPID keypair; otherwise the
// relay uses Noop. Real delivery is verified manually (needs a browser
// subscription); the message shaping is unit-tested.
type WebPushPusher struct {
	publicKey  string
	privateKey string
	subscriber string // mailto: or https: contact, per VAPID
	resolve    SubscriptionResolver
}

func NewWebPushPusher(publicKey, privateKey, subscriber string, resolve SubscriptionResolver) *WebPushPusher {
	return &WebPushPusher{
		publicKey:  publicKey,
		privateKey: privateKey,
		subscriber: subscriber,
		resolve:    resolve,
	}
}

func (p *WebPushPusher) Push(sessionID string, hint Hint) error {
	raw, ok := p.resolve(sessionID)
	if !ok || raw == "" {
		return nil // nobody subscribed
	}
	var sub webpush.Subscription
	if err := json.Unmarshal([]byte(raw), &sub); err != nil {
		return err
	}
	payload, err := json.Marshal(pushPayload(hint))
	if err != nil {
		return err
	}
	resp, err := webpush.SendNotification(payload, &sub, &webpush.Options{
		Subscriber:      p.subscriber,
		VAPIDPublicKey:  p.publicKey,
		VAPIDPrivateKey: p.privateKey,
		TTL:             60,
	})
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// pushPayload is the JSON the service worker reads in its `push` handler.
func pushPayload(hint Hint) map[string]string {
	title, body := notificationText(hint)
	return map[string]string{"title": title, "body": body, "hint": string(hint)}
}

func notificationText(hint Hint) (title, body string) {
	switch hint {
	case PermissionNeeded:
		return "Bedcoder", "Claude needs your permission"
	case ErrorOccurred:
		return "Bedcoder", "A task hit an error"
	case TaskCompleted:
		return "Bedcoder", "Task completed"
	default:
		return "Bedcoder", "Update"
	}
}
