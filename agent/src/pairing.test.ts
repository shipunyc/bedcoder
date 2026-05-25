import { describe, it, expect } from 'vitest';
import {
  generateKey,
  genEphemeralKeyPair,
  deriveSAS,
  unwrapKey,
  type PairingMessage,
} from '@bedcoder/protocol';
import { AgentPairing, type PairingTransport } from './pairing';

class FakeTransport implements PairingTransport {
  sent: PairingMessage[] = [];
  private handler: (m: PairingMessage) => void = () => {};
  onPairing(h: (m: PairingMessage) => void): void {
    this.handler = h;
  }
  sendPairing(m: PairingMessage): void {
    this.sent.push(m);
  }
  inject(m: PairingMessage): void {
    this.handler(m);
  }
}

function asType<T extends PairingMessage['type']>(
  m: PairingMessage,
  type: T,
): Extract<PairingMessage, { type: T }> {
  if (m.type !== type) throw new Error(`expected ${type}, got ${m.type}`);
  return m as Extract<PairingMessage, { type: T }>;
}

describe('AgentPairing', () => {
  it('runs the commitment + SAS handshake and wraps K for the app', () => {
    const key = generateKey();
    const transport = new FakeTransport();
    const app = genEphemeralKeyPair();
    let sas = '';
    let paired = false;

    const pairing = new AgentPairing(transport, key, {
      onSAS: (s) => {
        sas = s;
      },
      onPaired: () => {
        paired = true;
      },
    });
    pairing.start();

    expect(asType(transport.sent[0]!, 'register').code).toBe(pairing.code);

    transport.inject({ type: 'responder', appEphPub: app.publicKey });
    const reveal = asType(transport.sent[1]!, 'reveal');
    expect(sas).toBe(deriveSAS(reveal.agentEphPub, app.publicKey));

    transport.inject({ type: 'confirm' });
    const keyMsg = asType(transport.sent[2]!, 'key');
    const unwrapped = unwrapKey(keyMsg.wrappedKey, reveal.agentEphPub, app.secretKey);
    expect([...unwrapped]).toEqual([...key]);
    expect(paired).toBe(true);
  });
});
