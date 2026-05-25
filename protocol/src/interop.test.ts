import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeEnvelope, decrypt, unwrapKey, deriveSAS, verifyCommit } from './index';

// Self-check that the committed cross-language vectors round-trip in TS too.
// The real interop guarantee is the Go and Dart suites reading the same file.
const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/vectors.json', import.meta.url), 'utf8'),
);

const bytes = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

describe('interop fixtures (TS)', () => {
  it('decodes each envelope', () => {
    for (const e of vectors.envelopes) {
      const env = decodeEnvelope(bytes(e.msgpackHex));
      expect(env.v).toBe(1);
      expect(env.sid).toBe(e.sid);
      expect(env.from).toBe(e.from);
      expect(env.ch).toBe(e.ch);
      expect(env.seq).toBe(e.seq);
      expect(env.ts).toBe(e.ts);
      expect(env.notify ?? null).toBe(e.notify);
      expect([...env.encrypted]).toEqual([...bytes(e.encryptedHex)]);
    }
  });

  it('decrypts each symmetric case', () => {
    const key = bytes(vectors.symmetric.keyHex);
    for (const c of vectors.symmetric.cases) {
      expect(decrypt(bytes(c.sealedHex), key)).toEqual(c.plaintext);
    }
  });

  it('unwraps the session key', () => {
    const b = vectors.box;
    const k = unwrapKey(bytes(b.wrappedHex), bytes(b.agentPubHex), bytes(b.appSecHex));
    expect([...k]).toEqual([...bytes(b.kHex)]);
  });

  it('matches SAS and commit', () => {
    expect(deriveSAS(bytes(vectors.sas.agentPubHex), bytes(vectors.sas.appPubHex))).toBe(
      vectors.sas.sas,
    );
    expect(
      verifyCommit(bytes(vectors.commit.commitHex), bytes(vectors.commit.pubHex), bytes(vectors.commit.saltHex)),
    ).toBe(true);
  });
});
