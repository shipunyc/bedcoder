import { describe, it, expect } from 'vitest';
import {
  generateKey,
  encrypt,
  decrypt,
  genEphemeralKeyPair,
  wrapKey,
  unwrapKey,
  genPairCode,
  genSalt,
  commit,
  verifyCommit,
  deriveSAS,
  PAIR_ALPHABET,
  PAIR_CODE_LEN,
} from './crypto';

const NONCE_LEN = 24;
const MAC_LEN = 16;

describe('symmetric encrypt/decrypt', () => {
  it('round-trips an arbitrary object', () => {
    const key = generateKey();
    const obj = { type: 'message', text: 'héllo 世界', n: 42 };
    expect(decrypt(encrypt(obj, key), key)).toEqual(obj);
  });

  it('fails with the wrong key', () => {
    const ct = encrypt({ a: 1 }, generateKey());
    expect(() => decrypt(ct, generateKey())).toThrow();
  });

  it('fails on a tampered ciphertext', () => {
    const key = generateKey();
    const ct = encrypt({ a: 1 }, key);
    const bad = ct.slice();
    const i = NONCE_LEN + 1;
    bad[i] = (bad[i] ?? 0) ^ 0x01;
    expect(() => decrypt(bad, key)).toThrow();
  });

  it('uses a fresh random nonce each time', () => {
    const key = generateKey();
    const a = encrypt('same', key);
    const b = encrypt('same', key);
    expect(Array.from(a.subarray(0, NONCE_LEN))).not.toEqual(Array.from(b.subarray(0, NONCE_LEN)));
  });

  it('has the [nonce:24][ciphertext+MAC:16] layout', () => {
    const key = generateKey();
    const payload = 'hello';
    const plaintextLen = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(encrypt(payload, key).length).toBe(NONCE_LEN + plaintextLen + MAC_LEN);
  });
});

describe('crypto_box key wrapping', () => {
  it('agent wraps K to the app pubkey; app unwraps with its own key', () => {
    const agent = genEphemeralKeyPair();
    const app = genEphemeralKeyPair();
    const k = generateKey();
    const wrapped = wrapKey(k, app.publicKey, agent.secretKey);
    expect(unwrapKey(wrapped, agent.publicKey, app.secretKey)).toEqual(k);
  });

  it('fails when a different key tries to unwrap', () => {
    const agent = genEphemeralKeyPair();
    const app = genEphemeralKeyPair();
    const mallory = genEphemeralKeyPair();
    const wrapped = wrapKey(generateKey(), app.publicKey, agent.secretKey);
    expect(() => unwrapKey(wrapped, agent.publicKey, mallory.secretKey)).toThrow();
  });
});

describe('genPairCode', () => {
  it('is 8 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = genPairCode();
      expect(code).toHaveLength(PAIR_CODE_LEN);
      expect([...code].every((c) => PAIR_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('never contains the confusing characters 0 O 1 I L U', () => {
    for (let i = 0; i < 200; i++) {
      expect(genPairCode()).not.toMatch(/[0O1ILU]/);
    }
  });

  it('is effectively unique across many draws', () => {
    const set = new Set(Array.from({ length: 200 }, () => genPairCode()));
    expect(set.size).toBeGreaterThan(190);
  });
});

describe('commitment', () => {
  it('verifies the committed public key + salt', () => {
    const kp = genEphemeralKeyPair();
    const salt = genSalt();
    const c = commit(kp.publicKey, salt);
    expect(verifyCommit(c, kp.publicKey, salt)).toBe(true);
  });

  it('rejects a swapped public key (MITM)', () => {
    const kp = genEphemeralKeyPair();
    const other = genEphemeralKeyPair();
    const salt = genSalt();
    expect(verifyCommit(commit(kp.publicKey, salt), other.publicKey, salt)).toBe(false);
  });
});

describe('deriveSAS', () => {
  const agent = genEphemeralKeyPair();
  const app = genEphemeralKeyPair();

  it('is a deterministic 6-digit string', () => {
    const sas = deriveSAS(agent.publicKey, app.publicKey);
    expect(sas).toMatch(/^\d{6}$/);
    expect(deriveSAS(agent.publicKey, app.publicKey)).toBe(sas);
  });

  it('differs when a public key is substituted (MITM)', () => {
    const mitm = genEphemeralKeyPair();
    expect(deriveSAS(mitm.publicKey, app.publicKey)).not.toBe(
      deriveSAS(agent.publicKey, app.publicKey),
    );
  });
});
