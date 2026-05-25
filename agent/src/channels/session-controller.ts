import { randomUUID } from 'node:crypto';
import type { RewindAction, RewindPoint, TaskItem, TerminalInput, TerminalOutput, SlashCommand } from '@bedcoder/protocol';
import { log } from '../log';
import type { AgentEngine } from '../claude/engine';
import type { TranscriptEntry } from '../claude/sessions';

// Build rewind targets from a session transcript: each real user turn (role
// 'user', with a uuid) is a point we can resumeSessionAt. The live SDK stream
// never echoes the user's own prompts (it only emits assistant + tool-result
// messages), so engine-tracked stream points are always empty — the transcript
// (the SDK's own record) is the source of truth.
export function rewindPointsFromTranscript(entries: TranscriptEntry[]): RewindPoint[] {
  const points: RewindPoint[] = [];
  for (const e of entries) {
    if (e.role !== 'user' || !e.uuid) continue;
    points.push({
      id: e.uuid,
      label: e.text.length > 80 ? `${e.text.slice(0, 80)}…` : e.text,
      ts: e.ts ?? Date.now(),
    });
  }
  return points;
}

// One session worth of past conversation, for the /resume picker.
export interface SessionPreview {
  id: string;
  mtimeMs: number;
  preview: string;
}

// Builds an engine for a given session. Lets the controller swap engines
// (/resume, /clear, rewind) without knowing whether it's Claude or the fake.
export type EngineFactory = (cfg: {
  sessionId: string;
  resume: boolean;
  resumeSessionAt?: string;
}) => AgentEngine;

export interface SessionControllerDeps {
  emit: (out: TerminalOutput) => void;
  listSessions: () => SessionPreview[];
  readTranscript: (sessionId: string) => TranscriptEntry[];
  readLatestTasks?: (sessionId: string) => TaskItem[] | undefined;
  initial: { sessionId: string; resume: boolean };
  cwd?: string; // project directory, shown by /status
  label?: string; // worktree/branch or project-dir name, shown by the app
}

// SessionController owns the engine lifecycle and translates TerminalInput
// (incl. slash commands) into engine actions, funnelling all output through one
// `emit` sink. It is transport- and crypto-agnostic so it unit-tests with a fake
// engine factory and a recording emit.
export class SessionController {
  private engine: AgentEngine;
  private lastCost?: TerminalOutput;
  private lastContextPercent?: number; // from context_status, for /context
  private currentModel?: string; // from status outputs, for /status
  private currentSessionId: string;

  constructor(
    private readonly factory: EngineFactory,
    private readonly deps: SessionControllerDeps,
  ) {
    this.engine = factory(deps.initial);
    this.currentSessionId = deps.initial.sessionId;
  }

  start(): void {
    this.bind(this.engine);
    // Tell the app which worktree/project this session is, so it can label the
    // conversation (independent of how it paired — QR or web code).
    if (this.deps.label) this.deps.emit({ type: 'status', state: 'idle', label: this.deps.label });
    this.run(this.engine);
  }

  dispatch(input: TerminalInput): void {
    log('dispatch', { type: input.type });
    switch (input.type) {
      case 'message':
        this.engine.sendUserMessage(input.text);
        break;
      case 'permission':
        this.engine.respondPermission(input.requestId, input.decision, input.pattern);
        break;
      case 'abort':
        this.engine.abort();
        break;
      case 'slash':
        // A failing slash (e.g. a /resume swap) must not become an unhandled
        // rejection that crashes the daemon — surface it as a notice.
        this.slash(input.command).catch((err: unknown) => {
          log('slash.error', { err: String(err) });
          this.deps.emit({ type: 'notice', kind: 'unsupported', text: `Command failed: ${String(err)}` });
        });
        break;
      case 'mode_switch':
        this.engine.setPermissionMode(input.mode);
        break;
      case 'effort':
        this.engine.setEffort(input.level);
        break;
      case 'shortcut':
        if (input.key === 'esc_esc') {
          this.deps.emit({
            type: 'rewind_options',
            points: rewindPointsFromTranscript(this.deps.readTranscript(this.currentSessionId)),
          });
        }
        break;
      case 'rewind':
        // Never let a rewind failure become an unhandled rejection (it would
        // crash the daemon); surface it as a notice instead.
        this.rewind(input.action, input.id).catch((err: unknown) => {
          log('rewind.error', { err: String(err) });
          this.deps.emit({ type: 'notice', kind: 'unsupported', text: `Rewind failed: ${String(err)}` });
        });
        break;
      default:
        // terminal_* — handled in later phases.
        break;
    }
  }

