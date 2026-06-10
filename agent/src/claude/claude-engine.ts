import { randomUUID } from 'node:crypto';
import type { AgentState, EffortLevel, RewindPoint, SessionMode } from '@bedcoder/protocol';
import { log } from '../log';
import {
  buildPermissionRequest,
  contextLimitFor,
  mapSdkMessage,
  parseAgentStarts,
  percentUsed,
  toolResultIds,
  userText,
  type SdkMessageLike,
} from './events';
import type {
  AgentEngine,
  EngineOutputHandler,
  RawMessageHandler,
  ModelOption,
  PermissionDecision,
  RewindResult,
} from './engine';

// Stall watchdog tuning. Warn once a running turn has gone this long with no SDK
// message (and no pending permission), then re-warn at the same cadence so a long
// stall keeps reminding the user. Checked on a coarser interval.
export const STALL_WARN_MS = 60_000;
const STALL_TICK_MS = 15_000;

// Build the stall-notice text (pure, unit-tested). Names the in-flight tool when
// known so the user can judge whether it's plausibly stuck.
export function stallNoticeText(elapsedMs: number, toolName?: string): string {
  const secs = Math.round(elapsedMs / 1000);
  const what = toolName ? `Tool ${toolName}` : 'A tool';
  return `${what} has been running ${secs}s with no result yet — it may be stuck. Tap Abort to cancel and try again.`;
}

// Decide whether the watchdog should warn (pure, unit-tested). Only warns when a
// turn is genuinely stuck: busy, awaiting a tool result (not the user's
// permission tap, not just mid-thought), silent past `warnMs`, and not warned
// again within `warnMs`. `warnMs <= 0` disables warnings entirely.
export function shouldWarnStall(opts: {
  busy: boolean;
  pendingPermissions: number;
  pendingTools: number;
  idleMs: number;
  sinceLastNoticeMs: number;
  warnMs: number;
}): boolean {
  if (opts.warnMs <= 0) return false;
  if (!opts.busy) return false;
  if (opts.pendingPermissions > 0) return false;
  if (opts.pendingTools === 0) return false;
  if (opts.idleMs < opts.warnMs) return false;
  if (opts.sinceLastNoticeMs < opts.warnMs) return false;
  return true;
}

// Map our wire mode to the SDK permission mode (pure, unit-tested).
export type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export function mapSessionModeToPermissionMode(mode: SessionMode): SdkPermissionMode {
  switch (mode) {
    case 'auto_accept':
      return 'acceptEdits';
    case 'plan':
      return 'plan';
    case 'auto':
      return 'bypassPermissions'; // fully automatic — never asks
    default:
      return 'default';
  }
}

// Derive a sensible per-tool rule pattern from the call's input, so "Always"
// scopes the rule to *this kind of call* instead of the whole tool (e.g. allowing
// any future Bash command). For tools we don't recognize, returning undefined
// falls back to a tool-name-only rule.
export function derivePattern(toolName: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash' && typeof i.command === 'string') return i.command;
  if (
    typeof i.file_path === 'string' &&
    (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'Read')
  ) {
    return i.file_path;
  }
  return undefined;
}

