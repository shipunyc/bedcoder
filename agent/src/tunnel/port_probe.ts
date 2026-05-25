// Port protocol probe (Phase 2.1). A discovered port only tells us *something*
// is listening, not whether a browser can open it. We actively probe each
// hosted port to classify it as http / https, and drop the rest (raw TCP,
// WebSocket-only, databases…) so the Preview tab lists only openable servers.

import { request as httpRequest, type ClientRequest } from 'node:http';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { ListeningPort } from '@bedcoder/protocol';

export type PortScheme = 'http' | 'https';

const PROBE_HOST = 'localhost'; // matches what http_proxy fetches
// Generous, so a dev server that's listening but slow to answer its first
// request still gets classified (and shown) instead of timing out. A responsive
// server replies in ms regardless; only a non-web/dead port waits this long.
const PROBE_TIMEOUT_MS = 10_000;

export interface ProbeDeps {
  host?: string;
  timeoutMs?: number;
  // Injectable for tests; default to the real node primitives.
  tlsConnect?: typeof tlsConnect;
  httpRequest?: typeof httpRequest;
}

// True if a TLS handshake completes — i.e. the port speaks TLS (https).
function probeHttps(port: number, deps: ProbeDeps): Promise<boolean> {
  const host = deps.host ?? PROBE_HOST;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const connect = deps.tlsConnect ?? tlsConnect;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, socket?: TLSSocket): void => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolve(ok);
    };
    try {
      const socket = connect({ host, port, rejectUnauthorized: false, timeout: timeoutMs });
      socket.on('secureConnect', () => finish(true, socket));
      socket.on('timeout', () => finish(false, socket));
      socket.on('error', () => finish(false, socket));
    } catch {
      finish(false);
    }
  });
}

// True if the port answers an HTTP request (any status line counts).
function probeHttp(port: number, deps: ProbeDeps): Promise<boolean> {
  const host = deps.host ?? PROBE_HOST;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const reqFn = deps.httpRequest ?? httpRequest;
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, req?: ClientRequest): void => {
      if (done) return;
      done = true;
      req?.destroy();
      resolve(ok);
    };
    try {
      const req = reqFn({ host, port, method: 'HEAD', path: '/', timeout: timeoutMs }, (res) => {
        res.destroy();
        finish(true, req);
      });
      req.on('timeout', () => finish(false, req));
      req.on('error', () => finish(false, req));
      req.end();
    } catch {
      finish(false);
    }
  });
}

/**
 * Classify a port by probing https and http concurrently. Prefers https (a TLS
 * handshake is unambiguous; an https server replies to plaintext with garbage).
 * Returns undefined if the port speaks neither (not browser-openable).
 */
export async function probeScheme(port: number, deps: ProbeDeps = {}): Promise<PortScheme | undefined> {
  const [httpsOk, httpOk] = await Promise.all([probeHttps(port, deps), probeHttp(port, deps)]);
  return httpsOk ? 'https' : httpOk ? 'http' : undefined;
}

export type SchemeProbe = (port: number) => Promise<PortScheme | undefined>;

/**
 * Probe every port in parallel, tag it with its scheme, and keep only the
 * browser-openable ones (http/https). Empty in → empty out (no probing).
 */
export async function annotateSchemes(
  ports: ListeningPort[],
  probe: SchemeProbe = (p) => probeScheme(p),
): Promise<ListeningPort[]> {
  if (ports.length === 0) return [];
  const schemes = await Promise.all(ports.map((p) => probe(p.port)));
  const out: ListeningPort[] = [];
  for (let i = 0; i < ports.length; i++) {
    const scheme = schemes[i];
    if (scheme) out.push({ ...ports[i]!, scheme });
  }
  return out;
}
