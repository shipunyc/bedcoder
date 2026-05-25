import { describe, it, expect } from 'vitest';
import { generateKey, decodeEnvelope } from '@bedcoder/protocol';
import { Session } from './session';

describe('Session', () => {
  it('encodes an encrypted envelope and decodes it back', () => {
    const key = generateKey();
    const s = new Session('S1', key);
    const raw = s.encode('terminal', { type: 'content', role: 'assistant', text: 'hi' });
    const { env, payload } = s.decode<{ type: string; text: string }>(raw);
    expect(env.sid).toBe('S1');
    expect(env.from).toBe('agent');
    expect(env.ch).toBe('terminal');
    expect(payload).toEqual({ type: 'content', role: 'assistant', text: 'hi' });
  });

  it('increments the sequence number', () => {
    const s = new Session('S1', generateKey());
    const a = decodeEnvelope(s.encode('terminal', {}));
    const b = decodeEnvelope(s.encode('terminal', {}));
    expect(b.seq).toBe(a.seq + 1);
  });

  it('uses Unix seconds for ts (fits uint32 for web msgpack)', () => {
    const env = decodeEnvelope(new Session('S1', generateKey()).encode('terminal', {}));
    expect(env.ts).toBeLessThan(2 ** 32);
    expect(env.ts).toBeGreaterThan(1_000_000_000);
  });

  it('includes notify when provided', () => {
    const s = new Session('S1', generateKey());
    const env = decodeEnvelope(s.encode('terminal', {}, 'permission_needed'));
    expect(env.notify).toBe('permission_needed');
  });

  it('cannot decode with a different key', () => {
    const s = new Session('S1', generateKey());
    const raw = s.encode('terminal', { x: 1 });
    expect(() => new Session('S1', generateKey()).decode(raw)).toThrow();
  });
});
