import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { TunnelChannel, type TunnelTransport } from './tunnel';
import type { Session } from '../session';
import type { TunnelInput, Envelope, Channel } from '@bedcoder/protocol';
import { encodeEnvelope } from '@bedcoder/protocol';

// ============================================================================
// Test HTTP Server
// ============================================================================

let testServer: Server;
let testPort: number;

beforeAll(async () => {
  testServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello from test server');
  });

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
// Mocks
// ============================================================================

class MockSession {
  sessionId = 'test-session';
  seqOut = 0;
  decoded: { channel: Channel; payload: unknown }[] = [];

  encode(channel: Channel, payload: unknown): Uint8Array {
    return encodeEnvelope({
      v: 1,
      sid: this.sessionId,
      from: 'agent',
      ch: channel,
      seq: this.seqOut++,
      ts: Math.floor(Date.now() / 1000),
      encrypted: new Uint8Array(JSON.stringify(payload).split('').map((c) => c.charCodeAt(0))),
    });
  }

  decode<T>(_raw: Uint8Array): { channel: Channel; payload: T; seq: number } {
    // For testing, we just parse the envelope and extract the payload
    // In real code, this would decrypt
    const lastDecoded = this.decoded[this.decoded.length - 1];
    return {
      channel: lastDecoded?.channel as Channel ?? 'tunnel',
      payload: lastDecoded?.payload as T,
      seq: 0,
    };
  }

  // Helper to simulate receiving a message
  simulateReceive(channel: Channel, payload: unknown): void {
    this.decoded.push({ channel, payload });
  }
}

class MockTransport {
  sent: Uint8Array[] = [];
  private handlers: ((raw: Uint8Array, env: Envelope) => void)[] = [];

  sendRaw(raw: Uint8Array): void {
    this.sent.push(raw);
  }

  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void {
    this.handlers.push(handler);
  }

