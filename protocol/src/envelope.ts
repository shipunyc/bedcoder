import { z } from 'zod';

// Protocol version. Bump only on breaking wire changes; every Envelope carries it.
export const PROTOCOL_VERSION = 1 as const;

// Channels multiplexed over one session. The relay routes by `ch` but never
// decrypts the payload (see DESIGN §4.1 / §5.2).
export const channelSchema = z.enum(['terminal', 'tunnel', 'screen', 'files']);
export type Channel = z.infer<typeof channelSchema>;

// Optional hint that lets the relay fire a push without reading the payload.
export const notifyHintSchema = z.enum([
  'permission_needed',
  'task_completed',
  'error_occurred',
]);
export type NotifyHint = z.infer<typeof notifyHintSchema>;

// Binary fields: z.custom<Uint8Array> infers the wide `Uint8Array<ArrayBufferLike>`
// (z.instanceof would narrow to `<ArrayBuffer>`, which mismatches tweetnacl output).
export const bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'expected Uint8Array');

// The shared outer frame. Only the outer fields are visible to the relay;
// `encrypted` is the end-to-end-encrypted payload (DESIGN §4.1).
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  sid: z.string().min(1),
  from: z.enum(['agent', 'app']),
  ch: channelSchema,
  seq: z.number().int().nonnegative(),
  ts: z.number().int(),
  notify: notifyHintSchema.optional(),
  encrypted: bytes,
});
export type Envelope = z.infer<typeof envelopeSchema>;
