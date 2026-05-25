import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MirrorChannel, type MirrorTransport } from './mirror';
import { TerminalManager } from '../terminal/manager';
import type { Session } from '../session';
import type { TerminalInput, TerminalOutput, Envelope } from '@bedcoder/protocol';

// Mock Session
function createMockSession(): Session {
  return {
    sid: 'test-session',
    encode: vi.fn((channel, payload) => {
      // Return a fake encoded message that includes the payload for inspection
      return new TextEncoder().encode(JSON.stringify({ channel, payload }));
    }),
    decode: vi.fn(<T>(raw: Uint8Array) => {
      // Parse the raw message (assuming it's JSON for testing)
      const str = new TextDecoder().decode(raw);
      return { env: {} as Envelope, payload: JSON.parse(str) as T };
    }),
  } as unknown as Session;
}

// Mock Transport
function createMockTransport(): MirrorTransport & {
  sent: Uint8Array[];
  handlers: Array<(raw: Uint8Array, env: Envelope) => void>;
  simulateEnvelope: (input: TerminalInput) => void;
} {
  const sent: Uint8Array[] = [];
  const handlers: Array<(raw: Uint8Array, env: Envelope) => void> = [];

  return {
    sent,
    handlers,
    sendRaw: vi.fn((raw: Uint8Array) => sent.push(raw)),
    onEnvelope: (handler) => handlers.push(handler),
    simulateEnvelope: (input: TerminalInput) => {
      const raw = new TextEncoder().encode(JSON.stringify(input));
      const env: Envelope = { v: 1, sid: 'test', from: 'app', ch: 'terminal', seq: 0, ts: 0, encrypted: new Uint8Array() };
      for (const handler of handlers) {
        handler(raw, env);
      }
    },
  };
}

function parseOutput(raw: Uint8Array): { channel: string; payload: TerminalOutput } {
  return JSON.parse(new TextDecoder().decode(raw));
}

// Narrow the output union to the variant a test is asserting on.
type TerminalListOut = Extract<TerminalOutput, { type: 'terminal_list' }>;
type TerminalOut = Extract<TerminalOutput, { type: 'terminal_output' }>;

