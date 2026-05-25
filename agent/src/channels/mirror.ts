// Mirror Channel (DESIGN §4.3 / Phase 2.3.4).
// Sends terminal_list and terminal_output to the app.
// Receives terminal_input and terminal_resize from the app.

import type { TerminalInput, TerminalOutput, Envelope } from '@bedcoder/protocol';
import type { Session } from '../session';
import type { TerminalManager, TerminalOutput as ManagerOutput } from '../terminal/manager';
import { log } from '../log';

// The transport subset the mirror channel needs (RelayClient satisfies it).
export interface MirrorTransport {
  sendRaw(raw: Uint8Array): void;
  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void;
}

export interface MirrorChannelOptions {
  // Optional callback when terminal input is received (for PTY forwarding).
  onTerminalInput?: (terminalId: string, data: string) => void;
  // Optional callback when terminal resize is received.
  onTerminalResize?: (terminalId: string, rows: number, cols: number) => void;
  // Kill a hosted (background) terminal — wired to the BackgroundShellManager.
  onTerminalKill?: (terminalId: string) => void;
}

/**
 * MirrorChannel bridges the TerminalManager to the app.
 *
 * - Listens to manager events and sends terminal_list/terminal_output
 * - Receives terminal_input/terminal_resize from the app
 */
export class MirrorChannel {
  private started = false;

  constructor(
    private readonly session: Session,
    private readonly transport: MirrorTransport,
    private readonly manager: TerminalManager,
    private readonly options: MirrorChannelOptions = {},
  ) {}

  /**
   * Start the mirror channel.
   * Begins listening for terminal messages and manager events.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Listen to manager events
    this.manager.on('terminal_list', () => {
      this.sendTerminalList();
    });

    this.manager.on('terminal_output', (output: ManagerOutput) => {
      this.sendTerminalOutput(output);
    });

    // Listen to terminal channel messages from the app
    this.transport.onEnvelope((raw, env) => {
      if (env.ch !== 'terminal') return;
      const { payload } = this.session.decode<TerminalInput>(raw);
      this.handleInput(payload);
    });

    // Send initial terminal list
    this.sendTerminalList();
  }

  /**
   * Handle incoming terminal messages from the app.
   */
  private handleInput(input: TerminalInput): void {
    switch (input.type) {
      case 'terminal_input':
        log('mirror:input', { terminalId: input.terminalId, len: input.data.length });
        this.options.onTerminalInput?.(input.terminalId, input.data);
        break;
      case 'terminal_resize':
        log('mirror:resize', { terminalId: input.terminalId, rows: input.rows, cols: input.cols });
        this.options.onTerminalResize?.(input.terminalId, input.rows, input.cols);
        break;
      case 'terminal_kill':
        log('mirror:kill', { terminalId: input.terminalId });
        this.options.onTerminalKill?.(input.terminalId);
        break;
      default:
        // Other terminal messages are handled by SessionController
        break;
    }
  }

  /**
   * Send the current terminal list to the app.
   */
  sendTerminalList(): void {
    const terminals = this.manager.getTerminalList();
    const output: TerminalOutput = {
      type: 'terminal_list',
      terminals,
    };
    log('mirror:emit:list', { count: terminals.length });
    this.transport.sendRaw(this.session.encode('terminal', output));
  }

  /**
   * Send terminal output to the app.
   */
  private sendTerminalOutput(output: ManagerOutput): void {
    const terminalOutput: TerminalOutput = {
      type: 'terminal_output',
      terminalId: output.terminalId,
      data: output.data,
      ansi: output.ansi,
      seq: output.seq,
    };
    log('mirror:emit:output', { terminalId: output.terminalId, seq: output.seq, len: output.data.length });
    this.transport.sendRaw(this.session.encode('terminal', terminalOutput));
  }

  /**
   * Force refresh the terminal list (e.g., after reconnect).
   */
  refresh(): void {
    this.sendTerminalList();
  }
}
