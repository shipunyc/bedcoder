import { z } from 'zod';
import { encode, decode } from '@msgpack/msgpack';

// Preview control frames (DESIGN §5 preview carve-out). These flow ONLY between
// the agent and the relay, in PLAINTEXT (msgpack) — they are not end-to-end
// encrypted and the app never sees them (it just opens the resulting HTTPS URL).
// Discriminated on the wire by `pv` (preview version), distinct from pairing
// (`type`) and session envelopes (`v`). Mirror of the Go structs in
// relay/internal/server/preview.go — keep them in sync.

const ENCODE_OPTS = { ignoreUndefined: true } as const;

export const previewFrameSchema = z.discriminatedUnion('op', [
  // agent -> relay: claim a token so /p/<token>/... routes to this session.
  z.object({ pv: z.literal(1), op: z.literal('register'), token: z.string() }),
  // relay -> agent: proxy this HTTP request to localhost:<port>.
  z.object({
    pv: z.literal(1),
    op: z.literal('req'),
    id: z.string(),
    port: z.number().int().min(1).max(65535),
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string()).optional(),
    bodyB64: z.string().optional(),
  }),
  // agent -> relay: the response (or an error) for a `req`.
  z.object({
    pv: z.literal(1),
    op: z.literal('res'),
    id: z.string(),
    status: z.number().int().optional(),
    headers: z.record(z.string()).optional(),
    bodyB64: z.string().optional(),
    error: z.string().optional(),
  }),
]);
export type PreviewFrame = z.infer<typeof previewFrameSchema>;

export function encodePreview(frame: PreviewFrame): Uint8Array {
  return encode(previewFrameSchema.parse(frame), ENCODE_OPTS);
}

export function decodePreview(buf: Uint8Array): PreviewFrame {
  return previewFrameSchema.parse(decode(buf));
}
