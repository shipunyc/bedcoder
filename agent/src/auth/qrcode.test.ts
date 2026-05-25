import { describe, it, expect } from 'vitest';
import { encodeQrPayload, parseQrPayload } from './qrcode';

describe('QR payload', () => {
  it('round-trips relay/sid/key', () => {
    const key = new Uint8Array([1, 2, 3, 250, 0, 255]);
    const text = encodeQrPayload({ relayUrl: 'wss://relay.example', sid: 'S1', key });
    const parsed = parseQrPayload(text);
    expect(parsed.relayUrl).toBe('wss://relay.example');
    expect(parsed.sid).toBe('S1');
    expect([...parsed.key]).toEqual([1, 2, 3, 250, 0, 255]);
  });

  it('rejects a payload missing fields', () => {
    expect(() => parseQrPayload('bedcoder://pair?relay=x')).toThrow();
  });
});
