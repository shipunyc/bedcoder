import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type WebSocket from 'ws';
import {
  encodeEnvelope,
  decodeEnvelope,
  encodePreview,
  decodePreview,
  peekMessageKind,
  encrypt,
  decrypt,
  generateKey,
  type Channel,
  type Envelope,
  type PreviewFrame,
} from '@bedcoder/protocol';

// The real agent-side channel implementations, wired to the real relay.
import { Session } from '../../agent/src/session';
import { TunnelChannel } from '../../agent/src/channels/tunnel';
import { FilesChannel } from '../../agent/src/channels/files';
import { MirrorChannel } from '../../agent/src/channels/mirror';
import { TerminalManager } from '../../agent/src/terminal/manager';
import { TerminalTracker } from '../../agent/src/terminal/tracker';
import { PreviewProxy } from '../../agent/src/tunnel/preview';

import { hasGo, startRelay, stopRelay, openWs } from './helpers';
import type { ChildProcess } from 'node:child_process';

const PORT = 18130;
const RELAY = `ws://localhost:${PORT}`;

// Agent-side transport adapter: fans inbound envelopes to channel handlers and
// writes raw frames to the relay (satisfies the channels' transport interface).
class WsTransport {
  private handlers: ((raw: Uint8Array, env: Envelope) => void)[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (d: Buffer) => {
      const raw = new Uint8Array(d);
      if (peekMessageKind(raw) !== 'envelope') return;
      const env = decodeEnvelope(raw);
      for (const h of this.handlers) h(raw, env);
    });
  }
  sendRaw(raw: Uint8Array): void {
    this.ws.send(raw);
  }
  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void {
    this.handlers.push(handler);
  }
}

// App-side helper: send channel payloads and await a matching decrypted reply.
class AppClient {
  constructor(
    private readonly ws: WebSocket,
    private readonly sid: string,
    private readonly key: Uint8Array,
  ) {}

  send(ch: Channel, payload: unknown): void {
    const env: Envelope = {
      v: 1,
      sid: this.sid,
      from: 'app',
      ch,
      seq: 0,
      ts: Math.floor(Date.now() / 1000),
      encrypted: encrypt(payload, this.key),
    };
    this.ws.send(encodeEnvelope(env));
  }

  // Resolve with the first payload on `ch` that satisfies `match`.
  waitFor<T = Record<string, unknown>>(ch: string, match: (p: T) => boolean, timeoutMs = 8000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.off('message', onMsg);
        reject(new Error(`timed out waiting for a ${ch} message`));
      }, timeoutMs);
      const onMsg = (d: Buffer): void => {
        const raw = new Uint8Array(d);
        if (peekMessageKind(raw) !== 'envelope') return;
        const env = decodeEnvelope(raw);
        if (env.ch !== ch) return;
        const payload = decrypt<T>(env.encrypted, this.key);
        if (match(payload)) {
          clearTimeout(timer);
          this.ws.off('message', onMsg);
          resolve(payload);
        }
      };
      this.ws.on('message', onMsg);
    });
  }
}

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf-8');

// Agent-side transport for preview control frames over the agent's WebSocket.
class WsPreviewTransport {
  private handler: (f: PreviewFrame) => void = () => {};
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (d: Buffer) => {
      const raw = new Uint8Array(d);
      if (peekMessageKind(raw) === 'preview') this.handler(decodePreview(raw));
    });
  }
  onPreview(h: (f: PreviewFrame) => void): void {
    this.handler = h;
  }
  sendPreview(f: PreviewFrame): void {
    this.ws.send(encodePreview(f));
  }
}