// Build the SDK's canUseTool result. "Always" attaches an updatedPermissions rule
// (destination 'session', so it's not written to disk) — without this, the SDK
// re-prompts on every matching call.
export function buildPermissionResult(
  toolName: string,
  input: unknown,
  decision: PermissionDecision,
  pattern?: string,
): { behavior: 'allow'; updatedInput: unknown; updatedPermissions?: unknown[] } | { behavior: 'deny'; message: string } {
  if (decision === 'deny') return { behavior: 'deny', message: 'denied by user' };
  const allow = { behavior: 'allow' as const, updatedInput: input };
  if (decision !== 'always_allow') return allow;
  const content = pattern ?? derivePattern(toolName, input);
  const rule = content ? { toolName, ruleContent: content } : { toolName };
  return {
    ...allow,
    updatedPermissions: [
      { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' },
    ],
  };
}

// Map an effort level to a thinking-token budget (null = let the model decide).
export function tokensForEffort(level: EffortLevel): number | null {
  switch (level) {
    case 'low':
      return 4000;
    case 'medium':
      return 10000;
    case 'high':
      return 24000;
    case 'xhigh':
      return 64000;
    default:
      return null; // auto
  }
}

// Real engine backed by @anthropic-ai/claude-agent-sdk.
//
// NOTE: this path requires Claude auth (`claude` login or ANTHROPIC_API_KEY) and
// is verified manually — unit tests use FakeEngine. The SDK is loaded lazily and
// accessed through a narrow local type so the build does not couple to its large
// message/options unions (DESIGN §3.5 / §3.6).
//
// The Query object exposes mid-stream control methods we use for slash commands.
// They are typed loosely and called defensively (the running SDK may differ).
interface SdkModelInfo {
  value?: string; // the actual model id to pass back to setModel
  displayName?: string;
  description?: string;
  id?: string; // fallbacks for SDK variance
  model?: string;
}
interface SdkSlashCommand {
  name: string;
  description?: string;
  argumentHint?: string;
}
interface SdkRewindResult {
  canRewind?: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}
type Query = AsyncIterable<unknown> & {
  interrupt?: () => Promise<void>;
  setModel?: (model?: string) => void;
  setPermissionMode?: (mode: string) => void;
  setMaxThinkingTokens?: (n: number | null) => void;
  rewindFiles?: (userMessageId: string, options?: { dryRun?: boolean }) => Promise<SdkRewindResult>;
  supportedModels?: () => Promise<SdkModelInfo[]>;
  supportedCommands?: () => Promise<SdkSlashCommand[]>;
  accountInfo?: () => Promise<Record<string, unknown>>;
  getContextUsage?: () => Promise<{ percentage?: number; totalTokens?: number; maxTokens?: number }>;
};
type QueryFn = (params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => Query;

export interface ClaudeEngineConfig {
  sessionId: string;
  resume: boolean;
  resumeSessionAt?: string; // resume history only up to this user-message uuid (rewind)
  model?: string; // the model to run (from the catalog default or --model)
  models?: ModelOption[]; // the /model picker list (from the catalog)
  stallWarnMs?: number; // stall-watchdog threshold (--stall-warn); undefined = default, 0 = off
}

export class ClaudeEngine implements AgentEngine {
  private handler: EngineOutputHandler = () => {};
  private rawHandler: RawMessageHandler = () => {};
  private backgroundRewrite?: (command: string) => string;
  private pendingUser: string[] = [];
  private wake?: () => void;
  private closed = false;
  private liveStarted = false; // flips on the first live user message; gates resume-history replay
  private stream?: Query;
  private currentModel?: string;
  private currentMode?: SessionMode;
  private currentEffort: EffortLevel = 'auto';
  private state: AgentState = 'idle';
  private readonly points: RewindPoint[] = [];
  private readonly seenPoints = new Set<string>();
  // Resolver carries both the decision and an optional pattern; the pattern
  // narrows the persisted rule when the user picks "Always".
  private readonly permResolvers = new Map<string, (r: { decision: PermissionDecision; pattern?: string }) => void>();
  private deltaBuf = ''; // streamed assistant text awaiting a coalesced flush
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private readonly toolNames = new Map<string, string>(); // tool_use id → name, for tool_output labels/suppression
  private readonly runningAgents = new Map<string, { name: string; description?: string }>(); // live Task subagents
  // Stall watchdog: while a turn is running we expect SDK messages to keep
  // arriving; a long silence usually means a tool call is hung (commonly an MCP
  // server that never returns — MCP_TOOL_TIMEOUT is the hard backstop, but it's
  // minutes away). The watchdog surfaces a non-destructive notice so the user can
  // tell "stuck" from "slow" and Abort by hand, instead of staring at the timer.
  private readonly pendingTools = new Map<string, string>(); // in-flight tool_use id → name (awaiting its result)
  private lastSdkMsgAt = 0; // Date.now() of the last SDK message this turn
  private lastStallNoticeAt = 0; // Date.now() of the last stall notice (rate-limits re-warns)
  private stallTimer?: ReturnType<typeof setInterval>;
  private readonly stallWarnMs: number; // 0 = watchdog disabled

  constructor(private readonly config: ClaudeEngineConfig) {
    this.currentModel = config.model; // show it on the status line before init echoes it
    this.stallWarnMs = config.stallWarnMs ?? STALL_WARN_MS;
  }

  onOutput(handler: EngineOutputHandler): void {
    this.handler = handler;
  }

  onRawMessage(handler: RawMessageHandler): void {
    this.rawHandler = handler;
  }

  // Provide a rewrite for `run_in_background` Bash commands so the host can
  // observe/control the shell (see terminal/background.ts). The returned string
  // replaces the command via a PreToolUse hook.
  setBackgroundRewrite(cb: (command: string) => string): void {
    this.backgroundRewrite = cb;
  }

  // PreToolUse hook: take over background Bash by rewriting its command. Returns
  // {} (no-op) for everything else. Typed loosely — the SDK shape is narrow here.
  private readonly bashHook = (input: unknown): Record<string, unknown> => {
    const i = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    // Diagnostic: prove the hook fires and why it does/doesn't rewrite. (Tool
    // name + the run_in_background flag are not user content, so this is safe.)
    log('bg.hook.enter', {
      tool: i.tool_name,
      bg: (i.tool_input as { run_in_background?: unknown } | undefined)?.run_in_background === true,
      wired: !!this.backgroundRewrite,
    });
    if (i.tool_name !== 'Bash' || !this.backgroundRewrite) return {};
    const ti = i.tool_input ?? {};
    if (ti.run_in_background !== true || typeof ti.command !== 'string' || !ti.command) return {};
    const command = this.backgroundRewrite(ti.command);
    log('bg.hook.rewrite', { inLen: ti.command.length, outLen: command.length });
    return {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, command } },
    };
  };

  async start(): Promise<void> {
    log('engine.start', { resume: this.config.resume, resumeAt: this.config.resumeSessionAt });
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const query = sdk.query as unknown as QueryFn;
    // Note: when running as root, the bundled CLI refuses --dangerously-skip-permissions
    // unless IS_SANDBOX=1 is set in env. That env var is set (after user consent) at
    // boot in index.ts#confirmRootSandbox and inherited here via process.env.
    this.stream = query({
      prompt: this.inputIterable(),
      options: {
        // Pin the model (catalog default or --model); the SDK's bundled CLI
        // otherwise defaults to an older model than the account's latest.
        ...(this.config.model ? { model: this.config.model } : {}),
        permissionMode: 'default',
        includePartialMessages: true,
        canUseTool: this.canUseTool,
        // PreToolUse hook fires regardless of permission mode, so background Bash
        // is taken over even in auto/acceptEdits modes (canUseTool is skipped there).
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [this.bashHook] }] },
        // Enable (but don't activate) the bypass mode so the user can switch to
        // 'auto' (fully automatic) at runtime. Default mode still prompts.
        allowDangerouslySkipPermissions: true,
        // Surface the CLI subprocess's stderr (otherwise swallowed). This is the
        // only place the *reason* for a "process exited with code N" appears —
        // also mirror it to our stderr so it shows on the desktop console.
        stderr: (data: string) => {
          const text = data.trimEnd();
          if (!text) return;
          log('claude.stderr', { text: text.slice(0, 2000) });
          process.stderr.write(`[claude] ${text}\n`);
        },
        // For NEW sessions we have to pin the session id via the bundled CLI's
        // --session-id flag (the SDK Options type has no `sessionId` field for
        // new sessions). Without this the SDK uuidgens its own id and the jsonl
        // lands under that id instead of ours — breaking session interop with
        // the official `claude --resume` (invariant 4 in CLAUDE.md). For resume
        // we pass `resume: <id>` instead, which loads <id>.jsonl and keeps the
        // same id (no fork unless forkSession is set).
        ...(this.config.resume
          ? { resume: this.config.sessionId }
          : { extraArgs: { 'session-id': this.config.sessionId } }),
        ...(this.config.resumeSessionAt ? { resumeSessionAt: this.config.resumeSessionAt } : {}),
      },
    });
    this.armStallWatchdog();
    try {
      for await (const message of this.stream) {
        const msg = message as unknown as SdkMessageLike;
        log('sdk.msg', { type: msg.type, subtype: msg.subtype, live: this.liveStarted });
        this.noteActivity(msg); // feed the stall watchdog
        // Emit raw message for terminal tracking (only live messages matter)
        if (this.liveStarted) this.rawHandler(msg);
        this.trackRewindPoint(msg);
        this.trackToolNames(msg);
        this.trackAgents(msg);
        for (const out of mapSdkMessage(msg, {
          liveStarted: this.liveStarted,
          toolNameFor: (id) => (id ? this.toolNames.get(id) : undefined),
        })) {
          if (out.type === 'delta') {
            this.bufferDelta(out.text);
            continue;
          }
          this.flushDelta(); // keep streamed text ahead of the message that follows it
          if (out.type === 'status') {
            // In streaming-input mode the SDK emits its system/init message right
            // after the first user message, carrying state:'idle'. Applied as-is
            // it clobbers the "thinking" we just set, so the whole first turn
            // renders idle. Keep the live turn state; take only the config it
            // seeds (mode/model/effort). See ~/.bedcoder/agent.log: user.msg →
            // status(thinking) → sdk.msg system/init → status(idle).
            if (msg.type === 'system' && this.state === 'thinking') {
              this.seedConfig(out);
              log('status.out', { state: this.state, seeded: true });
              this.emitStatus();
              continue;
            }
            this.trackStatus(out);
            log('status.out', { state: out.state });
          }
          this.handler(out);
        }
        // End-of-turn: refresh the context bar.
        if (msg.type === 'result') {
          void this.emitContextStatus(msg.usage, msg.modelUsage);
        }
        // /compact (or auto-compact) just finished. The compact's own `result`
        // typically has zero `usage` (the CLI summarized in-memory, no fresh
        // input was sent), so we can't reuse that path — ask the SDK directly,
        // and fall back to compact_metadata.post_tokens if it can't answer.
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          void this.emitContextStatus(undefined, undefined, msg.compact_metadata?.post_tokens);
        }
      }
    } catch (err) {
      // The SDK output stream errored (e.g. the CLI subprocess exited with a
      // non-zero code). Mark the engine dead so the next message isn't yielded
      // into a gone transport — that write rejects and is swallowed, silently
      // losing the message and hanging the app on "thinking". Rethrow so the
      // controller surfaces the real error to the phone.
      this.closed = true;
      this.wake?.();
      this.state = 'error';
      throw err;
    } finally {
      this.flushDelta();
      this.disarmStallWatchdog();
      log('engine.stream_end', { closed: this.closed });
    }
    // The SDK output stream ended normally without a stop() — the CLI query
    // stalled/ended; surface it instead of leaving the app on "thinking".
    if (!this.closed) this.onUnexpectedEnd();
  }

  // The SDK query ended without a stop() — emit an error so the app leaves the
  // "thinking" state, and mark the engine dead so further sends don't queue into
  // the void (G2). Extracted so it is unit-testable without the real SDK.
  private onUnexpectedEnd(): void {
    log('engine.stream_end_unexpected', {});
    this.closed = true;
    this.wake?.();
    this.clearAgents();
    this.state = 'error';
    this.handler({ type: 'status', state: 'error' });
    this.handler({
      type: 'notice',
      kind: 'unsupported',
      text: 'Claude session ended unexpectedly — assign a new task or /resume.',
    });
  }

  sendUserMessage(text: string): void {
    log('user.msg', { len: text.length, live: this.liveStarted, waking: this.wake !== undefined, closed: this.closed });
    // G2: the query is dead (stop() or an unexpected stream end) — queuing here
    // would hang forever on "thinking". Tell the user instead of swallowing it.
    if (this.closed) {
      log('user.msg.dead', {});
      this.handler({ type: 'status', state: 'error' });
      this.handler({
        type: 'notice',
        kind: 'unsupported',
        text: 'Claude session is no longer running — assign a new task or /resume.',
      });
      return;
    }
    this.liveStarted = true; // past this point, replayed user messages are acks, not history
    this.pendingUser.push(text);
    this.state = 'thinking';
    this.emitStatus();
    this.wake?.();
    this.wake = undefined;
  }

  respondPermission(requestId: string, decision: PermissionDecision, pattern?: string): void {
    const resolve = this.permResolvers.get(requestId);
    log('perm.resp', { decision, hasPattern: !!pattern, found: resolve !== undefined });
    if (resolve) {
      resolve({ decision, pattern });
      this.permResolvers.delete(requestId);
    }
  }

  // Fire-and-forget an SDK control call (interrupt / setModel / …). These reject
  // ("ProcessTransport is not ready for writing") or throw when the SDK's CLI
  // subprocess is gone/not ready — e.g. during a /resume or /clear swap. They
  // must never escape: an unhandled rejection (or sync throw) crashes the daemon.
  private safeControl(label: string, op: () => unknown): void {
    try {
      const p = op() as Promise<unknown> | undefined;
      if (p && typeof p.catch === 'function') void p.catch((err: unknown) => log(`${label}.failed`, { err: String(err) }));
    } catch (err) {
      log(`${label}.failed`, { err: String(err) });
    }
  }

  abort(): void {
    log('abort', { pendingPerms: this.permResolvers.size });
    this.flushDelta(); // don't lose text streamed before the interrupt
    this.clearAgents();
    this.safeControl('abort.interrupt', () => this.stream?.interrupt?.());
    // Resolve any pending permission promises as 'deny' — otherwise the SDK is
    // deadlocked awaiting canUseTool from the aborted turn, and the next user
    // message just sits in the queue. interrupt() stops generation; this frees
    // the tool-call await so the turn can finalize and the SDK move on.
    for (const resolve of this.permResolvers.values()) resolve({ decision: 'deny' });
    this.permResolvers.clear();
    this.pendingTools.clear(); // a stuck tool's result never arrives; don't carry it forward
    this.lastStallNoticeAt = 0;
    this.state = 'idle';
    this.emitStatus();
  }

  // Start the per-engine stall watchdog (idempotent). Runs for the engine's
  // lifetime; checkStall() gates on whether a turn is actually busy, so the idle
  // gaps between turns never trip it. .unref() so it can't keep the process alive.
  private armStallWatchdog(): void {
    if (this.stallTimer || this.stallWarnMs <= 0) return; // 0 = disabled
    this.lastSdkMsgAt = Date.now();
    // Tick at most every STALL_TICK_MS, but finer for a short threshold so a small
    // --stall-warn still fires promptly (and never below 1s).
    const tick = Math.max(1_000, Math.min(STALL_TICK_MS, this.stallWarnMs));
    this.stallTimer = setInterval(() => this.checkStall(), tick);
    this.stallTimer.unref?.();
  }

  private disarmStallWatchdog(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
  }

  // Record a fresh SDK message: it resets the stall clock, and adds/removes
  // in-flight tool calls so a stall notice can name what we're waiting on.
  private noteActivity(msg: SdkMessageLike): void {
    this.lastSdkMsgAt = Date.now();
    this.lastStallNoticeAt = 0; // progress resumed → allow an immediate warn if it stalls again
    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          this.pendingTools.set(b.id, b.name);
        }
      }
    }
    for (const id of toolResultIds(msg)) this.pendingTools.delete(id);
  }

  // Fired on a timer: if a turn is genuinely stuck (busy, a tool in flight, no
  // SDK message for a while, and not just waiting on the user's permission tap),
  // surface a non-destructive notice. Re-warns at STALL_WARN_MS cadence. The hard
  // MCP_TOOL_TIMEOUT remains the backstop that actually unblocks the turn.
  private checkStall(): void {
    const now = Date.now();
    const idle = now - this.lastSdkMsgAt;
    const warn = shouldWarnStall({
      busy: this.state === 'thinking',
      pendingPermissions: this.permResolvers.size,
      pendingTools: this.pendingTools.size,
      idleMs: idle,
      sinceLastNoticeMs: now - this.lastStallNoticeAt,
      warnMs: this.stallWarnMs,
    });
    if (!warn) return;
    this.lastStallNoticeAt = now;
    const toolName = [...this.pendingTools.values()].pop();
    log('stall.warn', { idleMs: idle, tool: toolName, pending: this.pendingTools.size });
    this.handler({ type: 'notice', kind: 'info', text: stallNoticeText(idle, toolName) });
  }

  // Empty the subagent tree (turn interrupted/ended) so it never sticks.
  private clearAgents(): void {
    if (this.runningAgents.size === 0) return;
    this.runningAgents.clear();
    this.emitAgents();
  }

  // Coalesce streamed text deltas: many SDK token events become a few larger
  // `delta` outputs (fewer encrypted frames + UI rebuilds). Flushed on a short
  // timer and before any non-delta output / at stream end.
  private bufferDelta(text: string): void {
    this.deltaBuf += text;
    this.deltaTimer ??= setTimeout(() => this.flushDelta(), 50);
  }

  private flushDelta(): void {
    if (this.deltaTimer) {
      clearTimeout(this.deltaTimer);
      this.deltaTimer = undefined;
    }
    if (this.deltaBuf) {
      const text = this.deltaBuf;
      this.deltaBuf = '';
      this.handler({ type: 'delta', text });
    }
  }

  async listModels(): Promise<ModelOption[]> {
    // Prefer our curated catalog (avoids the bundled CLI's stale list); fall back
    // to the SDK's supportedModels() if no catalog was provided.
    if (this.config.models?.length) {
      return this.config.models.map((m) => ({ ...m, current: m.id === this.currentModel }));
    }
    const models = (await this.stream?.supportedModels?.()) ?? [];
    return models.map((m) => {
      const id = m.value ?? m.id ?? m.model ?? '';
      return { id, label: m.displayName ?? m.value ?? id, detail: m.description, current: id === this.currentModel };
    });
  }

  setModel(id: string): void {
    if (!id) return; // empty would be rejected by the API
    this.currentModel = id;
    this.safeControl('setModel', () => this.stream?.setModel?.(id));
    this.emitStatus();
  }

  setPermissionMode(mode: SessionMode): void {
    this.currentMode = mode;
    this.safeControl('setPermissionMode', () => this.stream?.setPermissionMode?.(mapSessionModeToPermissionMode(mode)));
    this.emitStatus();
  }

  setEffort(level: EffortLevel): void {
    this.currentEffort = level;
    this.safeControl('setMaxThinkingTokens', () => this.stream?.setMaxThinkingTokens?.(tokensForEffort(level)));
    this.emitStatus();
  }

  rewindPoints(): RewindPoint[] {
    return this.points;
  }

  async rewindFiles(id: string): Promise<RewindResult> {
    const fn = this.stream?.rewindFiles;
    if (!fn) return { canRewind: false, error: 'rewind not supported by this SDK' };
    try {
      const r = await fn.call(this.stream, id, { dryRun: false });
      return {
        canRewind: r.canRewind ?? false,
        error: r.error,
        filesChanged: r.filesChanged?.length,
        insertions: r.insertions,
        deletions: r.deletions,
      };
    } catch (err) {
      // The SDK rejects (e.g. "File rewinding is not enabled.") rather than
      // resolving — must be caught or it crashes the daemon as an unhandled
      // rejection. Surface it as a non-rewindable result.
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listCommands(): Promise<string[]> {
    const commands = (await this.stream?.supportedCommands?.()) ?? [];
    return commands.map((c) =>
      c.argumentHint ? `/${c.name} ${c.argumentHint} — ${c.description ?? ''}`.trim() : `/${c.name} — ${c.description ?? ''}`.trim(),
    );
  }

  async accountInfo(): Promise<Record<string, unknown> | undefined> {
    const fn = this.stream?.accountInfo;
    if (!fn) return undefined;
    try {
      return await fn.call(this.stream);
    } catch {
      return undefined; // not available in this SDK / not logged in
    }
  }

  // Ask the SDK for current context window usage. Used by the controller after
  // /resume so the bar reflects the resumed session's real fill — without this,
  // the bar would keep showing the previous session's value until the first new
  // turn fires `result` and percentUsed. Returns undefined if the SDK can't
  // answer (control request failed, no stream, older SDK without the method).
  async getContextPercent(): Promise<number | undefined> {
    const fn = this.stream?.getContextUsage;
    if (!fn) return undefined;
    try {
      const r = await fn.call(this.stream);
      const pct = r?.percentage;
      if (typeof pct !== 'number') return undefined;
      return Math.min(100, Math.max(0, Math.round(pct)));
    } catch (err) {
      log('engine.getContextPercent.failed', { err: String(err) });
      return undefined;
    }
  }

  // Refresh the phone's context bar. Sources, in preference order:
  //   1. SDK getContextUsage().percentage — authoritative, knows the real
  //      per-model context window (even on provider proxies like GLM where
  //      our name-based heuristic would guess wrong)
  //   2. compact_boundary's `post_tokens` divided by the name-based limit —
  //      direct from the SDK after compaction, when getContextUsage isn't
  //      available (older SDK, control request failed)
  //   3. Heuristic percentUsed(usage, model) — sums input + cache from the
  //      result message, divides by name-based limit. Least accurate but
  //      always available
  // Logs the source + raw inputs so future "ctx says X% but I don't believe
  // it" reports come with diagnostic context.
  private async emitContextStatus(
    usage: SdkMessageLike['usage'],
    modelUsage: SdkMessageLike['modelUsage'],
    directTokens?: number,
  ): Promise<void> {
    let pct = await this.getContextPercent();
    let source: 'sdk' | 'compact_metadata' | 'heuristic' = 'sdk';
    if (pct === undefined && typeof directTokens === 'number' && directTokens >= 0) {
      const limit = contextLimitFor(this.currentModel);
      pct = Math.min(100, Math.max(0, Math.round((directTokens / limit) * 100)));
      source = 'compact_metadata';
    }
    if (pct === undefined) {
      pct = percentUsed(usage, this.currentModel, modelUsage);
      source = 'heuristic';
    }
    if (pct === undefined) {
      log('ctx.skip', { reason: 'no_data', model: this.currentModel });
      return;
    }
    log('ctx.emit', {
      pct,
      source,
      model: this.currentModel,
      in: usage?.input_tokens,
      cacheRead: usage?.cache_read_input_tokens,
      cacheCreate: usage?.cache_creation_input_tokens,
      sdkWindow: modelUsage ? 'present' : 'absent',
      directTokens,
    });
    this.handler({ type: 'context_status', usedPercent: pct });
  }

  stop(): void {
    log('stop', {});
    this.closed = true;
    this.wake?.();
  }

  // Emit a status carrying the full current config so the app's status line stays
  // in sync (omitted fields are dropped by JSON serialization).
  private emitStatus(): void {
    this.handler({
      type: 'status',
      state: this.state,
      mode: this.currentMode,
      model: this.currentModel,
      effort: this.currentEffort,
    });
  }

  // Learn current state/mode/model from statuses produced by mapSdkMessage (e.g.
  // the system/init seed and the end-of-turn idle), so emitStatus carries them.
  private trackStatus(out: { state: AgentState; mode?: SessionMode; model?: string; effort?: EffortLevel }): void {
    this.state = out.state;
    this.seedConfig(out);
  }

  // Adopt mode/model/effort from a status without touching the turn state.
  private seedConfig(out: { mode?: SessionMode; model?: string; effort?: EffortLevel }): void {
    if (out.mode) this.currentMode = out.mode;
    if (out.model) this.currentModel = out.model;
    if (out.effort) this.currentEffort = out.effort;
  }

  // Remember tool_use id → name from assistant messages so tool results (which
  // only carry the id) can be labelled and suppressed by tool.
  private trackToolNames(msg: SdkMessageLike): void {
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) return;
    for (const b of msg.message.content) {
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        this.toolNames.set(b.id, b.name);
      }
    }
  }

  // Track running Task subagents for the live spinner tree: a Task tool_use
  // starts one, its tool_result ends it, and the turn's `result` clears all.
  private trackAgents(msg: SdkMessageLike): void {
    if (!this.liveStarted) return;
    let changed = false;
    for (const a of parseAgentStarts(msg)) {
      this.runningAgents.set(a.id, { name: a.name, description: a.description });
      changed = true;
    }
    for (const id of toolResultIds(msg)) {
      if (this.runningAgents.delete(id)) changed = true;
    }
    if (msg.type === 'result' && this.runningAgents.size > 0) {
      this.runningAgents.clear();
      changed = true;
    }
    if (changed) this.emitAgents();
  }

  private emitAgents(): void {
    this.handler({
      type: 'agents',
      running: [...this.runningAgents.entries()].map(([id, a]) => ({
        id,
        name: a.name,
        ...(a.description ? { description: a.description } : {}),
      })),
    });
  }

  // Record each distinct user turn (by uuid) as a rewind point.
  private trackRewindPoint(msg: SdkMessageLike): void {
    if (msg.type !== 'user' || !msg.uuid || msg.isSynthetic || msg.tool_use_result !== undefined) return;
    if (this.seenPoints.has(msg.uuid)) return;
    const label = userText(msg.message?.content).replace(/\s+/g, ' ').trim();
    if (!label) return;
    this.seenPoints.add(msg.uuid);
    this.points.push({ id: msg.uuid, label: label.length > 80 ? `${label.slice(0, 80)}…` : label, ts: Date.now() });
  }

  private readonly canUseTool = (toolName: string, input: unknown): Promise<unknown> => {
    // TodoWrite drives the task list, not a chat action — never prompt for it
    // (the task panel is painted from the assistant message's tool_use block).
    if (toolName === 'TodoWrite') return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const requestId = randomUUID();
    log('perm.req', { tool: toolName, requestId });
    this.handler(buildPermissionRequest(requestId, toolName, input));
    return new Promise<{ decision: PermissionDecision; pattern?: string }>((resolve) => {
      this.permResolvers.set(requestId, resolve);
    }).then(({ decision, pattern }) => buildPermissionResult(toolName, input, decision, pattern));
  };

  private async *inputIterable(): AsyncIterable<unknown> {
    while (!this.closed) {
      const text = this.pendingUser.shift();
      if (text === undefined) {
        log('input.wait', {});
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        continue;
      }
      log('input.yield', { len: text.length });
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: this.config.sessionId,
      };
    }
    log('input.exit', { closed: this.closed });
  }
}
