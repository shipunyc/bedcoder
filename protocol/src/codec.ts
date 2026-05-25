import { encode, decode } from '@msgpack/msgpack';
import { envelopeSchema, type Envelope } from './envelope';
import { pairingMessageSchema, type PairingMessage } from './pairing';

// MessagePack is the wire framing for the outer Envelope and the pre-session
// pairing messages (binary-native, more compact than JSON; DESIGN §4.6 / §4.8).
// `ignoreUndefined` drops absent optional fields so round-trips stay clean.
const ENCODE_OPTS = { ignoreUndefined: true } as const;

export function encodeEnvelope(env: Envelope): Uint8Array {
  return encode(envelopeSchema.parse(env), ENCODE_OPTS);
}

export function decodeEnvelope(buf: Uint8Array): Envelope {
  return envelopeSchema.parse(decode(buf));
}

export function encodePairing(msg: PairingMessage): Uint8Array {
  return encode(pairingMessageSchema.parse(msg), ENCODE_OPTS);
}

export function decodePairing(buf: Uint8Array): PairingMessage {
  return pairingMessageSchema.parse(decode(buf));
}

export type MessageKind = 'pairing' | 'envelope' | 'preview' | 'unknown';

// Cheaply classify an inbound frame: preview control frames carry `pv`, pairing
// messages carry `type`, session envelopes carry `v`. Mirrors the relay's
// dispatch (DESIGN §5).
export function peekMessageKind(buf: Uint8Array): MessageKind {
  const v = decode(buf);
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    if (typeof rec.pv === 'number') return 'preview';
    if (typeof rec.type === 'string') return 'pairing';
    if (typeof rec.v === 'number') return 'envelope';
  }
  return 'unknown';
}
