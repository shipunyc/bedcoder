import { describe, it, expect } from 'vitest';
import {
  tunnelInputSchema,
  tunnelOutputSchema,
  listeningPortSchema,
  type TunnelInput,
  type TunnelOutput,
  type ListeningPort,
} from './tunnel';

// ============================================================================
// Valid Test Cases
// ============================================================================

const validPorts: ListeningPort[] = [
  { port: 3000 },
  { port: 8080, pid: 12345 },
  { port: 5173, pid: 1234, process: 'node' },
  { port: 4000, pid: 5678, process: 'python', cmdline: 'python -m http.server 4000' },
];

const validInputs: TunnelInput[] = [
  // Basic HTTP requests
  { type: 'http_request', id: 'req-1', method: 'GET', port: 3000, path: '/' },
  { type: 'http_request', id: 'req-2', method: 'GET', port: 8080, path: '/api/users?page=1' },
  { type: 'http_request', id: 'req-3', method: 'POST', port: 3000, path: '/api/data' },
  {
    type: 'http_request',
    id: 'req-4',
    method: 'POST',
    port: 3000,
    path: '/api/upload',
    headers: { 'Content-Type': 'application/json' },
    bodyBase64: 'eyJuYW1lIjoiZm9vIn0=', // {"name":"foo"}
  },
  {
    type: 'http_request',
    id: 'req-5',
    method: 'PUT',
    port: 5173,
    path: '/resource/123',
    headers: {
      'Content-Type': 'application/json',
      'Accept': ['application/json', 'text/plain'],
    },
  },
  { type: 'http_request', id: 'req-6', method: 'DELETE', port: 8000, path: '/item/456' },
  { type: 'http_request', id: 'req-7', method: 'PATCH', port: 3000, path: '/partial' },
  { type: 'http_request', id: 'req-8', method: 'HEAD', port: 3000, path: '/check' },
  { type: 'http_request', id: 'req-9', method: 'OPTIONS', port: 3000, path: '/cors' },
  // Refresh ports request
  { type: 'refresh_ports' },
];

const validOutputs: TunnelOutput[] = [
  // Port list
  { type: 'port_list', ports: [] },
  { type: 'port_list', ports: validPorts },
  // HTTP responses
  {
    type: 'http_response',
    id: 'req-1',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'text/html' },
    bodyBase64: 'PGh0bWw+PC9odG1sPg==', // <html></html>
  },
  {
    type: 'http_response',
    id: 'req-2',
    status: 201,
    headers: { 'Location': '/resource/new' },
  },
  { type: 'http_response', id: 'req-3', status: 204 },
  { type: 'http_response', id: 'req-4', status: 301, headers: { 'Location': '/new-path' } },
  { type: 'http_response', id: 'req-5', status: 404, statusText: 'Not Found' },
  { type: 'http_response', id: 'req-6', status: 500, statusText: 'Internal Server Error' },
  // HTTP errors
  { type: 'http_error', id: 'req-1', code: 'connection_refused', message: 'Port 3000 is not listening' },
  { type: 'http_error', id: 'req-2', code: 'timeout', message: 'Request timed out after 30s' },
  { type: 'http_error', id: 'req-3', code: 'network_error', message: 'DNS resolution failed' },
  { type: 'http_error', id: 'req-4', code: 'invalid_request', message: 'Malformed URL' },
  { type: 'http_error', id: 'req-5', code: 'body_too_large', message: 'Response exceeds 10MB limit' },
];

// ============================================================================
// Tests
// ============================================================================

describe('listeningPortSchema', () => {
  it.each(validPorts)('accepts %o', (port) => {
    expect(() => listeningPortSchema.parse(port)).not.toThrow();
  });

  it('rejects port out of range (0)', () => {
    expect(() => listeningPortSchema.parse({ port: 0 })).toThrow();
  });

  it('rejects port out of range (65536)', () => {
    expect(() => listeningPortSchema.parse({ port: 65536 })).toThrow();
  });

  it('rejects non-integer port', () => {
    expect(() => listeningPortSchema.parse({ port: 3000.5 })).toThrow();
  });

  it('rejects missing port', () => {
    expect(() => listeningPortSchema.parse({})).toThrow();
  });
});

describe('tunnelInputSchema', () => {
  it.each(validInputs)('accepts %o', (input) => {
    expect(() => tunnelInputSchema.parse(input)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => tunnelInputSchema.parse({ type: 'websocket' })).toThrow();
  });

  it('rejects missing required field (id)', () => {
    expect(() =>
      tunnelInputSchema.parse({ type: 'http_request', method: 'GET', port: 3000, path: '/' }),
    ).toThrow();
  });

  it('rejects missing required field (method)', () => {
    expect(() =>
      tunnelInputSchema.parse({ type: 'http_request', id: 'r1', port: 3000, path: '/' }),
    ).toThrow();
  });

  it('rejects invalid HTTP method', () => {
    expect(() =>
      tunnelInputSchema.parse({ type: 'http_request', id: 'r1', method: 'CONNECT', port: 3000, path: '/' }),
    ).toThrow();
  });

  it('rejects port out of range', () => {
    expect(() =>
      tunnelInputSchema.parse({ type: 'http_request', id: 'r1', method: 'GET', port: 0, path: '/' }),
    ).toThrow();
    expect(() =>
      tunnelInputSchema.parse({ type: 'http_request', id: 'r1', method: 'GET', port: 70000, path: '/' }),
    ).toThrow();
  });
});

describe('tunnelOutputSchema', () => {
  it.each(validOutputs)('accepts %o', (output) => {
    expect(() => tunnelOutputSchema.parse(output)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => tunnelOutputSchema.parse({ type: 'websocket_frame' })).toThrow();
  });

  it('rejects invalid status code (too low)', () => {
    expect(() =>
      tunnelOutputSchema.parse({ type: 'http_response', id: 'r1', status: 99 }),
    ).toThrow();
  });

  it('rejects invalid status code (too high)', () => {
    expect(() =>
      tunnelOutputSchema.parse({ type: 'http_response', id: 'r1', status: 600 }),
    ).toThrow();
  });

  it('rejects invalid error code', () => {
    expect(() =>
      tunnelOutputSchema.parse({ type: 'http_error', id: 'r1', code: 'unknown_error', message: 'oops' }),
    ).toThrow();
  });

  it('rejects port_list with invalid port', () => {
    expect(() =>
      tunnelOutputSchema.parse({ type: 'port_list', ports: [{ port: -1 }] }),
    ).toThrow();
  });
});

describe('round-trip parsing', () => {
  it('parses and re-parses http_request', () => {
    const input: TunnelInput = {
      type: 'http_request',
      id: 'test-1',
      method: 'POST',
      port: 3000,
      path: '/api/test',
      headers: { 'Content-Type': 'application/json' },
      bodyBase64: 'dGVzdA==',
    };
    const parsed = tunnelInputSchema.parse(input);
    expect(tunnelInputSchema.parse(parsed)).toEqual(input);
  });

  it('parses and re-parses http_response', () => {
    const output: TunnelOutput = {
      type: 'http_response',
      id: 'test-1',
      status: 200,
      statusText: 'OK',
      headers: { 'X-Custom': 'value' },
      bodyBase64: 'cmVzcG9uc2U=',
    };
    const parsed = tunnelOutputSchema.parse(output);
    expect(tunnelOutputSchema.parse(parsed)).toEqual(output);
  });
});
