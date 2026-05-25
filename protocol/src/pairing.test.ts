import { describe, it, expect } from 'vitest';
import { pairingMessageSchema, type PairingMessage } from './pairing';
import { encodePairing, decodePairing } from './codec';

const b = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i + 1));

const messages: PairingMessage[] = [
  { type: 'register', code: 'K7P29XQM', commit: b(32) },
  { type: 'claim', code: 'K7P29XQM' },
  { type: 'commit', commit: b(32), sid: 'sess-1' },
  { type: 'responder', appEphPub: b(32) },
  { type: 'reveal', agentEphPub: b(32), salt: b(16) },
  { type: 'confirm' },
  { type: 'key', wrappedKey: b(48) },
  { type: 'error', error: 'no such pairing code' },
  { type: 'push', subscription: '{"endpoint":"https://push.example/abc","keys":{}}' },
];

describe('pairingMessageSchema', () => {
  it.each(messages)('accepts %o', (msg) => {
    expect(() => pairingMessageSchema.parse(msg)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => pairingMessageSchema.parse({ type: 'nope' })).toThrow();
  });

  it('rejects a missing field (register without commit)', () => {
    expect(() => pairingMessageSchema.parse({ type: 'register', code: 'K7P29XQM' })).toThrow();
  });

  it('rejects a wrong-typed binary field', () => {
    expect(() => pairingMessageSchema.parse({ type: 'commit', commit: 'not-bytes' })).toThrow();
  });
});

describe('pairing msgpack round-trip', () => {
  it.each(messages)('round-trips %o preserving binary fields', (msg) => {
    expect(decodePairing(encodePairing(msg))).toEqual(msg);
  });
});