  // Helper to simulate receiving a message
  simulateEnvelope(env: Envelope, raw?: Uint8Array): void {
    const data = raw ?? encodeEnvelope(env);
    for (const h of this.handlers) {
      h(data, env);
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

// Port-list emits are async now (probe → filter → emit). Flush the microtask
// queue so they land before assertions.
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// A probe that classifies nothing as web, so tests stay offline + deterministic.
const noWeb = async (): Promise<undefined> => undefined;

describe('TunnelChannel', () => {
  let session: MockSession;
  let transport: MockTransport;
  let channel: TunnelChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new MockSession();
    transport = new MockTransport();
    channel = new TunnelChannel(
      session as unknown as Session,
      transport as unknown as TunnelTransport,
      { portScanIntervalMs: 1000, httpTimeoutMs: 5000, probeScheme: noWeb },
    );
  });

  afterEach(() => {
    channel.stop();
    vi.useRealTimers();
  });

  it('creates without error', () => {
    expect(channel).toBeDefined();
  });

  it('starts and sends initial port list', async () => {
    channel.start(1000);
    await flush(); // the port_list emit is async (probe → emit)

    // Should have sent at least one message (initial port list)
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
  });

  it('stops without error', () => {
    channel.start(1000);
    channel.stop();
    expect(true).toBe(true);
  });

  it('ignores non-tunnel envelopes', () => {
    channel.start(1000);

    // Simulate receiving a terminal message
    const env: Envelope = {
      v: 1,
      sid: 'test',
      from: 'app',
      ch: 'terminal',
      seq: 0,
      ts: Date.now(),
      encrypted: new Uint8Array([]),
    };
    session.simulateReceive('terminal', { type: 'message', text: 'hi' });
    transport.simulateEnvelope(env);

    // Should not crash, and should not process the message
    expect(true).toBe(true);
  });
});

describe('TunnelChannel HTTP requests', () => {
  let session: MockSession;
  let transport: MockTransport;
  let channel: TunnelChannel;

  beforeEach(() => {
    session = new MockSession();
    transport = new MockTransport();
    channel = new TunnelChannel(
      session as unknown as Session,
      transport as unknown as TunnelTransport,
      { portScanIntervalMs: 60000, httpTimeoutMs: 5000, probeScheme: noWeb },
    );
  });

  afterEach(() => {
    channel.stop();
  });

  it('proxies HTTP request to local server', async () => {
    channel.start(60000);
    transport.sent = []; // Clear initial port list

    // Simulate receiving an HTTP request
    const input: TunnelInput = {
      type: 'http_request',
      id: 'req-1',
      method: 'GET',
      port: testPort,
      path: '/',
    };

    const env: Envelope = {
      v: 1,
      sid: 'test',
      from: 'app',
      ch: 'tunnel',
      seq: 0,
      ts: Date.now(),
      encrypted: new Uint8Array([]),
    };
    session.simulateReceive('tunnel', input);
    transport.simulateEnvelope(env);

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should have sent a response
    expect(transport.sent.length).toBeGreaterThan(0);
  });

  it('handles refresh_ports request', async () => {
    channel.start(60000);
    transport.sent = []; // Clear initial port list

    const input: TunnelInput = { type: 'refresh_ports' };

    const env: Envelope = {
      v: 1,
      sid: 'test',
      from: 'app',
      ch: 'tunnel',
      seq: 0,
      ts: Date.now(),
      encrypted: new Uint8Array([]),
    };
    session.simulateReceive('tunnel', input);
    transport.simulateEnvelope(env);
    await flush(); // the port_list emit is async (probe → emit)

    // Should have sent a port_list response
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Preview token + hosted-port filtering
// ============================================================================

describe('TunnelChannel preview token + hosted-port filter', () => {
  let session: MockSession;
  let transport: MockTransport;

  beforeEach(() => {
    session = new MockSession();
    transport = new MockTransport();
  });

  // The MockSession encodes a payload as the char codes of its JSON, embedded in
  // the messagepack envelope. Recover each sent payload by scanning for the JSON.
  function sentPayloads(): { type: string; token?: string; ports?: unknown[] }[] {
    return transport.sent.map((raw) => {
      const text = Buffer.from(raw).toString('latin1');
      const start = text.indexOf('{"type"');
      if (start < 0) return { type: 'unknown' };
      try {
        return JSON.parse(text.slice(start));
      } catch {
        return { type: 'unknown' };
      }
    });
  }

  it('announces the preview token on start', () => {
    const channel = new TunnelChannel(session as unknown as Session, transport as unknown as TunnelTransport, {
      portScanIntervalMs: 60000,
      previewToken: 'tok-abc',
      probeScheme: noWeb,
    });
    channel.start(60000);
    // preview_info is emitted synchronously, before the async port_list.
    const tokens = sentPayloads().filter((p) => p.type === 'preview_info');
    expect(tokens[0]?.token).toBe('tok-abc');
    channel.stop();
  });

  it('re-announces the preview token on refresh_ports (app connects after boot)', () => {
    const channel = new TunnelChannel(session as unknown as Session, transport as unknown as TunnelTransport, {
      portScanIntervalMs: 60000,
      previewToken: 'tok-abc',
      probeScheme: noWeb,
    });
    channel.start(60000);
    transport.sent = []; // drop the start-time announcement

    const env: Envelope = { v: 1, sid: 'test', from: 'app', ch: 'tunnel', seq: 0, ts: Date.now(), encrypted: new Uint8Array([]) };
    session.simulateReceive('tunnel', { type: 'refresh_ports' } as TunnelInput);
    transport.simulateEnvelope(env);

    expect(sentPayloads().some((p) => p.type === 'preview_info' && p.token === 'tok-abc')).toBe(true);
    channel.stop();
  });

  it('shows only hosted ports: an empty ownedPids set yields an empty port list', async () => {
    const channel = new TunnelChannel(session as unknown as Session, transport as unknown as TunnelTransport, {
      portScanIntervalMs: 60000,
      ownedPids: () => new Set<number>(), // own nothing → filter drops every port
      probeScheme: noWeb,
    });
    channel.start(60000);
    await flush(); // the port_list emit is async

    const portLists = sentPayloads().filter((p) => p.type === 'port_list');
    expect(portLists.length).toBeGreaterThanOrEqual(1);
    for (const pl of portLists) expect(pl.ports).toEqual([]);
    channel.stop();
  });
});
