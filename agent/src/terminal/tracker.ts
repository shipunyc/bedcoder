// Terminal Tracker (DESIGN §4.3 / Phase 2.3.3).
// Tracks Bash tool calls from the SDK message stream and maps them to
// HostedTerminals. Since the SDK doesn't expose PTY-level hooks, we observe
// tool_use/tool_result pairs.
//
// Background (`run_in_background`) Bash is handled here too: the SDK runs it
// itself and ignores our PreToolUse command rewrite, so we can't tee its log
// from a wrapper. Instead we capture output the way Claude sees it — the initial
// Bash result, then each `BashOutput` poll — and mark the terminal exited when
// `BashOutput` reports completion or a `KillBash` runs.

import { log } from '../log';
import type { TerminalManager } from './manager';
import { LogTailer, type Tailer } from './log_tailer';

// ============================================================================
// Types
// ============================================================================

// A tool_use block from an assistant message.
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

// A tool_result block from a user message.
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | unknown[];
  is_error?: boolean;
}

// Minimal view of SDK messages we need to track terminals.
export interface TrackableMessage {
  type: string;
  message?: {
    content?: unknown[] | string;
  };
}

// What a tracked tool_use maps to. 'fg' = foreground Bash (exits on its result);
// 'bg' = the initial run_in_background Bash (keeps running); 'output' = a
// BashOutput poll whose result is appended to an existing background terminal.
type Kind = 'fg' | 'bg' | 'output';

// ============================================================================
// Terminal Tracker
// ============================================================================

export class TerminalTracker {
  // tool_use id -> { terminal, kind }
  private readonly toolUse = new Map<string, { terminal: string; kind: Kind }>();
  // SDK background shell id -> terminal id (so BashOutput/KillBash route home)
  private readonly shellToTerminal = new Map<string, string>();
  // Most-recently-started running background terminal — fallback routing for
  // BashOutput when we couldn't extract the shell id from the initial result.
  private lastBackground?: string;
  // Terminals whose output file we're tailing directly (so we ignore BashOutput
  // content for them to avoid duplicating what the tail already streams).
  private readonly tailed = new Set<string>();
  private readonly tailer: Tailer;

  constructor(private readonly manager: TerminalManager, tailer?: Tailer) {
    this.tailer =
      tailer ??
      new LogTailer((id, data) => {
        this.manager.appendOutput(id, data);
        const port = extractPort(data); // learn the served port from real output
        if (port) this.manager.setPort(id, port);
      });
  }

  /** Process an SDK message and track any Bash-related activity. */
  track(msg: TrackableMessage): void {
    if (msg.type === 'assistant') {
      this.trackToolUse(msg);
    } else if (msg.type === 'user') {
      this.trackToolResult(msg);
    }
  }

