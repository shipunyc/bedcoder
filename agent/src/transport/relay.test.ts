import { describe, it, expect } from 'vitest';
import {
  encodePairing,
  encodeEnvelope,
  generateKey,
  encrypt,
  type PairingMessage,
} from '@bedcoder/protocol';
import { RelayClient, type RelaySocket, type Gap } from './relay';

class FakeSocket implements RelaySocket {
  sent: Uint8Array[] = [];
  closed = false;
  private msgCb: (d: Uint8Array) => void = () => {};
  private openCb: () => void = () => {};
  private closeCb: () => void = () => {};
  send(d: Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.closeCb();
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (d: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  open(): void {
    this.openCb();
  }
  emit(d: Uint8Array): void {
    this.msgCb(d);
  }
  drop(): void {
    this.closeCb(); // simulate an unexpected close
  }
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function tracking(): { factory: (url: string) => FakeSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  };
}

function envelope(from: 'agent' | 'app', seq: number): Uint8Array {
  return encodeEnvelope({
    v: 1,
    sid: 'S1',
    from,
    ch: 'terminal',
    seq,
    ts: 1,
    encrypted: encrypt({}, generateKey()),
  });
}

describe('RelayClient', () => {
  it('dispatches pairing vs envelope frames', async () => {
    const { factory, sockets } = tracking();
    const client = new RelayClient('ws://x/ws', factory);
    const p = client.connect();
    sockets[0]!.open();
    await p;

    let pairing: PairingMessage | undefined;
    let envelopes = 0;
    client.onPairing((m) => (pairing = m));
    client.onEnvelope(() => envelopes++);

    sockets[0]!.emit(encodePairing({ type: 'claim', code: 'ABCD2345' }));
    expect(pairing?.type).toBe('claim');
    sockets[0]!.emit(envelope('app', 0));
    expect(envelopes).toBe(1);
  });

  it('fans envelopes out to every subscriber (channels share one client)', async () => {
    const { factory, sockets } = tracking();
    const client = new RelayClient('ws://x/ws', factory);
    const p = client.connect();
    sockets[0]!.open();
    await p;

    // Mirrors index.ts: terminal/tunnel/files/mirror each subscribe. A single
    // handler would let the last subscriber clobber the terminal channel.
    let a = 0;
    let b = 0;
    let c = 0;
    client.onEnvelope(() => a++);
    client.onEnvelope(() => b++);
    client.onEnvelope(() => c++);

    sockets[0]!.emit(envelope('app', 0));
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('buffers frames before open and flushes them on connect', async () => {
    const { factory, sockets } = tracking();
    const client = new RelayClient('ws://x/ws', factory);
    client.sendRaw(new Uint8Array([1]));
    client.sendPairing({ type: 'confirm' });

    const p = client.connect();
    expect(sockets[0]!.sent).toHaveLength(0); // not open yet
    sockets[0]!.open();
    await p;
    expect(sockets[0]!.sent).toHaveLength(2); // flushed in order
  });

  it('reconnects after an unexpected close and flushes the outbox', async () => {
    const { factory, sockets } = tracking();
    const client = new RelayClient('ws://x/ws', factory, { reconnectDelayMs: 5 });
    const p = client.connect();
    sockets[0]!.open();
    await p;

    sockets[0]!.drop(); // connection lost
    client.sendRaw(new Uint8Array([9])); // buffered while down

    await tick();
    expect(sockets).toHaveLength(2); // re-dialed
    sockets[1]!.open();
    expect(sockets[1]!.sent).toHaveLength(1);
    expect([...sockets[1]!.sent[0]!]).toEqual([9]);
  });

  it('does not reconnect after close()', async () => {
    const { factory, sockets } = tracking();
    const client = new RelayClient('ws://x/ws', factory, { reconnectDelayMs: 5 });
    const p = client.connect();
    sockets[0]!.open();
    await p;

    client.close();
    await tick();
    expect(sockets).toHaveLength(1);
  });

  it('detects an inbound sequence gap', async () => {
    const { factory, sockets } = tracking();
    const gaps: Gap[] = [];
    const client = new RelayClient('ws://x/ws', factory, { onGap: (g) => gaps.push(g) });
    const p = client.connect();
    sockets[0]!.open();
    await p;
    client.onEnvelope(() => {});

    sockets[0]!.emit(envelope('app', 0));
    sockets[0]!.emit(envelope('app', 1));
    expect(gaps).toHaveLength(0);
    sockets[0]!.emit(envelope('app', 3)); // skipped seq 2
    expect(gaps).toEqual([{ from: 'app', expected: 2, got: 3 }]);
  });
});
