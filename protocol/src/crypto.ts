import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';

// Crypto primitives shared by agent and (mock) app (DESIGN §4.6 / §4.8):
//   - symmetric session encryption (XSalsa20-Poly1305) with key K
//   - pairing key exchange (X25519 ECDH -> wrapping key W, wrap/unwrap K)
//   - pairing code (Crockford base32 minus 0/O/1/I/L/U)
//   - commitment + SAS for MITM-resistant pairing

const NONCE_LEN = nacl.secretbox.nonceLength; // 24
const KEY_LEN = nacl.secretbox.keyLength; // 32

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function sha256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(data).digest());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Constant-time byte comparison.
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// secretbox: prepend the random nonce, then [nonce:24][ciphertext+MAC].
function seal(message: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(NONCE_LEN);
  const box = nacl.secretbox(message, nonce, key);
  return concat(nonce, box);
}

function open(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = sealed.subarray(0, NONCE_LEN);
  const box = sealed.subarray(NONCE_LEN);
  const opened = nacl.secretbox.open(box, nonce, key);
  if (!opened) throw new Error('decryption failed');
  return opened;
}

// ---- symmetric session payloads (JSON -> UTF-8 -> secretbox) ----

export function generateKey(): Uint8Array {
  return nacl.randomBytes(KEY_LEN);
}

export function encrypt(plaintext: unknown, key: Uint8Array): Uint8Array {
  return seal(textEncoder.encode(JSON.stringify(plaintext)), key);
}

export function decrypt<T = unknown>(sealed: Uint8Array, key: Uint8Array): T {
  return JSON.parse(textDecoder.decode(open(sealed, key))) as T;
}

// ---- pairing key exchange (X25519) ----

export interface EphemeralKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function genEphemeralKeyPair(): EphemeralKeyPair {
  return nacl.box.keyPair();
}

const BOX_NONCE_LEN = nacl.box.nonceLength; // 24

// Wrap the session key K with NaCl crypto_box (X25519 + XSalsa20-Poly1305).
// Using crypto_box directly — rather than exposing a separately-derived shared
// key — keeps this interoperable with pinenacl on the Dart side. The agent calls
// wrapKey(K, appPublicKey, agentSecretKey); the app unwraps with the mirrored
// keys. Output layout: [nonce:24][box].
export function wrapKey(k: Uint8Array, theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(BOX_NONCE_LEN);
  return concat(nonce, nacl.box(k, nonce, theirPublicKey, mySecretKey));
}

export function unwrapKey(wrapped: Uint8Array, theirPublicKey: Uint8Array, mySecretKey: Uint8Array): Uint8Array {
  const nonce = wrapped.subarray(0, BOX_NONCE_LEN);
  const box = wrapped.subarray(BOX_NONCE_LEN);
  const k = nacl.box.open(box, nonce, theirPublicKey, mySecretKey);
  if (!k) throw new Error('unwrap failed');
  return k;
}

// ---- pairing code ----

// Crockford base32 minus the easily-confused 0 O 1 I L U (30 symbols).
export const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_LEN = 8;

export function genPairCode(): string {
  const n = PAIR_ALPHABET.length;
  // Rejection-sample bytes to avoid modulo bias.
  const limit = Math.floor(256 / n) * n;
  let code = '';
  while (code.length < PAIR_CODE_LEN) {
    for (const byte of nacl.randomBytes(PAIR_CODE_LEN)) {
      if (byte < limit) {
        code += PAIR_ALPHABET.charAt(byte % n);
        if (code.length === PAIR_CODE_LEN) break;
      }
    }
  }
  return code;
}

// ---- commitment + SAS (DESIGN §4.8) ----

export function genSalt(): Uint8Array {
  return nacl.randomBytes(16);
}

// commit = SHA-256(publicKey || salt). The agent commits before learning the
// app's public key, which is what keeps a short SAS safe against an active MITM.
export function commit(publicKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return sha256(concat(publicKey, salt));
}

export function verifyCommit(commitment: Uint8Array, publicKey: Uint8Array, salt: Uint8Array): boolean {
  return bytesEqual(commitment, commit(publicKey, salt));
}

export const SAS_DIGITS = 6;

// SAS = first 4 bytes of SHA-256(agentPub || appPub) as a zero-padded 6-digit
// number. Identical on both ends iff no MITM substituted a public key.
export function deriveSAS(agentPublicKey: Uint8Array, appPublicKey: Uint8Array): string {
  const h = sha256(concat(agentPublicKey, appPublicKey));
  const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0);
  return (n % 1_000_000).toString().padStart(SAS_DIGITS, '0');
}