  private trackToolUse(msg: TrackableMessage): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!isToolUseBlock(block)) continue;

      // Windows uses PowerShell/Cmd in place of Bash, and the polling/kill tool
      // names are now shell-agnostic (ShellOutput/KillShell). Old names kept for
      // back-compat with older CLIs.
      if (isShellCommandTool(block.name)) {
        const command = extractCommand(block.input);
        if (!command) continue;
        const bg = block.input?.run_in_background === true;
        const terminal = this.manager.register(command);
        this.toolUse.set(block.id, { terminal, kind: bg ? 'bg' : 'fg' });
        if (bg) this.lastBackground = terminal;
        log('term.shell', { tool: block.name, bg, terminal });
      } else if (block.name === 'ShellOutput' || block.name === 'BashOutput') {
        // A poll of a background shell — route its result to that terminal.
        const terminal = this.terminalForShell(block.input);
        if (terminal) this.toolUse.set(block.id, { terminal, kind: 'output' });
        log('term.shelloutput', { tool: block.name, routed: !!terminal });
      } else if (block.name === 'KillShell' || block.name === 'KillBash') {
        const terminal = this.terminalForShell(block.input);
        if (terminal) this.exit(terminal, -1);
        log('term.killshell', { tool: block.name, matched: !!terminal });
      }
    }
  }

  private trackToolResult(msg: TrackableMessage): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!isToolResultBlock(block)) continue;

      const entry = this.toolUse.get(block.tool_use_id);
      if (!entry) continue;
      this.toolUse.delete(block.tool_use_id);

      const text = extractResultContent(block.content);

      if (entry.kind === 'fg') {
        if (text) this.manager.appendOutput(entry.terminal, text);
        this.exit(entry.terminal, block.is_error ? 1 : 0);
      } else if (entry.kind === 'bg') {
        // Initial background result (the "running in background…" banner). Show
        // it, link the SDK shell id, and — crucially — start tailing the output
        // file the SDK names ("Output is being written to: <path>") so we stream
        // the real dev-server logs live, not just what Claude later polls.
        if (text) this.manager.appendOutput(entry.terminal, text);
        const shell = extractShellId(text);
        if (shell) this.shellToTerminal.set(shell, entry.terminal);
        const file = extractOutputFile(text);
        if (file) {
          this.tailer.start(entry.terminal, file);
          this.tailed.add(entry.terminal);
        }
        const port = extractPort(text);
        if (port) this.manager.setPort(entry.terminal, port);
        log('term.bg.start', { shellLinked: !!shell, tailing: !!file, terminal: entry.terminal });
      } else {
        // BashOutput poll. If we're tailing the file we already have the full
        // output — don't duplicate; only use the poll to learn the port + exit.
        if (!this.tailed.has(entry.terminal) && text) this.manager.appendOutput(entry.terminal, text);
        const port = extractPort(text);
        if (port) this.manager.setPort(entry.terminal, port);
        if (isFinishedStatus(text)) this.exit(entry.terminal, 0);
      }
    }
  }

  // Resolve a BashOutput/KillBash input to a terminal: by its shell id, else the
  // most-recent background terminal (handles a single dev server robustly).
  private terminalForShell(input?: Record<string, unknown>): string | undefined {
    const shell = shellIdFromInput(input);
    return (shell && this.shellToTerminal.get(shell)) || this.lastBackground;
  }

  private exit(terminal: string, code: number): void {
    this.tailer.stop(terminal);
    this.tailed.delete(terminal);
    this.manager.setExited(terminal, code);
    if (this.lastBackground === terminal) this.lastBackground = undefined;
    for (const [shell, t] of this.shellToTerminal) {
      if (t === terminal) this.shellToTerminal.delete(shell);
    }
  }

  /** Get the terminal ID for a given tool_use ID. */
  getTerminalForToolUse(toolUseId: string): string | undefined {
    return this.toolUse.get(toolUseId)?.terminal;
  }

  /** Whether any tool_use is still awaiting its result. */
  hasPending(): boolean {
    return this.toolUse.size > 0;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.toolUse.clear();
    this.shellToTerminal.clear();
    this.tailed.clear();
    this.tailer.dispose();
    this.lastBackground = undefined;
  }
}

// ============================================================================
// Helpers
// ============================================================================

// Tool names that take a `command` input and run a shell command. Claude uses
// different names per platform: Bash (Unix or Windows w/ Git Bash) — relabelled
// SandboxedBash when the CLI's sandbox is active; PowerShell and Cmd (Windows).
// Zsh/fish/sh aren't separate tools — Bash runs under whatever $SHELL is.
function isShellCommandTool(name: string): boolean {
  return name === 'Bash' || name === 'SandboxedBash' || name === 'PowerShell' || name === 'Cmd';
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  const b = block as Record<string, unknown>;
  return b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string';
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  const b = block as Record<string, unknown>;
  return b?.type === 'tool_result' && typeof b.tool_use_id === 'string';
}

function extractCommand(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const cmd = input.command;
  return typeof cmd === 'string' ? cmd : undefined;
}

// BashOutput / KillBash identify the shell via bash_id (or shell_id / id).
function shellIdFromInput(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  const v = input.bash_id ?? input.shell_id ?? input.id;
  return typeof v === 'string' && v ? v : undefined;
}

// Pull the SDK background shell id out of the initial Bash result text, e.g.
// "Command running in background with ID: b88cff8". Best-effort; if it misses,
// BashOutput still routes via lastBackground.
function extractShellId(text: string): string | undefined {
  const m = text.match(/(?:bash[_ ]?id|shell[_ ]?id|\bID)\b[:\s]*([A-Za-z0-9_-]{4,})/i);
  return m?.[1];
}

// The output file the SDK writes a background task's combined output to, e.g.
// "Output is being written to: /tmp/claude/.../tasks/<id>.output".
function extractOutputFile(text: string): string | undefined {
  const m = text.match(/written to:\s*(\S+)/i);
  return m?.[1];
}

// True only on an explicit terminal status, to avoid false "exited" on output
// that merely contains words like "failed".
function isFinishedStatus(text: string): boolean {
  return /status[:\s>]*\s*(completed|killed|failed)/i.test(text) || /\bexit code\b/i.test(text);
}

// The port a dev server reports it's serving on, e.g. "http://localhost:5173/"
// or "localhost:5173". Used so the phone's Stop button can kill that process.
function extractPort(text: string): number | undefined {
  const m = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i);
  if (!m) return undefined;
  const p = parseInt(m[1]!, 10);
  return p > 0 && p <= 65535 ? p : undefined;
}

function extractResultContent(content: string | unknown[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (typeof item === 'object' && item !== null) {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}
