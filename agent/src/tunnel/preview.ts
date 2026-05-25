// Preview proxy (DESIGN §5 carve-out, agent side). Claims a per-session token
// with the relay, then answers the relay's plaintext `preview` control frames by
// fetching localhost:<port> through the existing HTTP proxy and returning the
// response. The relay serves these to a browser at https://<relay>/p/<token>/...

import { randomBytes } from 'node:crypto';
import type { PreviewFrame, HttpMethod, HttpHeaders } from '@bedcoder/protocol';
import { processTunnelRequest } from './http_proxy';
import { log } from '../log';

export interface PreviewTransport {
  onPreview(handler: (frame: PreviewFrame) => void): void;
  sendPreview(frame: PreviewFrame): void;
}

// A URL-safe random token that gates access to this session's dev servers.
export function generatePreviewToken(): string {
  return randomBytes(16).toString('hex');
}

export interface PreviewProxyOptions {
  httpTimeoutMs?: number;
  // Look up a port's probed scheme so the upstream fetch uses http vs https
  // correctly (an https dev server on a non-standard port would otherwise fail).
  schemeFor?: (port: number) => 'http' | 'https' | undefined;
}

export class PreviewProxy {
  private readonly httpTimeoutMs: number;
  private readonly schemeFor?: (port: number) => 'http' | 'https' | undefined;

  constructor(
    private readonly transport: PreviewTransport,
    private readonly token: string,
    options: PreviewProxyOptions = {},
  ) {
    this.httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
    this.schemeFor = options.schemeFor;
  }

  start(): void {
    this.transport.onPreview((frame) => void this.handle(frame));
    this.register();
  }

  // (Re)claim the token — also called after a reconnect so routing survives.
  register(): void {
    this.transport.sendPreview({ pv: 1, op: 'register', token: this.token });
  }

  private async handle(frame: PreviewFrame): Promise<void> {
    if (frame.op !== 'req') return;
    log('preview:req', { id: frame.id, port: frame.port, path: frame.path });
    const out = await processTunnelRequest(
      {
        type: 'http_request',
        id: frame.id,
        method: frame.method as HttpMethod,
        port: frame.port,
        path: frame.path,
        headers: frame.headers as HttpHeaders | undefined,
        bodyBase64: frame.bodyB64,
      },
      { timeoutMs: this.httpTimeoutMs, scheme: this.schemeFor?.(frame.port) },
    );
    if (!out) return;
    if (out.type === 'http_response') {
      this.transport.sendPreview({
        pv: 1,
        op: 'res',
        id: frame.id,
        status: out.status,
        headers: flattenHeaders(out.headers),
        bodyB64: out.bodyBase64,
      });
    } else if (out.type === 'http_error') {
      this.transport.sendPreview({ pv: 1, op: 'res', id: frame.id, error: out.message });
    }
  }
}

// Collapse multi-value headers to single strings for the preview frame.
function flattenHeaders(headers?: HttpHeaders): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}
