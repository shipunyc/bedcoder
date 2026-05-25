// Package envelope defines the outer wire frame the relay routes on.
// The relay is zero-knowledge: it parses only the outer fields and never
// touches Envelope.Encrypted (DESIGN §4.1 / §5.2). The msgpack keys mirror the
// canonical TypeScript definition in protocol/src/envelope.ts — keep them in sync.
package envelope

import "github.com/vmihailenco/msgpack/v5"

// Envelope is the shared outer frame. Encrypted holds the end-to-end-encrypted
// payload and stays opaque to the relay.
type Envelope struct {
	V         int    `msgpack:"v"`
	SID       string `msgpack:"sid"`
	From      string `msgpack:"from"`
	Ch        string `msgpack:"ch"`
	Seq       uint64 `msgpack:"seq"`
	Ts        int64  `msgpack:"ts"`
	Notify    string `msgpack:"notify,omitempty"`
	Encrypted []byte `msgpack:"encrypted"`
}

// Marshal encodes the envelope to MessagePack.
func (e *Envelope) Marshal() ([]byte, error) {
	return msgpack.Marshal(e)
}

// Unmarshal decodes a MessagePack envelope, leaving Encrypted opaque.
func Unmarshal(b []byte) (*Envelope, error) {
	var e Envelope
	if err := msgpack.Unmarshal(b, &e); err != nil {
		return nil, err
	}
	return &e, nil
}
