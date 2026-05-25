package envelope

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

// Reads the canonical TypeScript-generated vectors (protocol/fixtures/vectors.json)
// and checks the Go relay decodes the same envelope wire bytes (1.0.6 interop).
type fixtureEnvelope struct {
	V            int     `json:"v"`
	SID          string  `json:"sid"`
	From         string  `json:"from"`
	Ch           string  `json:"ch"`
	Seq          uint64  `json:"seq"`
	Ts           int64   `json:"ts"`
	Notify       *string `json:"notify"`
	EncryptedHex string  `json:"encryptedHex"`
	MsgpackHex   string  `json:"msgpackHex"`
}

type fixtures struct {
	Envelopes []fixtureEnvelope `json:"envelopes"`
}

func TestInteropEnvelopesFromTS(t *testing.T) {
	raw, err := os.ReadFile("../../../protocol/fixtures/vectors.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var fx fixtures
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(fx.Envelopes) == 0 {
		t.Fatal("no envelope fixtures")
	}

	for _, e := range fx.Envelopes {
		raw, err := hex.DecodeString(e.MsgpackHex)
		if err != nil {
			t.Fatalf("hex %s: %v", e.SID, err)
		}
		got, err := Unmarshal(raw)
		if err != nil {
			t.Fatalf("decode %s: %v", e.SID, err)
		}
		if got.V != e.V || got.SID != e.SID || got.From != e.From || got.Ch != e.Ch || got.Seq != e.Seq || got.Ts != e.Ts {
			t.Fatalf("field mismatch for %s: %+v", e.SID, got)
		}
		wantNotify := ""
		if e.Notify != nil {
			wantNotify = *e.Notify
		}
		if got.Notify != wantNotify {
			t.Fatalf("notify mismatch %s: %q vs %q", e.SID, got.Notify, wantNotify)
		}
		wantEnc, _ := hex.DecodeString(e.EncryptedHex)
		if !bytes.Equal(got.Encrypted, wantEnc) {
			t.Fatalf("encrypted mismatch for %s", e.SID)
		}
	}
}
