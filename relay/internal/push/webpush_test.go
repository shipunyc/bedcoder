package push

import "testing"

func TestPushPayloadShape(t *testing.T) {
	p := pushPayload(PermissionNeeded)
	if p["hint"] != string(PermissionNeeded) {
		t.Fatalf("hint = %q", p["hint"])
	}
	if p["title"] == "" || p["body"] == "" {
		t.Fatalf("empty title/body: %#v", p)
	}
}

func TestNotificationTextPerHint(t *testing.T) {
	for _, hint := range []Hint{PermissionNeeded, ErrorOccurred, TaskCompleted, Hint("other")} {
		title, body := notificationText(hint)
		if title == "" || body == "" {
			t.Fatalf("empty text for hint %q", hint)
		}
	}
}
