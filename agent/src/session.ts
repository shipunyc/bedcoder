import {
  encodeEnvelope,
  decodeEnvelope,
  encrypt,
  decrypt,
  type Channel,
  type Envelope,
  type NotifyHint,
} from '@bedcoder/protocol';

// Session holds the session key K and the outbound sequence counter. It turns
// channel payloads into encrypted, msgpack-framed envelopes and back (DESIGN §4).
export class Session {
  private seq = 0;

  constructor(
    readonly sid: string,
    private readonly key: Uint8Array,
  ) {}

  encode(channel: Channel, payload: unknown, notify?: NotifyHint): Uint8Array {
    const env: Envelope = {
      v: 1,
      sid: this.sid,
      from: 'agent',
      ch: channel,
      seq: this.seq++,
      ts: Math.floor(Date.now() / 1000), // Unix seconds (fits uint32; web msgpack can't do 64-bit ints)
      ...(notify ? { notify } : {}),
      encrypted: encrypt(payload, this.key),
    };
    return encodeEnvelope(env);
  }

  decode<T = unknown>(raw: Uint8Array): { env: Envelope; payload: T } {
    const env = decodeEnvelope(raw);
    return { env, payload: decrypt<T>(env.encrypted, this.key) };
  }
}
