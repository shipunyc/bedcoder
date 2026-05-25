import QRCode from 'qrcode';

// QR payload for native scanning (the future iOS/Android app). The key travels
// in the QR only on this native path; web uses the pairing code + crypto_box
// instead (DESIGN §6.1). Format: bedcoder://pair?relay=...&sid=...&k=base64url(K)
export interface QrPayload {
  relayUrl: string;
  sid: string;
  key: Uint8Array;
}

export function encodeQrPayload(p: QrPayload): string {
  const params = new URLSearchParams({
    relay: p.relayUrl,
    sid: p.sid,
    k: Buffer.from(p.key).toString('base64url'),
  });
  return `bedcoder://pair?${params.toString()}`;
}

export function parseQrPayload(text: string): QrPayload {
  const url = new URL(text);
  const relay = url.searchParams.get('relay');
  const sid = url.searchParams.get('sid');
  const k = url.searchParams.get('k');
  if (!relay || !sid || !k) {
    throw new Error('invalid QR payload: missing relay/sid/k');
  }
  return { relayUrl: relay, sid, key: new Uint8Array(Buffer.from(k, 'base64url')) };
}

// Render a QR code as an ASCII block for the terminal status box.
export function renderQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'terminal', small: true });
}
