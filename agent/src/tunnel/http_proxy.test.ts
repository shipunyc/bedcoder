import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { processTunnelRequest } from './http_proxy';
import type { TunnelInput } from '@bedcoder/protocol';

// ============================================================================
// Test HTTP Server
// ============================================================================

let testServer: Server;
let testPort: number;

beforeAll(async () => {
  testServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname;

    // Collect request body
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);

      // Route handlers
      if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Hello</body></html>');
      } else if (path === '/api/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          headers: req.headers,
          body: body.toString('utf-8'),
        }));
      } else if (path === '/api/binary') {
        // Return a simple binary response (PNG magic bytes)
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
      } else if (path === '/api/slow') {
        // Slow response for timeout testing
        setTimeout(() => {
          res.writeHead(200);
          res.end('slow');
        }, 5000);
      } else if (path === '/api/large') {
        // Large response (1MB of 'x')
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(1024 * 1024));
      } else if (path === '/api/status/404') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else if (path === '/api/status/500') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  });

  // Find an available port
  await new Promise<void>((resolve) => {
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer.address();
      if (addr && typeof addr === 'object') {
        testPort = addr.port;
      }
      resolve();
    });
  });
});

afterAll(() => {
  testServer.close();
});

// ============================================================================
// Tests
// ============================================================================

describe('processTunnelRequest', () => {
  describe('GET requests', () => {
    it('handles basic GET request', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-1',
        method: 'GET',
        port: testPort,
        path: '/',
      };

      const result = await processTunnelRequest(input);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.id).toBe('test-1');
        expect(result.status).toBe(200);
        expect(result.headers?.['content-type']).toBe('text/html');

        // Decode body
        const body = Buffer.from(result.bodyBase64 ?? '', 'base64').toString('utf-8');
        expect(body).toContain('<html>');
      }
    });

    it('handles GET with query string', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-2',
        method: 'GET',
        port: testPort,
        path: '/api/echo?foo=bar',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(200);
      }
    });

    it('handles 404 response', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-3',
        method: 'GET',
        port: testPort,
        path: '/api/status/404',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(404);
      }
    });

    it('handles 500 response', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-4',
        method: 'GET',
        port: testPort,
        path: '/api/status/500',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(500);
      }
    });
  });

  describe('POST requests', () => {
    it('handles POST with JSON body', async () => {
      const body = JSON.stringify({ name: 'test' });
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-5',
        method: 'POST',
        port: testPort,
        path: '/api/echo',
        headers: { 'Content-Type': 'application/json' },
        bodyBase64: Buffer.from(body).toString('base64'),
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(200);

        const responseBody = JSON.parse(
          Buffer.from(result.bodyBase64 ?? '', 'base64').toString('utf-8'),
        );
        expect(responseBody.method).toBe('POST');
        expect(responseBody.body).toBe(body);
      }
    });
  });

  describe('binary responses', () => {
    it('handles binary response correctly', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-6',
        method: 'GET',
        port: testPort,
        path: '/api/binary',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(200);
        expect(result.headers?.['content-type']).toBe('image/png');

        // Verify PNG magic bytes
        const body = Buffer.from(result.bodyBase64 ?? '', 'base64');
        expect(body[0]).toBe(0x89);
        expect(body[1]).toBe(0x50);
        expect(body[2]).toBe(0x4e);
        expect(body[3]).toBe(0x47);
      }
    });
  });

  describe('error handling', () => {
    it('returns connection_refused for non-listening port', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-7',
        method: 'GET',
        port: 59999, // Unlikely to be in use
        path: '/',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_error');
      if (result?.type === 'http_error') {
        expect(result.id).toBe('test-7');
        expect(result.code).toBe('connection_refused');
        expect(result.message).toContain('59999');
      }
    });

    it('returns timeout for slow requests', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-8',
        method: 'GET',
        port: testPort,
        path: '/api/slow',
      };

      const result = await processTunnelRequest(input, { timeoutMs: 100 });

      expect(result?.type).toBe('http_error');
      if (result?.type === 'http_error') {
        expect(result.code).toBe('timeout');
      }
    }, 10000);
  });

  describe('refresh_ports', () => {
    it('returns null for refresh_ports (handled elsewhere)', async () => {
      const input: TunnelInput = { type: 'refresh_ports' };
      const result = await processTunnelRequest(input);
      expect(result).toBeNull();
    });
  });

  describe('scheme override', () => {
    // Note: testPort is only assigned in beforeAll, so build the input inside
    // each test (a hoisted const would capture the pre-listen value).
    const httpGet = (): TunnelInput => ({
      type: 'http_request',
      id: 'scheme-1',
      method: 'GET',
      port: testPort, // a plain-HTTP server
      path: '/',
    });

    it('scheme:"http" fetches the HTTP server successfully', async () => {
      const result = await processTunnelRequest(httpGet(), { scheme: 'http' });
      expect(result?.type).toBe('http_response');
    });

    it('scheme:"https" switches to the TLS client (handshake fails on a plain-HTTP port)', async () => {
      // Without the override, testPort uses HTTP and succeeds; forcing https
      // makes the TLS client talk to a plaintext server, which errors.
      const result = await processTunnelRequest(httpGet(), { scheme: 'https' });
      expect(result?.type).toBe('http_error');
    }, 10000);
  });

  describe('HTTP methods', () => {
    it('handles PUT request', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-put',
        method: 'PUT',
        port: testPort,
        path: '/api/echo',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        const body = JSON.parse(
          Buffer.from(result.bodyBase64 ?? '', 'base64').toString('utf-8'),
        );
        expect(body.method).toBe('PUT');
      }
    });

    it('handles DELETE request', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-delete',
        method: 'DELETE',
        port: testPort,
        path: '/api/echo',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        const body = JSON.parse(
          Buffer.from(result.bodyBase64 ?? '', 'base64').toString('utf-8'),
        );
        expect(body.method).toBe('DELETE');
      }
    });

    it('handles HEAD request', async () => {
      const input: TunnelInput = {
        type: 'http_request',
        id: 'test-head',
        method: 'HEAD',
        port: testPort,
        path: '/',
      };

      const result = await processTunnelRequest(input);

      expect(result?.type).toBe('http_response');
      if (result?.type === 'http_response') {
        expect(result.status).toBe(200);
        // HEAD should not have a body (or empty body)
      }
    });
  });
});
