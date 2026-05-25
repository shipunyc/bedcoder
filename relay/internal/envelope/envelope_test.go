package envelope

import (
	"bytes"
	"reflect"
	"testing"
)

func sample() *Envelope {
	return &Envelope{
		V:         1,
		SID:       "abc123",
		From:      "agent",
		Ch:        "terminal",
		Seq:       0,
		Ts:        1_700_000_000,
		Encrypted: []byte{1, 2, 3, 4},
	}
}

func TestRoundTrip(t *testing.T) {
	orig := sample()
	b, err := orig.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got, err := Unmarshal(b)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(orig, got) {
		t.Fatalf("round-trip mismatch:\n want %+v\n got  %+v", orig, got)
	}
}

func TestReMarshalIsByteStable(t *testing.T) {
	b1, err := sample().Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	e, err := Unmarshal(b1)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	b2, err := e.Marshal()
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	if !bytes.Equal(b1, b2) {
		t.Fatalf("re-marshal not byte-stable")
	}
}

func TestNotifyOmittedWhenEmpty(t *testing.T) {
	without, _ := sample().Marshal()
	with := sample()
	with.Notify = "permission_needed"
	withBytes, _ := with.Marshal()
	if len(withBytes) <= len(without) {
		t.Fatalf("expected notify to add bytes to the map")
	}
	got, err := Unmarshal(withBytes)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Notify != "permission_needed" {
		t.Fatalf("notify lost in round-trip: %q", got.Notify)
	}
}

func TestEncryptedStaysOpaque(t *testing.T) {
	b, _ := sample().Marshal()
	got, err := Unmarshal(b)
	if err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !bytes.Equal(got.Encrypted, []byte{1, 2, 3, 4}) {
		t.Fatalf("encrypted bytes changed: %v", got.Encrypted)
	}
}

func TestUnmarshalRejectsGarbage(t *testing.T) {
	if _, err := Unmarshal([]byte{0xc1}); err == nil {
		t.Fatal("expected error decoding garbage bytes")
	}
}
