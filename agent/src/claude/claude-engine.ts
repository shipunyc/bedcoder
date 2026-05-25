import { randomUUID } from 'node:crypto';
import type { AgentState, EffortLevel, RewindPoint, SessionMode } from '@bedcoder/protocol';
import { log } from '../log';
import {
  buildPermissionRequest,
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
};
type QueryFn = (params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => Query;

export interface ClaudeEngineConfig {
  sessionId: string;
  resume: boolean;
  resumeSessionAt?: string; // resume history only up to this user-message uuid (rewind)
  model?: string; // the model to run (from the catalog default or --model)
  models?: ModelOption[]; // the /model picker list (from the catalog)
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
  private readonly permResolvers = new Map<string, (decision: PermissionDecision) => void>();
  private deltaBuf = ''; // streamed assistant text awaiting a coalesced flush
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private readonly toolNames = new Map<string, string>(); // tool_use id → name, for tool_output labels/suppression
  private readonly runningAgents = new Map<string, { name: string; description?: string }>(); // live Task subagents

  constructor(private readonly config: ClaudeEngineConfig) {
    this.currentModel = config.model; // show it on the status line before init echoes it
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
        ...(this.config.resume ? { resume: this.config.sessionId } : {}),
        ...(this.config.resumeSessionAt ? { resumeSessionAt: this.config.resumeSessionAt } : {}),
      },
    });
    try {
      for await (const message of this.stream) {
        const msg = message as unknown as SdkMessageLike;
        log('sdk.msg', { type: msg.type, subtype: msg.subtype, live: this.liveStarted });
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
        // End-of-turn: report how full the context window is (best-effort).
        if (msg.type === 'result') {
          const pct = percentUsed(msg.usage, this.currentModel, msg.modelUsage);
          if (pct !== undefined) this.handler({ type: 'context_status', usedPercent: pct });
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

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.permResolvers.get(requestId);
    log('perm.resp', { decision, found: resolve !== undefined });
    if (resolve) {
      resolve(decision);
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
    log('abort', {});
    this.flushDelta(); // don't lose text streamed before the interrupt
    this.clearAgents();
    this.safeControl('abort.interrupt', () => this.stream?.interrupt?.());
    this.state = 'idle';
    this.emitStatus();
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
    return new Promise<PermissionDecision>((resolve) => {
      this.permResolvers.set(requestId, resolve);
    }).then((decision) =>
      decision === 'deny'
        ? { behavior: 'deny', message: 'denied by user' }
        : { behavior: 'allow', updatedInput: input },
    );
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
