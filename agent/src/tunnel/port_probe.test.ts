import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { probeScheme, annotateSchemes, type ProbeDeps } from './port_probe';
import type { ListeningPort } from '@bedcoder/protocol';

// ============================================================================
// Real loopback HTTP server (integration)
// ============================================================================

describe('probeScheme (real http server)', () => {
  let server: Server;
  let port: number;

  afterEach(() => server?.close());

  it('classifies a real HTTP server as http', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    expect(await probeScheme(port, { host: '127.0.0.1', timeoutMs: 1500 })).toBe('http');
  }, 10000);

  it('returns undefined for a port nothing is listening on', async () => {
    // A high port we expect to be free; ECONNREFUSED on both probes.
    expect(await probeScheme(59873, { host: '127.0.0.1', timeoutMs: 1000 })).toBeUndefined();
  }, 10000);
});

// ============================================================================
// Injected primitives (deterministic, offline)
// ============================================================================

// Minimal fakes for tls.connect / http.request driven by EventEmitter.
function fakeTls(behavior: 'secureConnect' | 'error'): ProbeDeps['tlsConnect'] {
  return (() => {
    const s = new EventEmitter() as EventEmitter & { destroy: () => void };
    s.destroy = () => {};
    queueMicrotask(() => s.emit(behavior, behavior === 'error' ? new Error('nope') : undefined));
    return s as never;
  }) as ProbeDeps['tlsConnect'];
}

function fakeHttp(behavior: 'response' | 'error'): ProbeDeps['httpRequest'] {
  return ((_opts: unknown, cb?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.end = () => {};
    req.destroy = () => {};
    queueMicrotask(() => {
      if (behavior === 'response') {
        const res = new EventEmitter() as EventEmitter & { destroy: () => void };
        res.destroy = () => {};
        cb?.(res);
      } else {
        req.emit('error', new Error('nope'));
      }
    });
    return req as never;
  }) as unknown as ProbeDeps['httpRequest'];
}

describe('probeScheme (injected primitives)', () => {
  it('prefers https when the TLS handshake succeeds', async () => {
    const scheme = await probeScheme(1234, {
      tlsConnect: fakeTls('secureConnect'),
      httpRequest: fakeHttp('response'), // even if http also answers
    });
    expect(scheme).toBe('https');
  });

  it('falls back to http when TLS fails but HTTP answers', async () => {
    const scheme = await probeScheme(1234, {
      tlsConnect: fakeTls('error'),
      httpRequest: fakeHttp('response'),
    });
    expect(scheme).toBe('http');
  });

  it('returns undefined when neither responds', async () => {
    const scheme = await probeScheme(1234, {
      tlsConnect: fakeTls('error'),
      httpRequest: fakeHttp('error'),
    });
    expect(scheme).toBeUndefined();
  });
});

// ============================================================================
// annotateSchemes
// ============================================================================

describe('annotateSchemes', () => {
  const ports: ListeningPort[] = [
    { port: 5173, process: 'node' },
    { port: 6379, process: 'redis-server' },
    { port: 8443, process: 'caddy' },
  ];

  it('keeps only web ports and tags each with its scheme', async () => {
    const probe = async (port: number) =>
      port === 5173 ? ('http' as const) : port === 8443 ? ('https' as const) : undefined;

    const out = await annotateSchemes(ports, probe);
    expect(out).toEqual([
      { port: 5173, process: 'node', scheme: 'http' },
      { port: 8443, process: 'caddy', scheme: 'https' },
    ]);
  });

  it('returns [] (and never probes) for an empty list', async () => {
    let called = false;
    const probe = async () => {
      called = true;
      return 'http' as const;
    };
    expect(await annotateSchemes([], probe)).toEqual([]);
    expect(called).toBe(false);
  });
});
