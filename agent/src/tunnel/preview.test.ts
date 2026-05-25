import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PreviewFrame } from '@bedcoder/protocol';
import { PreviewProxy, generatePreviewToken } from './preview';

// A fake transport capturing sent frames and letting the test inject inbound ones.
class FakeTransport {
  sent: PreviewFrame[] = [];
  private handler: (f: PreviewFrame) => void = () => {};
  onPreview(h: (f: PreviewFrame) => void): void {
    this.handler = h;
  }
  sendPreview(f: PreviewFrame): void {
    this.sent.push(f);
  }
  inject(f: PreviewFrame): void {
    this.handler(f);
  }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('generatePreviewToken', () => {
  it('returns a 32-char hex token, unique per call', () => {
    const a = generatePreviewToken();
    const b = generatePreviewToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('PreviewProxy', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  it('registers its token on start', () => {
    new PreviewProxy(transport, 'tok-1').start();
    expect(transport.sent).toContainEqual({ pv: 1, op: 'register', token: 'tok-1' });
  });

  it('proxies a request to a local server and replies with a res frame', async () => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello preview');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    try {
      new PreviewProxy(transport, 'tok-1').start();
      transport.inject({ pv: 1, op: 'req', id: 'r1', port, method: 'GET', path: '/' });

      await waitUntil(() => transport.sent.some((f) => f.op === 'res' && f.id === 'r1'));
      const res = transport.sent.find((f) => f.op === 'res' && f.id === 'r1');
      expect(res).toBeDefined();
      if (res && res.op === 'res') {
        expect(res.status).toBe(200);
        expect(Buffer.from(res.bodyB64 ?? '', 'base64').toString('utf-8')).toBe('hello preview');
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('replies with an error for a dead port', async () => {
    new PreviewProxy(transport, 'tok-1').start();
    transport.inject({ pv: 1, op: 'req', id: 'r2', port: 1, method: 'GET', path: '/' });

    await waitUntil(() => transport.sent.some((f) => f.op === 'res' && f.id === 'r2'));
    const res = transport.sent.find((f) => f.op === 'res' && f.id === 'r2');
    expect(res && res.op === 'res' && res.error).toBeTruthy();
  });

  it('ignores non-req frames', () => {
    const proxy = new PreviewProxy(transport, 'tok-1');
    proxy.start();
    transport.sent.length = 0;
    transport.inject({ pv: 1, op: 'register', token: 'x' });
    expect(transport.sent).toHaveLength(0);
  });
});
