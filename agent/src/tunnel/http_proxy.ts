// HTTP proxy module (DESIGN §4.3 / Phase 2.1.3).
// Proxies HTTP requests from the mobile app to local development servers.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type {
  TunnelInput,
  TunnelOutput,
  HttpHeaders,
} from '@bedcoder/protocol';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

// ============================================================================
// HTTP Proxy Implementation
// ============================================================================

interface ProxyOptions {
  timeoutMs?: number;
  maxBodySize?: number;
  // Force the upstream scheme (from port probing); falls back to the 443/8443
  // heuristic when unset.
  scheme?: 'http' | 'https';
}

/**
 * Convert protocol headers to Node.js headers format.
 * Handles both string and string[] values.
 */
function toNodeHeaders(headers?: HttpHeaders): Record<string, string | string[]> | undefined {
  if (!headers) return undefined;

  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

/**
 * Convert Node.js response headers to protocol format.
 */
function fromNodeHeaders(headers: IncomingMessage['headers']): HttpHeaders {
  const result: HttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Read response body with size limit.
 */
async function readBody(res: IncomingMessage, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    res.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        res.destroy();
        reject(new Error(`Response body exceeds ${maxSize} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    res.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    res.on('error', reject);
  });
}

/**
 * Execute an HTTP request to localhost.
 */
async function executeRequest(
  method: string,
  port: number,
  path: string,
  headers?: HttpHeaders,
  bodyBase64?: string,
  options: ProxyOptions = {},
): Promise<TunnelOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodySize = options.maxBodySize ?? MAX_BODY_SIZE;

  // Prefer the probed scheme; otherwise fall back to the 443/8443 heuristic.
  const useHttps = options.scheme ? options.scheme === 'https' : port === 443 || port === 8443;
  const reqFn = useHttps ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    // Create a dummy request ID - this will be filled in by caller
    const requestId = '';

    const reqOptions = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: toNodeHeaders(headers),
      timeout: timeoutMs,
      // For HTTPS, allow self-signed certs in development
      rejectUnauthorized: false,
    };

    const req = reqFn(reqOptions, async (res) => {
      try {
        const body = await readBody(res, maxBodySize);

        resolve({
          type: 'http_response',
          id: requestId,
          status: res.statusCode ?? 500,
          statusText: res.statusMessage,
          headers: fromNodeHeaders(res.headers),
          bodyBase64: body.length > 0 ? body.toString('base64') : undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to read response';

        if (message.includes('exceeds')) {
          resolve({
            type: 'http_error',
            id: requestId,
            code: 'body_too_large',
            message,
          });
        } else {
          resolve({
            type: 'http_error',
            id: requestId,
            code: 'network_error',
            message,
          });
        }
      }
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      const message = err.message;

      // Determine error type
      // Check both message and error code for ECONNREFUSED.
      // On Windows, connecting to a non-listening port via 'localhost' (IPv6) may
      // yield EACCES instead of ECONNREFUSED — treat it the same way.
      if (message.includes('ECONNREFUSED') || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
        resolve({
          type: 'http_error',
          id: requestId,
          code: 'connection_refused',
          message: `Port ${port} is not listening`,
        });
      } else {
        resolve({
          type: 'http_error',
          id: requestId,
          code: 'network_error',
          message,
        });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        type: 'http_error',
        id: requestId,
        code: 'timeout',
        message: `Request timed out after ${timeoutMs}ms`,
      });
    });

    // Send body if present
    if (bodyBase64) {
      try {
        const body = Buffer.from(bodyBase64, 'base64');
        req.write(body);
      } catch {
        resolve({
          type: 'http_error',
          id: requestId,
          code: 'invalid_request',
          message: 'Invalid base64 body encoding',
        });
        return;
      }
    }

    req.end();
  });
}

/**
 * Process a tunnel input message and return the appropriate output.
 */
export async function processTunnelRequest(
  input: TunnelInput,
  options: ProxyOptions = {},
): Promise<TunnelOutput | null> {
  if (input.type === 'refresh_ports') {
    // Port list refresh is handled by the channel, not here
    return null;
  }

  if (input.type === 'http_request') {
    const result = await executeRequest(
      input.method,
      input.port,
      input.path,
      input.headers,
      input.bodyBase64,
      options,
    );

    // Fill in the request ID
    if (result.type === 'http_response' || result.type === 'http_error') {
      return { ...result, id: input.id };
    }

    return result;
  }

  return null;
}

// ============================================================================
// Exported Types
// ============================================================================

export type { ProxyOptions };
