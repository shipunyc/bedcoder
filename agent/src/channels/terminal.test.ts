import { describe, it, expect } from 'vitest';
import { generateKey, decodeEnvelope, type Envelope } from '@bedcoder/protocol';
import { Session } from '../session';
import { FakeEngine } from '../claude/engine';
import { TerminalChannel, type SessionTransport } from './terminal';

class FakeTransport implements SessionTransport {
  outbox: Uint8Array[] = [];
  private handler: (raw: Uint8Array, env: Envelope) => void = () => {};
  sendRaw(raw: Uint8Array): void {
    this.outbox.push(raw);
  }
  onEnvelope(h: (raw: Uint8Array, env: Envelope) => void): void {
    this.handler = h;
  }
  deliver(raw: Uint8Array): void {
    this.handler(raw, decodeEnvelope(raw));
  }
}

describe('TerminalChannel', () => {
  it('feeds app messages to the engine and relays engine output encrypted', () => {
    const key = generateKey();
    const agentSession = new Session('S1', key);
    const appSession = new Session('S1', key);
    const transport = new FakeTransport();

    new TerminalChannel(agentSession, transport, () => new FakeEngine(), {
      initial: { sessionId: 'S1', resume: false },
    }).start();

    transport.deliver(appSession.encode('terminal', { type: 'message', text: 'hi' }));

    const outputs = transport.outbox.map((raw) => appSession.decode(raw).payload) as Array<Record<string, unknown>>;
    expect(outputs).toContainEqual({ type: 'content', role: 'assistant', text: 'echo: hi' });
    expect(outputs.some((o) => o.type === 'status' && o.state === 'idle')).toBe(true);
  });

  it('ignores envelopes for other channels', () => {
    const key = generateKey();
    const session = new Session('S1', key);
    const transport = new FakeTransport();
    new TerminalChannel(session, transport, () => new FakeEngine(), {
      initial: { sessionId: 'S1', resume: false },
    }).start();

    transport.deliver(session.encode('files', { type: 'message', text: 'nope' }));
    expect(transport.outbox).toHaveLength(0);
  });
});
