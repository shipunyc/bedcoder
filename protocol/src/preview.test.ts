import { describe, it, expect } from 'vitest';
import { encodePreview, decodePreview, type PreviewFrame } from './preview';
import { peekMessageKind } from './codec';
import { encodeEnvelope, encodePairing } from './codec';

describe('preview frames', () => {
  const cases: PreviewFrame[] = [
    { pv: 1, op: 'register', token: 'tok-abc' },
    { pv: 1, op: 'req', id: 'r1', port: 3000, method: 'GET', path: '/index', headers: { Accept: 'text/html' } },
    { pv: 1, op: 'res', id: 'r1', status: 200, headers: { 'Content-Type': 'text/html' }, bodyB64: 'aGk=' },
    { pv: 1, op: 'res', id: 'r2', error: 'connection_refused' },
  ];

  it('round-trips each frame', () => {
    for (const f of cases) {
      expect(decodePreview(encodePreview(f))).toEqual(f);
    }
  });

  it('rejects an unknown op', () => {
    expect(() => decodePreview(encodePreview({ pv: 1, op: 'bogus' } as unknown as PreviewFrame))).toThrow();
  });

  it('peekMessageKind classifies preview, pairing, and envelope distinctly', () => {
    expect(peekMessageKind(encodePreview({ pv: 1, op: 'register', token: 't' }))).toBe('preview');
    expect(peekMessageKind(encodePairing({ type: 'claim', code: 'ABCD2345' }))).toBe('pairing');
    expect(
      peekMessageKind(
        encodeEnvelope({ v: 1, sid: 's', from: 'agent', ch: 'tunnel', seq: 0, ts: 0, encrypted: new Uint8Array([1]) }),
      ),
    ).toBe('envelope');
  });
});
