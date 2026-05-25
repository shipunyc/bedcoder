import { describe, it, expect } from 'vitest';
import { peekMessageKind, encodeEnvelope } from './codec';
import type { Envelope } from './envelope';
import { encodePairing } from './codec';

describe('peekMessageKind', () => {
  it('classifies envelopes and pairing messages', () => {
    const env: Envelope = {
      v: 1,
      sid: 's',
      from: 'agent',
      ch: 'terminal',
      seq: 0,
      ts: 0,
      encrypted: new Uint8Array([1]),
    };
    expect(peekMessageKind(encodeEnvelope(env))).toBe('envelope');
    expect(peekMessageKind(encodePairing({ type: 'confirm' }))).toBe('pairing');
  });
});
