import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalManager, type TerminalOutput } from './manager';

describe('TerminalManager', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TerminalManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('creates a new terminal', () => {
      const id = manager.register('npm run dev');

      expect(id).toMatch(/^term-\d+$/);
      expect(manager.isRunning(id)).toBe(true);
    });

    it('generates unique IDs', () => {
      const id1 = manager.register('cmd1');
      const id2 = manager.register('cmd2');

      expect(id1).not.toBe(id2);
    });

    it('emits terminal_list on register', () => {
      const listener = vi.fn();
      manager.on('terminal_list', listener);

      manager.register('cmd');

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('adds terminal to list', () => {
      const id = manager.register('npm run dev');
      const list = manager.getTerminalList();

      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe(id);
      expect(list[0]!.command).toBe('npm run dev');
      expect(list[0]!.state).toBe('running');
    });
  });

  describe('appendOutput', () => {
    it('buffers output', () => {
      const id = manager.register('cmd');
      manager.appendOutput(id, 'line 1\n');
      manager.appendOutput(id, 'line 2\n');

      const output = manager.getOutput(id);
      expect(output).toContain('line 1');
      expect(output).toContain('line 2');
    });

    it('emits terminal_output after throttle', () => {
      const listener = vi.fn();
      manager.on('terminal_output', listener);

      const id = manager.register('cmd');
      manager.appendOutput(id, 'hello');

      // Not emitted immediately
      expect(listener).not.toHaveBeenCalled();

      // Advance timers past throttle
      vi.advanceTimersByTime(200);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalId: id,
          data: 'hello',
          seq: 0,
        }),
      );
    });

    it('batches multiple outputs', () => {
      const listener = vi.fn();
      manager.on('terminal_output', listener);

      const id = manager.register('cmd');
      manager.appendOutput(id, 'a');
      manager.appendOutput(id, 'b');
      manager.appendOutput(id, 'c');

      vi.advanceTimersByTime(200);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'abc',
        }),
      );
    });

    it('detects ANSI sequences', () => {
      const listener = vi.fn();
      manager.on('terminal_output', listener);

      const id = manager.register('cmd');
      manager.appendOutput(id, '\x1b[31mred\x1b[0m');

      vi.advanceTimersByTime(200);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          ansi: true,
        }),
      );
    });

    it('increments seq for each batch', () => {
      const outputs: TerminalOutput[] = [];
      manager.on('terminal_output', (output: TerminalOutput) => outputs.push(output));

      const id = manager.register('cmd');

      manager.appendOutput(id, 'batch1');
      vi.advanceTimersByTime(200);

      manager.appendOutput(id, 'batch2');
      vi.advanceTimersByTime(200);

      expect(outputs).toHaveLength(2);
      expect(outputs[0]!.seq).toBe(0);
      expect(outputs[1]!.seq).toBe(1);
    });

    it('trims buffer when too large', () => {
      const id = manager.register('cmd');

      // Add more than MAX_OUTPUT_BUFFER_LINES
      for (let i = 0; i < 1100; i++) {
        manager.appendOutput(id, `line ${i}\n`);
      }

      const state = manager.getTerminal(id);
      expect(state?.outputBuffer.length).toBeLessThanOrEqual(1000);
    });
  });

  describe('setExited', () => {
    it('marks terminal as exited', () => {
      const id = manager.register('cmd');
      manager.setExited(id, 0);

      expect(manager.isRunning(id)).toBe(false);
      const list = manager.getTerminalList();
      expect(list[0]!.state).toBe('exited');
      expect(list[0]!.exitCode).toBe(0);
    });

    it('emits terminal_list on exit', () => {
      const id = manager.register('cmd');
      const listener = vi.fn();
      manager.on('terminal_list', listener);

      manager.setExited(id, 1);

      expect(listener).toHaveBeenCalled();
    });

    it('flushes pending output on exit', () => {
      const listener = vi.fn();
      manager.on('terminal_output', listener);

      const id = manager.register('cmd');
      manager.appendOutput(id, 'final');

      // Exit before throttle fires
      manager.setExited(id, 0);

      // Output should be flushed immediately
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          data: 'final',
        }),
      );
    });
  });

  describe('setPort', () => {
    it('sets port for terminal', () => {
      const id = manager.register('npm run dev');
      manager.setPort(id, 3000);

      const list = manager.getTerminalList();
      expect(list[0]!.port).toBe(3000);
    });

    it('emits terminal_list on port change', () => {
      const id = manager.register('cmd');
      const listener = vi.fn();
      manager.on('terminal_list', listener);

      manager.setPort(id, 8080);

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('kill', () => {
    it('marks terminal as exited with code -1', () => {
      const id = manager.register('cmd');
      const result = manager.kill(id);

      expect(result).toBe(true);
      expect(manager.isRunning(id)).toBe(false);

      const list = manager.getTerminalList();
      expect(list[0]!.exitCode).toBe(-1);
    });

    it('returns false for non-existent terminal', () => {
      const result = manager.kill('non-existent');
      expect(result).toBe(false);
    });

    it('returns false for already exited terminal', () => {
      const id = manager.register('cmd');
      manager.setExited(id, 0);

      const result = manager.kill(id);
      expect(result).toBe(false);
    });
  });

  describe('getTerminalList', () => {
    it('returns empty list initially', () => {
      const list = manager.getTerminalList();
      expect(list).toEqual([]);
    });

    it('sorts by startedAt (newest first)', () => {
      const id1 = manager.register('cmd1');
      vi.advanceTimersByTime(1000);
      const id2 = manager.register('cmd2');
      vi.advanceTimersByTime(1000);
      const id3 = manager.register('cmd3');

      const list = manager.getTerminalList();

      expect(list[0]!.id).toBe(id3);
      expect(list[1]!.id).toBe(id2);
      expect(list[2]!.id).toBe(id1);
    });

    it('includes lastOutput preview', () => {
      const id = manager.register('cmd');
      manager.appendOutput(id, 'Hello World\n');

      const list = manager.getTerminalList();
      expect(list[0]!.lastOutput).toContain('Hello World');
    });
  });

  describe('clear', () => {
    it('removes all terminals', () => {
      manager.register('cmd1');
      manager.register('cmd2');

      manager.clear();

      expect(manager.getTerminalList()).toEqual([]);
    });

    it('emits terminal_list', () => {
      manager.register('cmd');
      const listener = vi.fn();
      manager.on('terminal_list', listener);

      manager.clear();

      expect(listener).toHaveBeenCalled();
    });
  });
});