  // Bind exactly one engine to the emit sink (caching cost/context/model for the
  // /cost, /context, /status commands).
  private bind(engine: AgentEngine): void {
    engine.onOutput((out) => {
      if (out.type === 'cost') this.lastCost = out;
      if (out.type === 'context_status') this.lastContextPercent = out.usedPercent;
      if (out.type === 'status' && out.model) this.currentModel = out.model;
      this.deps.emit(out);
    });
  }

  // Drive an engine; surface a fatal error (e.g. auth) as a notice rather than
  // crashing the daemon. A normal stop() resolves start() without error.
  private run(engine: AgentEngine): void {
    Promise.resolve(engine.start())
      .then(() => log('engine.run.resolved', {}))
      .catch((err: unknown) => {
        log('engine.run.rejected', { err: String(err) });
        this.deps.emit({ type: 'notice', kind: 'unsupported', text: `Session error: ${String(err)}` });
        this.deps.emit({ type: 'status', state: 'error' });
      });
  }

  // Tear down the current engine and start a fresh one wired to the same sink.
  private async swap(sessionId: string, resume: boolean, banner: string, resumeSessionAt?: string): Promise<void> {
    log('swap', { resume, at: resumeSessionAt });
    this.engine.onOutput(() => {}); // detach so trailing output from the old engine is dropped
    this.engine.abort(); // interrupt any in-flight turn so its loop can end
    await this.engine.stop();
    this.currentSessionId = sessionId;
    this.engine = this.factory({ sessionId, resume, resumeSessionAt });
    this.bind(this.engine);
    this.deps.emit({ type: 'notice', kind: 'session_reset', text: banner, sessionId });
    if (resume) this.replayTranscript(sessionId, resumeSessionAt);
    this.run(this.engine);
  }

