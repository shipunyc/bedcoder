import { z } from 'zod';

// Tunnel channel payloads (DESIGN §4.3). These enable HTTP proxy functionality
// for the Preview Tab, allowing mobile app to browse local dev servers.

// ============================================================================
// Port Discovery (Agent → App)
// ============================================================================

// A listening port discovered on the agent's machine.
export const listeningPortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().optional(), // Process ID if available
  process: z.string().optional(), // Process name (e.g., 'node', 'python')
  cmdline: z.string().optional(), // Command line snippet
  // The protocol the port speaks, detected by probing. Only browser-openable
  // ports (http/https) are reported; non-web ports are omitted from port_list.
  scheme: z.enum(['http', 'https']).optional(),
});
export type ListeningPort = z.infer<typeof listeningPortSchema>;

// ============================================================================
// HTTP Tunnel Request/Response (App ↔ Agent)
// ============================================================================

// Supported HTTP methods for tunneling.
export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

// HTTP headers as key-value pairs. Values can be string or string[] for multi-value headers.
export const httpHeadersSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]));
export type HttpHeaders = z.infer<typeof httpHeadersSchema>;

// ============================================================================
// Tunnel Channel Messages
// ============================================================================

// App → Agent: Request to proxy an HTTP request to localhost.
export const tunnelInputSchema = z.discriminatedUnion('type', [
  // HTTP proxy request.
  z.object({
    type: z.literal('http_request'),
    id: z.string(), // Request ID for correlating response
    method: httpMethodSchema,
    port: z.number().int().min(1).max(65535),
    path: z.string(), // URL path including query string (e.g., '/api/users?page=1')
    headers: httpHeadersSchema.optional(),
    // Body as base64 for binary safety. Empty string or omitted for bodyless requests.
    bodyBase64: z.string().optional(),
  }),
  // Request to refresh the port list.
  z.object({
    type: z.literal('refresh_ports'),
  }),
]);
export type TunnelInput = z.infer<typeof tunnelInputSchema>;

// Agent → App: Responses from the tunnel channel.
export const tunnelOutputSchema = z.discriminatedUnion('type', [
  // List of currently listening ports on the agent's machine.
  z.object({
    type: z.literal('port_list'),
    ports: z.array(listeningPortSchema),
  }),
  // HTTP response from the proxied request.
  z.object({
    type: z.literal('http_response'),
    id: z.string(), // Correlates with the request ID
    status: z.number().int().min(100).max(599),
    statusText: z.string().optional(),
    headers: httpHeadersSchema.optional(),
    // Body as base64 for binary safety.
    bodyBase64: z.string().optional(),
  }),
  // Error occurred while processing the request.
  z.object({
    type: z.literal('http_error'),
    id: z.string(), // Correlates with the request ID
    code: z.enum([
      'connection_refused', // Target port not listening
      'timeout', // Request timed out
      'network_error', // Generic network error
      'invalid_request', // Malformed request
      'body_too_large', // Response body exceeds limit
    ]),
    message: z.string(),
  }),
  // The session's preview token: the app builds https://<relay>/p/<token>/<port>/
  // and opens it in a browser (the relay reverse-proxies to the agent).
  z.object({
    type: z.literal('preview_info'),
    token: z.string(),
  }),
]);
export type TunnelOutput = z.infer<typeof tunnelOutputSchema>;

// ============================================================================
// Parser Functions
// ============================================================================

export const parseTunnelInput = (u: unknown): TunnelInput => tunnelInputSchema.parse(u);
export const parseTunnelOutput = (u: unknown): TunnelOutput => tunnelOutputSchema.parse(u);