describe.skipIf(!hasGo())('Phase 2 channels over the real relay', () => {
  let relay: ChildProcess;

  beforeAll(async () => {
    relay = await startRelay(PORT);
  }, 60000);

  afterAll(() => {
    if (relay) stopRelay(relay);
  });

  // Per-test connections, torn down after each case.
  const open: WebSocket[] = [];
  async function pair(): Promise<{ sid: string; key: Uint8Array; agent: WsTransport; app: AppClient }> {
    const sid = randomUUID();
    const key = generateKey();
    const agentWs = await openWs(`${RELAY}/ws?role=agent&sid=${sid}`);
    const appWs = await openWs(`${RELAY}/ws?role=app&sid=${sid}`);
    open.push(agentWs, appWs);
    return { sid, key, agent: new WsTransport(agentWs), app: new AppClient(appWs, sid, key) };
  }

  afterEach(() => {
    for (const ws of open.splice(0)) ws.close();
  });

  it('tunnel: proxies an HTTP GET to a local server', async () => {
    // A local "dev server".
    const server: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello tunnel');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const { key, sid, agent, app } = await pair();
    const channel = new TunnelChannel(new Session(sid, key), agent);
    channel.start(3_600_000); // avoid repeated port scans during the test

    try {
      const responsePromise = app.waitFor<Record<string, unknown>>(
        'tunnel',
        (p) => p.type === 'http_response' && p.id === 'req-1',
      );
      app.send('tunnel', { type: 'http_request', id: 'req-1', method: 'GET', port, path: '/' });
      const res = await responsePromise;
      expect(res.status).toBe(200);
      expect(unb64(res.bodyBase64 as string)).toBe('hello tunnel');
    } finally {
      channel.stop();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('tunnel: reports connection_refused for a dead port', async () => {
    const { key, sid, agent, app } = await pair();
    const channel = new TunnelChannel(new Session(sid, key), agent);
    channel.start(3_600_000);
    try {
      const errPromise = app.waitFor<Record<string, unknown>>(
        'tunnel',
        (p) => p.type === 'http_error' && p.id === 'req-x',
      );
      // Port 1 is not listening.
      app.send('tunnel', { type: 'http_request', id: 'req-x', method: 'GET', port: 1, path: '/' });
      const err = await errPromise;
      expect(err.code).toBe('connection_refused');
    } finally {
      channel.stop();
    }
  });

  it('files: ls, write, and read within the sandbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bedcoder-e2e-'));
    writeFileSync(join(root, 'a.txt'), 'hello');

    const { key, sid, agent, app } = await pair();
    new FilesChannel(new Session(sid, key), agent, { root }).start();

    try {
      // ls
      const ls = await (() => {
        const p = app.waitFor<Record<string, unknown>>('files', (m) => m.type === 'ls_result' && m.id === 'l1');
        app.send('files', { type: 'ls', id: 'l1', path: '.' });
        return p;
      })();
      const names = (ls.entries as { name: string }[]).map((e) => e.name);
      expect(names).toContain('a.txt');

      // write
      const ok = await (() => {
        const p = app.waitFor<Record<string, unknown>>('files', (m) => m.type === 'ok' && m.id === 'w1');
        app.send('files', { type: 'write', id: 'w1', path: 'b.txt', contentBase64: b64('world') });
        return p;
      })();
      expect(ok.type).toBe('ok');
      expect(readFileSync(join(root, 'b.txt'), 'utf-8')).toBe('world');

      // read it back
      const read = await (() => {
        const p = app.waitFor<Record<string, unknown>>('files', (m) => m.type === 'read_result' && m.id === 'r1');
        app.send('files', { type: 'read', id: 'r1', path: 'b.txt' });
        return p;
      })();
      expect(unb64(read.contentBase64 as string)).toBe('world');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('files: rejects a path-traversal escape', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bedcoder-e2e-'));
    const { key, sid, agent, app } = await pair();
    new FilesChannel(new Session(sid, key), agent, { root }).start();
    try {
      const err = await (() => {
        const p = app.waitFor<Record<string, unknown>>('files', (m) => m.type === 'error' && m.id === 'e1');
        app.send('files', { type: 'read', id: 'e1', path: '../../../etc/passwd' });
        return p;
      })();
      expect(err.code).toBe('invalid_path');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mirror: a tracked bash command surfaces as a terminal with output', async () => {
    const { key, sid, agent, app } = await pair();
    const manager = new TerminalManager();
    const tracker = new TerminalTracker(manager);
    new MirrorChannel(new Session(sid, key), agent, manager).start();

    try {
      // The SDK runs a Bash tool → register a running terminal.
      const listP = app.waitFor<Record<string, unknown>>(
        'terminal',
        (p) => p.type === 'terminal_list' && (p.terminals as unknown[]).length === 1,
      );
      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'echo hi' } }] },
      });
      const list = await listP;
      const terminals = list.terminals as { command: string; state: string }[];
      expect(terminals[0]!.command).toBe('echo hi');
      expect(terminals[0]!.state).toBe('running');

      // The tool result arrives → output is streamed and the terminal exits.
      const outP = app.waitFor<Record<string, unknown>>(
        'terminal',
        (p) => p.type === 'terminal_output' && (p.data as string).includes('hi'),
      );
      const exitedP = app.waitFor<Record<string, unknown>>(
        'terminal',
        (p) => p.type === 'terminal_list' && (p.terminals as { state: string }[])[0]?.state === 'exited',
      );
      tracker.track({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hi\n' }] },
      });
      const out = await outP;
      expect(out.terminalId).toBeDefined();
      await exitedP;
    } finally {
      manager.destroy();
      await delay(10);
    }
  });

  it('preview: relay reverse-proxies a public URL to the agent', async () => {
    const server: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello preview e2e');
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    const sid = randomUUID();
    const agentWs = await openWs(`${RELAY}/ws?role=agent&sid=${sid}`);
    open.push(agentWs);
    const proxy = new PreviewProxy(new WsPreviewTransport(agentWs), 'tok-e2e');
    proxy.start(); // claims the token with the relay

    try {
      // Retry until the relay has processed the register, then GET via the
      // public preview URL (relay HTTP → agent WS → localhost:port).
      let status = 0;
      let body = '';
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`http://localhost:${PORT}/p/tok-e2e/${port}/`);
        status = res.status;
        if (status === 200) {
          body = await res.text();
          break;
        }
        await res.text();
        await delay(50);
      }
      expect(status).toBe(200);
      expect(body).toContain('hello preview e2e');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