  // Paint the resumed/rewound session's history from its JSONL (the SDK stream is
  // gated until live input, so this is the single source — no double-paint). For a
  // rewind, only entries up to and including the chosen point's uuid.
  private replayTranscript(sessionId: string, upToUuid?: string): void {
    let entries = this.deps.readTranscript(sessionId);
    if (upToUuid) {
      let idx = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.uuid === upToUuid) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) entries = entries.slice(0, idx + 1); // not found → replay all
    }
    log('replay', { count: entries.length });
    for (const e of entries) {
      this.deps.emit(
        e.role === 'tool'
          ? { type: 'content', role: 'tool', text: e.text, toolName: e.toolName }
          : { type: 'content', role: e.role, text: e.text },
      );
    }
    // Restore the task panel from the session's last TodoWrite (rewind ignores it).
    if (!upToUuid) {
      const tasks = this.deps.readLatestTasks?.(sessionId);
      if (tasks && tasks.length) this.deps.emit({ type: 'tasks', items: tasks });
    }
  }

  // Rewind to a past user turn: restore the conversation (resume the same session
  // truncated at that uuid), the files (SDK rewindFiles), or both.
  private async rewind(action: RewindAction, id?: string): Promise<void> {
    if (action === 'cancel') return;
    if (action === 'summarize') {
      this.deps.emit({ type: 'notice', kind: 'unsupported', text: '/rewind summarize is not supported yet.' });
      return;
    }
    if (!id) {
      this.deps.emit({ type: 'notice', kind: 'info', text: 'No rewind point selected.' });
      return;
    }
    if (action === 'restore_code' || action === 'restore_both') {
      const r = await this.engine.rewindFiles(id);
      if (!r.canRewind) {
        this.deps.emit({ type: 'notice', kind: 'unsupported', text: `Cannot rewind files: ${r.error ?? 'unavailable'}` });
        if (action === 'restore_code') return;
      } else {
        this.deps.emit({
          type: 'notice',
          kind: 'info',
          text: `Reverted ${r.filesChanged ?? 0} file(s) (+${r.insertions ?? 0} -${r.deletions ?? 0}).`,
        });
      }
    }
    if (action === 'restore_conversation' || action === 'restore_both') {
      // claude-code style: rewind to *before* the chosen message and drop its
      // text into the composer to edit/resend. resumeSessionAt is inclusive, so
      // resume to the previous transcript entry (keeping the prior turn complete,
      // so the SDK waits for input rather than re-running the chosen message).
      const entries = this.deps.readTranscript(this.currentSessionId);
      const idx = entries.findIndex((e) => e.uuid === id);
      // Prefer the newline-preserving raw text so a multi-line prompt refills as-is.
      const chosenText = idx >= 0 ? (entries[idx]!.rawText ?? entries[idx]!.text) : undefined;
      const before = idx > 0 ? entries[idx - 1]!.uuid : undefined;
      if (before) {
        await this.swap(this.currentSessionId, true, `Rewound to ${shortId(id)}`, before);
      } else {
        // Rewinding to the very first message → start fresh, with it in the composer.
        await this.swap(randomUUID(), false, 'Rewound to the start');
      }
      if (chosenText) this.deps.emit({ type: 'input_prefill', text: chosenText });
    }
  }

  private async slash(cmd: SlashCommand): Promise<void> {
    // Object forms carry a picker selection.
    if (typeof cmd === 'object') {
      switch (cmd.name) {
        case 'resume':
          await this.swap(cmd.id, true, `Resumed ${shortId(cmd.id)}`);
          return;
        case 'model':
          if (!cmd.id) {
            this.deps.emit({ type: 'notice', kind: 'unsupported', text: 'No model id to switch to.' });
            return;
          }
          this.engine.setModel(cmd.id);
          this.deps.emit({ type: 'notice', kind: 'info', text: `Model set to ${cmd.id}` });
          return;
      }
    }

    switch (cmd) {
      case 'resume':
        this.deps.emit({ type: 'session_list', sessions: this.deps.listSessions() });
        return;
      case 'clear':
        await this.swap(randomUUID(), false, 'Started a new conversation');
        return;
      case 'model':
        this.deps.emit({ type: 'model_list', models: await this.engine.listModels() });
        return;
      case 'cost':
        if (this.lastCost) this.deps.emit(this.lastCost);
        else this.deps.emit({ type: 'notice', kind: 'info', text: 'No cost recorded yet this session.' });
        return;
      case 'help': {
        const cmds = await this.engine.listCommands();
        const text = cmds.length ? cmds.join('\n') : 'No commands available.';
        this.deps.emit({ type: 'notice', kind: 'dialog', title: 'Commands', text });
        return;
      }
      case 'status': {
        const acct = await this.engine.accountInfo();
        this.deps.emit({ type: 'notice', kind: 'dialog', title: 'Status', text: this.statusText(acct) });
        return;
      }
      case 'context':
        this.deps.emit({ type: 'notice', kind: 'dialog', title: 'Context', text: this.contextText() });
        return;
      case 'compact':
      case 'config':
      case 'fast':
        this.deps.emit({ type: 'notice', kind: 'unsupported', text: `/${cmd} is not supported yet.` });
        return;
      default:
        return;
    }
  }

  // Plain-text body for the /status dialog.
  private statusText(acct: Record<string, unknown> | undefined): string {
    const lines: string[] = [];
    if (acct) {
      for (const [k, v] of Object.entries(acct)) {
        if (v == null || typeof v === 'object') continue; // skip nested/empty
        lines.push(`${k}: ${String(v)}`);
      }
    }
    if (lines.length === 0) lines.push('Account: (not available)');
    lines.push(`Model: ${this.currentModel ?? '(default)'}`);
    if (this.deps.cwd) lines.push(`Dir: ${this.deps.cwd}`);
    lines.push(`Session: ${this.currentSessionId}`);
    return lines.join('\n');
  }

  // Plain-text body for the /context dialog.
  private contextText(): string {
    const lines: string[] = [];
    lines.push(this.lastContextPercent != null ? `Context: ${this.lastContextPercent}% used` : 'Context: (no turns yet)');
    const c = this.lastCost;
    if (c && c.type === 'cost') {
      lines.push(
        `Last turn — in ${c.inputTokens} · out ${c.outputTokens}` +
          (c.cacheRead != null ? ` · cache read ${c.cacheRead}` : '') +
          (c.cacheCreation != null ? ` · cache write ${c.cacheCreation}` : ''),
      );
    }
    return lines.join('\n');
  }
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