describe('MirrorChannel', () => {
  let manager: TerminalManager;
  let session: Session;
  let transport: ReturnType<typeof createMockTransport>;
  let channel: MirrorChannel;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TerminalManager();
    session = createMockSession();
    transport = createMockTransport();
    channel = new MirrorChannel(session, transport, manager);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('sends initial terminal list', () => {
      channel.start();

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect(parsed.channel).toBe('terminal');
      expect(parsed.payload.type).toBe('terminal_list');
      expect((parsed.payload as TerminalListOut).terminals).toEqual([]);
    });

    it('does not double-start', () => {
      channel.start();
      channel.start();

      // Only one initial list
      expect(transport.sent.length).toBe(1);
    });
  });

  describe('terminal_list events', () => {
    it('sends terminal_list when terminal is registered', () => {
      channel.start();
      transport.sent.length = 0; // Clear initial list

      manager.register('npm test');

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect(parsed.payload.type).toBe('terminal_list');
      expect((parsed.payload as TerminalListOut).terminals).toHaveLength(1);
      expect((parsed.payload as TerminalListOut).terminals[0]!.command).toBe('npm test');
    });

    it('sends terminal_list when terminal exits', () => {
      channel.start();
      const id = manager.register('npm test');
      transport.sent.length = 0;

      manager.setExited(id, 0);

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect((parsed.payload as TerminalListOut).terminals[0]!.state).toBe('exited');
    });

    it('sends terminal_list when port is set', () => {
      channel.start();
      const id = manager.register('npm run dev');
      transport.sent.length = 0;

      manager.setPort(id, 3000);

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect((parsed.payload as TerminalListOut).terminals[0]!.port).toBe(3000);
    });
  });

  describe('terminal_output events', () => {
    it('sends terminal_output after throttle', () => {
      channel.start();
      const id = manager.register('npm test');
      transport.sent.length = 0;

      manager.appendOutput(id, 'Hello World\n');
      vi.advanceTimersByTime(200);

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect(parsed.payload.type).toBe('terminal_output');
      expect((parsed.payload as TerminalOut).terminalId).toBe(id);
      expect((parsed.payload as TerminalOut).data).toBe('Hello World\n');
      expect((parsed.payload as TerminalOut).seq).toBe(0);
    });

    it('batches multiple outputs', () => {
      channel.start();
      const id = manager.register('npm test');
      transport.sent.length = 0;

      manager.appendOutput(id, 'line1\n');
      manager.appendOutput(id, 'line2\n');
      manager.appendOutput(id, 'line3\n');
      vi.advanceTimersByTime(200);

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect((parsed.payload as TerminalOut).data).toBe('line1\nline2\nline3\n');
    });

    it('increments seq for each output batch', () => {
      channel.start();
      const id = manager.register('npm test');
      transport.sent.length = 0;

      manager.appendOutput(id, 'batch1');
      vi.advanceTimersByTime(200);

      manager.appendOutput(id, 'batch2');
      vi.advanceTimersByTime(200);

      expect(transport.sent.length).toBe(2);
      expect(parseOutput(transport.sent[0]!).payload).toMatchObject({ seq: 0 });
      expect(parseOutput(transport.sent[1]!).payload).toMatchObject({ seq: 1 });
    });
  });

  describe('terminal_input handling', () => {
    it('calls onTerminalInput callback', () => {
      const onTerminalInput = vi.fn();
      channel = new MirrorChannel(session, transport, manager, { onTerminalInput });
      channel.start();

      transport.simulateEnvelope({
        type: 'terminal_input',
        terminalId: 'term-1',
        data: 'hello',
      } as TerminalInput);

      expect(onTerminalInput).toHaveBeenCalledWith('term-1', 'hello');
    });

    it('does not throw without callback', () => {
      channel.start();

      expect(() => {
        transport.simulateEnvelope({
          type: 'terminal_input',
          terminalId: 'term-1',
          data: 'hello',
        } as TerminalInput);
      }).not.toThrow();
    });
  });

  describe('terminal_kill handling', () => {
    it('calls onTerminalKill callback', () => {
      const onTerminalKill = vi.fn();
      channel = new MirrorChannel(session, transport, manager, { onTerminalKill });
      channel.start();

      transport.simulateEnvelope({ type: 'terminal_kill', terminalId: 'term-1' } as TerminalInput);

      expect(onTerminalKill).toHaveBeenCalledWith('term-1');
    });

    it('does not throw without callback', () => {
      channel.start();
      expect(() => {
        transport.simulateEnvelope({ type: 'terminal_kill', terminalId: 'term-1' } as TerminalInput);
      }).not.toThrow();
    });
  });

  describe('terminal_resize handling', () => {
    it('calls onTerminalResize callback', () => {
      const onTerminalResize = vi.fn();
      channel = new MirrorChannel(session, transport, manager, { onTerminalResize });
      channel.start();

      transport.simulateEnvelope({
        type: 'terminal_resize',
        terminalId: 'term-1',
        rows: 24,
        cols: 80,
      } as TerminalInput);

      expect(onTerminalResize).toHaveBeenCalledWith('term-1', 24, 80);
    });
  });

  describe('refresh', () => {
    it('sends current terminal list', () => {
      channel.start();
      manager.register('npm test');
      transport.sent.length = 0;

      channel.refresh();

      expect(transport.sent.length).toBe(1);
      const parsed = parseOutput(transport.sent[0]!);
      expect(parsed.payload.type).toBe('terminal_list');
      expect((parsed.payload as TerminalListOut).terminals).toHaveLength(1);
    });
  });

  describe('ignores non-terminal messages', () => {
    it('ignores other channel messages', () => {
      const onTerminalInput = vi.fn();
      channel = new MirrorChannel(session, transport, manager, { onTerminalInput });
      channel.start();

      // Simulate an envelope from a different channel
      const raw = new TextEncoder().encode(JSON.stringify({ type: 'terminal_input', terminalId: 'term-1', data: 'x' }));
      const env: Envelope = { v: 1, sid: 'test', from: 'app', ch: 'files', seq: 0, ts: 0, encrypted: new Uint8Array() };
      for (const handler of transport.handlers) {
        handler(raw, env);
      }

      expect(onTerminalInput).not.toHaveBeenCalled();
    });
  });
});
