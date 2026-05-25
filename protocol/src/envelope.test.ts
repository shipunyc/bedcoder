import { describe, it, expect } from 'vitest';
import { envelopeSchema, type Envelope, PROTOCOL_VERSION } from './envelope';
import { encodeEnvelope, decodeEnvelope } from './codec';

const base: Envelope = {
  v: PROTOCOL_VERSION,
  sid: 'abc123',
  from: 'agent',
  ch: 'terminal',
  seq: 0,
  ts: 1_700_000_000,
  encrypted: new Uint8Array([1, 2, 3, 4]),
};

describe('envelopeSchema', () => {
  it('accepts a valid envelope without notify', () => {
    expect(() => envelopeSchema.parse(base)).not.toThrow();
  });

  it('accepts a valid envelope with notify', () => {
    expect(() => envelopeSchema.parse({ ...base, notify: 'permission_needed' })).not.toThrow();
  });

  it('rejects a missing required field', () => {
    const { sid: _sid, ...noSid } = base;
    expect(() => envelopeSchema.parse(noSid)).toThrow();
  });

  it('rejects a wrong-typed field', () => {
    expect(() => envelopeSchema.parse({ ...base, seq: 'nope' })).toThrow();
  });

  it('rejects an unknown channel', () => {
    expect(() => envelopeSchema.parse({ ...base, ch: 'bogus' })).toThrow();
  });

  it('rejects a missing or mismatched version', () => {
    const { v: _v, ...noVersion } = base;
    expect(() => envelopeSchema.parse(noVersion)).toThrow();
    expect(() => envelopeSchema.parse({ ...base, v: 2 })).toThrow();
  });

  it('rejects an empty session id', () => {
    expect(() => envelopeSchema.parse({ ...base, sid: '' })).toThrow();
  });
});

describe('envelope msgpack round-trip', () => {
  it('round-trips without notify', () => {
    expect(decodeEnvelope(encodeEnvelope(base))).toEqual(base);
  });

  it('round-trips with notify', () => {
    const env: Envelope = { ...base, notify: 'task_completed' };
    expect(decodeEnvelope(encodeEnvelope(env))).toEqual(env);
  });

  it('preserves the encrypted bytes exactly', () => {
    const decoded = decodeEnvelope(encodeEnvelope(base));
    expect(decoded.encrypted).toBeInstanceOf(Uint8Array);
    expect(Array.from(decoded.encrypted)).toEqual([1, 2, 3, 4]);
  });
});
