import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import WebSocket from 'ws';
import {
  encodePairing,
  decodePairing,
  encodeEnvelope,
  decodeEnvelope,
  peekMessageKind,
  generateKey,
  genEphemeralKeyPair,
  genPairCode,
  genSalt,
  commit,
  verifyCommit,
  wrapKey,
  unwrapKey,
  encrypt,
  decrypt,
  type EphemeralKeyPair,
  type Envelope,
} from '@bedcoder/protocol';

const repoRoot = path.resolve(import.meta.dirname, '../..');

export function hasGo(): boolean {
  try {
    execSync('go version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Start the real relay binary via `go run` and wait for /health.
export async function startRelay(port: number): Promise<ChildProcess> {
  const proc = spawn('go', ['run', './cmd/relay'], {
    cwd: path.join(repoRoot, 'relay'),
    env: { ...process.env, BEDCODER_ADDR: `:${port}`, BEDCODER_DB: ':memory:' },
    stdio: 'ignore',
    detached: true, // own process group so we can kill go run + the compiled binary
  });
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  throw new Error('relay did not become healthy in time');
}

export function stopRelay(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL'); // kill the whole process group
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

export function openWs(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  ws.binaryType = 'nodebuffer';
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// A protocol-correct agent that mirrors the real agent's pairing + a FakeEngine
// echo, used to drive the relay end-to-end.
export class AgentClient {
  readonly key = generateKey();
  readonly code = genPairCode();
  private readonly eph: EphemeralKeyPair = genEphemeralKeyPair();
  private readonly salt = genSalt();
  private appPub?: Uint8Array;

  constructor(
    private readonly ws: WebSocket,
    readonly sid: string,
  ) {
    ws.on('message', (d: Buffer) => this.onMessage(new Uint8Array(d)));
  }

  register(): void {
    this.ws.send(encodePairing({ type: 'register', code: this.code, commit: commit(this.eph.publicKey, this.salt) }));
  }

  private onMessage(data: Uint8Array): void {
    if (peekMessageKind(data) === 'pairing') {
      const m = decodePairing(data);
      if (m.type === 'responder') {
        this.appPub = m.appEphPub;
        this.ws.send(encodePairing({ type: 'reveal', agentEphPub: this.eph.publicKey, salt: this.salt }));
      } else if (m.type === 'confirm' && this.appPub) {
        this.ws.send(encodePairing({ type: 'key', wrappedKey: wrapKey(this.key, this.appPub, this.eph.secretKey) }));
      }
      return;
    }
    if (peekMessageKind(data) === 'envelope') {
      const env = decodeEnvelope(data);
      const payload = decrypt<{ type: string; text: string }>(env.encrypted, this.key);
      if (payload.type === 'message') {
        const reply: Envelope = {
          v: 1,
          sid: this.sid,
          from: 'agent',
          ch: 'terminal',
          seq: 0,
          ts: Math.floor(Date.now() / 1000),
          encrypted: encrypt({ type: 'content', role: 'assistant', text: `echo: ${payload.text}` }, this.key),
        };
        this.ws.send(encodeEnvelope(reply));
      }
    }
  }
}

// A protocol-correct app that runs the commitment + SAS handshake and exchanges
// messages, mirroring the Flutter app.
export class AppClient {
  private readonly eph: EphemeralKeyPair = genEphemeralKeyPair();
  private commitBytes?: Uint8Array;
  private agentPub?: Uint8Array;
  sid?: string;
  key?: Uint8Array;

  private pairedResolve!: () => void;
  readonly paired: Promise<void> = new Promise((r) => (this.pairedResolve = r));
  private contentResolvers: ((text: string) => void)[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly code: string,
  ) {
    ws.on('message', (d: Buffer) => this.onMessage(new Uint8Array(d)));
  }

  claim(): void {
    this.ws.send(encodePairing({ type: 'claim', code: this.code }));
  }

  sendMessage(text: string): void {
    const env: Envelope = {
      v: 1,
      sid: this.sid!,
      from: 'app',
      ch: 'terminal',
      seq: 0,
      ts: Math.floor(Date.now() / 1000),
      encrypted: encrypt({ type: 'message', text }, this.key!),
    };
    this.ws.send(encodeEnvelope(env));
  }

  nextContent(): Promise<string> {
    return new Promise((resolve) => this.contentResolvers.push(resolve));
  }

  private onMessage(data: Uint8Array): void {
    if (peekMessageKind(data) === 'pairing') {
      const m = decodePairing(data);
      switch (m.type) {
        case 'commit':
          this.commitBytes = m.commit;
          this.sid = m.sid;
          this.ws.send(encodePairing({ type: 'responder', appEphPub: this.eph.publicKey }));
          break;
        case 'reveal':
          if (!this.commitBytes || !verifyCommit(this.commitBytes, m.agentEphPub, m.salt)) {
            throw new Error('commitment mismatch (MITM)');
          }
          this.agentPub = m.agentEphPub;
          this.ws.send(encodePairing({ type: 'confirm' })); // auto-confirm SAS in the test
          break;
        case 'key':
          this.key = unwrapKey(m.wrappedKey, this.agentPub!, this.eph.secretKey);
          this.pairedResolve();
          break;
        default:
          break;
      }
      return;
    }
    if (peekMessageKind(data) === 'envelope') {
      const env = decodeEnvelope(data);
      const payload = decrypt<{ type: string; text: string }>(env.encrypted, this.key!);
      if (payload.type === 'content') this.contentResolvers.shift()?.(payload.text);
    }
  }
}
