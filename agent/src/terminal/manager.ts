// Terminal Manager (DESIGN §4.3 / Phase 2.3.2).
// Manages hosted terminals spawned by Claude's Bash tool calls.
// Tracks PTY output, state, and provides terminal_list/terminal_output for Mirror Tab.

import { EventEmitter } from 'node:events';
import type { HostedTerminal } from '@bedcoder/protocol';

// ============================================================================
// Configuration
// ============================================================================

const MAX_OUTPUT_BUFFER_LINES = 1000; // Max lines to keep per terminal
const OUTPUT_THROTTLE_MS = 100; // Batch output emissions

// ============================================================================
// Types
// ============================================================================

export interface TerminalState {
  id: string;
  command: string;
  state: 'running' | 'exited';
  exitCode?: number;
  port?: number;
  startedAt: number;
  outputBuffer: string[];
  outputSeq: number;
  lastOutputTime: number;
}

export interface TerminalOutput {
  terminalId: string;
  data: string;
  ansi: boolean;
  seq: number;
}

export interface TerminalManagerEvents {
  terminal_list: () => void;
  terminal_output: (output: TerminalOutput) => void;
}

// ============================================================================
// Terminal Manager
// ============================================================================

export class TerminalManager extends EventEmitter {
  private terminals: Map<string, TerminalState> = new Map();
  private nextId = 1;
  private outputThrottleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingOutput: Map<string, string[]> = new Map();

  constructor() {
    super();
  }

  /**
   * Register a new terminal for a bash command.
   * Called when the agent starts executing a bash command.
   */
  register(command: string): string {
    const id = `term-${this.nextId++}`;
    const state: TerminalState = {
      id,
      command,
      state: 'running',
      startedAt: Math.floor(Date.now() / 1000),
      outputBuffer: [],
      outputSeq: 0,
      lastOutputTime: Date.now(),
    };

    this.terminals.set(id, state);
    this.emitTerminalList();

    return id;
  }

  /**
   * Record output for a terminal.
   * Output is buffered and emitted in batches.
   */
  appendOutput(terminalId: string, data: string): void {
    const state = this.terminals.get(terminalId);
    if (!state) return;

    // Add to pending output
    let pending = this.pendingOutput.get(terminalId);
    if (!pending) {
      pending = [];
      this.pendingOutput.set(terminalId, pending);
    }
    pending.push(data);

    // Add to buffer (line by line)
    const lines = data.split('\n');
    for (const line of lines) {
      if (line || state.outputBuffer.length === 0) {
        state.outputBuffer.push(line);
      }
    }

    // Trim buffer if too large
    while (state.outputBuffer.length > MAX_OUTPUT_BUFFER_LINES) {
      state.outputBuffer.shift();
    }

    state.lastOutputTime = Date.now();

    // Throttle output emissions
    this.scheduleOutputEmit(terminalId);
  }

  private scheduleOutputEmit(terminalId: string): void {
    // Already scheduled
    if (this.outputThrottleTimers.has(terminalId)) return;

    const timer = setTimeout(() => {
      this.outputThrottleTimers.delete(terminalId);
      this.flushPendingOutput(terminalId);
    }, OUTPUT_THROTTLE_MS);

    this.outputThrottleTimers.set(terminalId, timer);
  }

  private flushPendingOutput(terminalId: string): void {
    const state = this.terminals.get(terminalId);
    const pending = this.pendingOutput.get(terminalId);

    if (!state || !pending || pending.length === 0) return;

    // Combine all pending output
    const data = pending.join('');
    this.pendingOutput.set(terminalId, []);

    // Emit output
    const output: TerminalOutput = {
      terminalId,
      data,
      ansi: this.containsAnsi(data),
      seq: state.outputSeq++,
    };

    this.emit('terminal_output', output);
  }

  private containsAnsi(data: string): boolean {
    // Detect ANSI escape sequences — the ESC control char is intentional here.
    // eslint-disable-next-line no-control-regex
    return /\x1b\[[\d;]*[A-Za-z]/.test(data);
  }

  /**
   * Mark a terminal as exited.
   */
  setExited(terminalId: string, exitCode: number): void {
    const state = this.terminals.get(terminalId);
    if (!state) return;

    state.state = 'exited';
    state.exitCode = exitCode;

    // Flush any pending output
    this.flushPendingOutput(terminalId);

    this.emitTerminalList();
  }

  /**
   * Set detected port for a terminal (e.g., when a dev server starts).
   */
  setPort(terminalId: string, port: number): void {
    const state = this.terminals.get(terminalId);
    if (!state) return;

    state.port = port;
    this.emitTerminalList();
  }

  /**
   * Write input to a terminal's stdin.
   * Returns true if the terminal exists and input was accepted.
   */
  writeInput(terminalId: string, _data: string): boolean {
    const state = this.terminals.get(terminalId);
    if (!state || state.state !== 'running') return false;

    // Note: Actual PTY input is handled by the PTY wrapper.
    // This method is for tracking/validation only.
    // The actual write happens in pty.ts

    return true;
  }

  /**
   * Kill a terminal process.
   */
  kill(terminalId: string): boolean {
    const state = this.terminals.get(terminalId);
    if (!state || state.state !== 'running') return false;

    // Note: Actual kill is handled by the PTY wrapper.
    // This marks it as exited with a special code.
    state.state = 'exited';
    state.exitCode = -1; // Killed

    this.emitTerminalList();
    return true;
  }

  /**
   * Get the terminal list for the app.
   */
  getTerminalList(): HostedTerminal[] {
    const list: HostedTerminal[] = [];

    for (const state of this.terminals.values()) {
      list.push({
        id: state.id,
        command: state.command,
        state: state.state,
        exitCode: state.exitCode,
        port: state.port,
        startedAt: state.startedAt,
        lastOutput: this.getLastOutput(state),
      });
    }

    // Sort by startedAt (newest first)
    list.sort((a, b) => b.startedAt - a.startedAt);

    return list;
  }

  private getLastOutput(state: TerminalState): string {
    // Get last few lines of output as preview
    const lastLines = state.outputBuffer.slice(-3);
    return lastLines.join('\n').slice(0, 200);
  }

  /**
   * Get buffered output for a terminal.
   */
  getOutput(terminalId: string): string {
    const state = this.terminals.get(terminalId);
    if (!state) return '';
    return state.outputBuffer.join('\n');
  }

  /**
   * Get a specific terminal state.
   */
  getTerminal(terminalId: string): TerminalState | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * Check if a terminal exists and is running.
   */
  isRunning(terminalId: string): boolean {
    const state = this.terminals.get(terminalId);
    return state?.state === 'running';
  }

  /**
   * Clear all terminals.
   */
  clear(): void {
    // Clear all timers
    for (const timer of this.outputThrottleTimers.values()) {
      clearTimeout(timer);
    }
    this.outputThrottleTimers.clear();
    this.pendingOutput.clear();
    this.terminals.clear();
    this.emitTerminalList();
  }

  private emitTerminalList(): void {
    this.emit('terminal_list');
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    for (const timer of this.outputThrottleTimers.values()) {
      clearTimeout(timer);
    }
    this.outputThrottleTimers.clear();
    this.removeAllListeners();
  }
}
