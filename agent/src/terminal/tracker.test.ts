import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalTracker, type TrackableMessage } from './tracker';
import { TerminalManager } from './manager';
import type { Tailer } from './log_tailer';

// Records start/stop calls without touching the filesystem or timers.
class FakeTailer implements Tailer {
  started: Array<{ id: string; path: string }> = [];
  stopped: string[] = [];
  start(id: string, path: string): void {
    this.started.push({ id, path });
  }
  stop(id: string): void {
    this.stopped.push(id);
  }
  dispose(): void {}
}

describe('TerminalTracker', () => {
  let manager: TerminalManager;
  let tracker: TerminalTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new TerminalManager();
    tracker = new TerminalTracker(manager);
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('track tool_use', () => {
    it('registers terminal on Bash tool_use', () => {
      const msg: TrackableMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      };

      tracker.track(msg);

      const list = manager.getTerminalList();
      expect(list).toHaveLength(1);
      expect(list[0]!.command).toBe('npm test');
      expect(list[0]!.state).toBe('running');
    });

    it('ignores non-Bash tools', () => {
      const msg: TrackableMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Read',
              input: { file_path: '/foo/bar.ts' },
            },
          ],
        },
      };

      tracker.track(msg);

      expect(manager.getTerminalList()).toHaveLength(0);
    });

    it('registers background Bash and keeps it running', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_bg',
              name: 'Bash',
              input: { command: 'npm run dev', run_in_background: true },
            },
          ],
        },
      });
      const list = manager.getTerminalList();
      expect(list).toHaveLength(1);
      expect(list[0]!.command).toBe('npm run dev');
      expect(list[0]!.state).toBe('running');
    });

    it('ignores Bash without command', () => {
      const msg: TrackableMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: {}, // no command
            },
          ],
        },
      };

      tracker.track(msg);

      expect(manager.getTerminalList()).toHaveLength(0);
    });

    it('handles multiple Bash calls', () => {
      const msg: TrackableMessage = {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Bash',
              input: { command: 'npm install' },
            },
            {
              type: 'tool_use',
              id: 'tu_2',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      };

      tracker.track(msg);

      const list = manager.getTerminalList();
      expect(list).toHaveLength(2);
    });
  });

  describe('track tool_result', () => {
    it('captures output and marks terminal as exited', () => {
      // First, register a terminal
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'echo hello' },
            },
          ],
        },
      });

      // Then, process the result
      tracker.track({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: 'hello\n',
            },
          ],
        },
      });

      // Flush output
      vi.advanceTimersByTime(200);

      const list = manager.getTerminalList();
      expect(list).toHaveLength(1);
      expect(list[0]!.state).toBe('exited');
      expect(list[0]!.exitCode).toBe(0);
      expect(list[0]!.lastOutput).toContain('hello');
    });

    it('marks terminal as error on is_error', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'exit 1' },
            },
          ],
        },
      });

      tracker.track({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: 'Error: command failed',
              is_error: true,
            },
          ],
        },
      });

      const list = manager.getTerminalList();
      expect(list[0]!.exitCode).toBe(1);
    });

    it('handles array content in tool_result', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'ls' },
            },
          ],
        },
      });

      tracker.track({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: [{ type: 'text', text: 'file1.txt\n' }, { type: 'text', text: 'file2.txt\n' }],
            },
          ],
        },
      });

      vi.advanceTimersByTime(200);

      const output = manager.getOutput(manager.getTerminalList()[0]!.id);
      expect(output).toContain('file1.txt');
      expect(output).toContain('file2.txt');
    });

    it('ignores untracked tool_result', () => {
      // No prior tool_use
      tracker.track({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_unknown',
              content: 'some output',
            },
          ],
        },
      });

      expect(manager.getTerminalList()).toHaveLength(0);
    });
  });

  describe('background shells (Bash run_in_background + BashOutput + KillBash)', () => {
    function startBg(cmd = 'npm run dev', toolUseId = 'tu_bg'): void {
      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: cmd, run_in_background: true } }] },
      });
    }
    function result(toolUseId: string, content: string): void {
      tracker.track({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
    }

    it('does not exit on the initial background result (stays running)', () => {
      startBg();
      result('tu_bg', 'Command running in background with ID: b88cff8');
      expect(manager.getTerminalList()[0]!.state).toBe('running');
    });

    it('routes BashOutput polls to the terminal via the shell id and exits on completion', () => {
      startBg();
      result('tu_bg', 'running in background with ID: shell_1');

      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_out', name: 'BashOutput', input: { bash_id: 'shell_1' } }] },
      });
      result('tu_out', 'VITE ready on http://localhost:5173');
      vi.advanceTimersByTime(200);

      const term = manager.getTerminalList()[0]!;
      expect(manager.getOutput(term.id)).toContain('VITE ready');
      expect(term.state).toBe('running');

      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_out2', name: 'BashOutput', input: { bash_id: 'shell_1' } }] },
      });
      result('tu_out2', '<status>completed</status>');
      expect(manager.getTerminalList()[0]!.state).toBe('exited');
    });

    it('routes BashOutput to the most-recent background terminal when the shell id is unknown', () => {
      startBg('npm run dev'); // no initial result → no shell link
      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_out', name: 'BashOutput', input: { bash_id: 'unknown' } }] },
      });
      result('tu_out', 'server log line');
      vi.advanceTimersByTime(200);
      expect(manager.getOutput(manager.getTerminalList()[0]!.id)).toContain('server log line');
    });

    it('learns the served port from background output (for the Stop button)', () => {
      startBg();
      result('tu_bg', 'running in background with ID: shell_1');
      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_out', name: 'BashOutput', input: { bash_id: 'shell_1' } }] },
      });
      result('tu_out', 'VITE v5 ready\n  ➜  Local:   http://localhost:5173/');
      expect(manager.getTerminalList()[0]!.port).toBe(5173);
    });

    it('tails the SDK output file named in the banner (and skips BashOutput dup)', () => {
      const tailer = new FakeTailer();
      const m = new TerminalManager();
      const t = new TerminalTracker(m, tailer);
      t.track({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } }] } });
      t.track({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'Command running in background with ID: bf656b7. Output is being written to: /tmp/claude/x/tasks/bf656b7.output' }] },
      });
      const id = m.getTerminalList()[0]!.id;
      expect(tailer.started).toEqual([{ id, path: '/tmp/claude/x/tasks/bf656b7.output' }]);

      // BashOutput poll output is NOT appended (the tail owns the output).
      t.track({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'o', name: 'BashOutput', input: { bash_id: 'bf656b7' } }] } });
      t.track({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'o', content: 'DUPLICATE LINE' }] } });
      vi.advanceTimersByTime(200);
      expect(m.getOutput(id)).not.toContain('DUPLICATE LINE');

      // Exit stops the tail.
      t.track({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'k', name: 'KillBash', input: { shell_id: 'bf656b7' } }] } });
      expect(tailer.stopped).toContain(id);
      m.destroy();
    });

    it('learns the port from 127.0.0.1 / 0.0.0.0 / [::1] (not just localhost)', () => {
      const cases: Array<[string, number]> = [
        ['listening on 127.0.0.1:4001', 4001],
        ['  ➜  Network: http://0.0.0.0:4002/', 4002],
        ['ready at http://[::1]:4003', 4003],
      ];
      for (const [line, port] of cases) {
        const m = new TerminalManager();
        const t = new TerminalTracker(m);
        t.track({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'dev', run_in_background: true } }] } });
        t.track({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: line }] } });
        expect(m.getTerminalList()[0]!.port, line).toBe(port);
        m.destroy();
      }
    });

    it('KillBash marks the background terminal exited', () => {
      startBg();
      tracker.track({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu_kill', name: 'KillBash', input: { shell_id: 'whatever' } }] },
      });
      expect(manager.getTerminalList()[0]!.state).toBe('exited');
    });
  });

  describe('getTerminalForToolUse', () => {
    it('returns terminal id for tracked tool_use', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      });

      const terminalId = tracker.getTerminalForToolUse('tu_123');
      expect(terminalId).toBeDefined();
      expect(terminalId).toMatch(/^term-\d+$/);
    });

    it('returns undefined for untracked tool_use', () => {
      expect(tracker.getTerminalForToolUse('tu_unknown')).toBeUndefined();
    });
  });

  describe('hasPending', () => {
    it('returns false when no pending terminals', () => {
      expect(tracker.hasPending()).toBe(false);
    });

    it('returns true when there are pending terminals', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      });

      expect(tracker.hasPending()).toBe(true);
    });

    it('returns false after tool_result', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      });

      tracker.track({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_123',
              content: 'done',
            },
          ],
        },
      });

      expect(tracker.hasPending()).toBe(false);
    });
  });

  describe('clear', () => {
    it('clears all tracking state', () => {
      tracker.track({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu_123',
              name: 'Bash',
              input: { command: 'npm test' },
            },
          ],
        },
      });

      tracker.clear();

      expect(tracker.hasPending()).toBe(false);
      expect(tracker.getTerminalForToolUse('tu_123')).toBeUndefined();
    });
  });

  describe('non-trackable messages', () => {
    it('ignores system messages', () => {
      tracker.track({ type: 'system' });
      expect(manager.getTerminalList()).toHaveLength(0);
    });

    it('ignores result messages', () => {
      tracker.track({ type: 'result' });
      expect(manager.getTerminalList()).toHaveLength(0);
    });

    it('ignores messages without content', () => {
      tracker.track({ type: 'assistant' });
      tracker.track({ type: 'assistant', message: {} });
      tracker.track({ type: 'assistant', message: { content: 'string content' } });
      expect(manager.getTerminalList()).toHaveLength(0);
    });
  });
});
