import { z } from 'zod';
import { bytes } from './envelope';

// Pairing handshake (DESIGN §4.8). This sub-protocol runs *before* the session
// key exists, so it is NOT carried inside the K-encrypted Envelope. It uses a
// commitment + SAS so a short pairing code is safe against an active MITM relay.
//
// Flow: register(commit) → claim → commit → responder(appPub)
//       → reveal(agentPub, salt) → confirm (after user verifies SAS) → key.


export const pairingMessageSchema = z.discriminatedUnion('type', [
  // agent → relay: claim a slot, committing to its ephemeral pubkey.
  z.object({ type: z.literal('register'), code: z.string(), commit: bytes }),
  // app → relay: claim the slot by code.
  z.object({ type: z.literal('claim'), code: z.string() }),
  // relay → app: deliver the agent's commitment + the session id to join.
  z.object({ type: z.literal('commit'), commit: bytes, sid: z.string() }),
  // app → agent: the app's ephemeral pubkey.
  z.object({ type: z.literal('responder'), appEphPub: bytes }),
  // agent → app: reveal pubkey + salt; app verifies SHA-256(pub‖salt) == commit.
  z.object({ type: z.literal('reveal'), agentEphPub: bytes, salt: bytes }),
  // app → agent: user confirmed the 6-digit SAS matches on both ends.
  z.object({ type: z.literal('confirm') }),
  // agent → app: the session key K wrapped with crypto_box to the app's pubkey.
  z.object({ type: z.literal('key'), wrappedKey: bytes }),
  // relay → app: pairing failed (unknown/expired/claimed code, rate limited).
  z.object({ type: z.literal('error'), error: z.string() }),
  // app → relay: register a Web Push subscription (JSON: endpoint + keys) for
  // this session. Relay-visible (needed to send pushes); not part of the E2E
  // payload. Standard VAPID Web Push — no Firebase.
  z.object({ type: z.literal('push'), subscription: z.string() }),
]);
export type PairingMessage = z.infer<typeof pairingMessageSchema>;
