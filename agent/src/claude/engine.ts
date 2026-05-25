import type { TerminalOutput, RewindPoint, SessionMode, EffortLevel } from '@bedcoder/protocol';

// An AgentEngine drives a Claude session: it receives user input and emits a
// stream of TerminalOutput. The terminal channel adapts between this and the
// encrypted relay transport (DESIGN §3.5).
export type EngineOutputHandler = (out: TerminalOutput) => void;

// Raw SDK message handler for terminal tracking and other observability.
// The message shape matches SdkMessageLike but we don't import it to keep the
// engine interface minimal.
export type RawMessageHandler = (msg: unknown) => void;

export type PermissionDecision = 'allow' | 'deny' | 'always_allow';

// A model the running session can switch to (for the /model picker).
export interface ModelOption {
  id: string;
  label: string;
  detail?: string;
  current?: boolean;
}

// Result of an SDK file rewind (subset we surface).
export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

export interface AgentEngine {
  onOutput(handler: EngineOutputHandler): void;
  // Optional: observe raw SDK messages for terminal tracking.
  onRawMessage?(handler: RawMessageHandler): void;
  // Begin driving the session. Resolves when the session ends (e.g. after stop()).
  start(): Promise<void> | void;
  sendUserMessage(text: string): void;
  respondPermission(requestId: string, decision: PermissionDecision, pattern?: string): void;
  abort(): void;
  stop(): Promise<void> | void;
  // Control surface backing the slash commands and TUI toggles.
  listModels(): Promise<ModelOption[]>;
  setModel(id: string): void;
  listCommands(): Promise<string[]>;
  setPermissionMode(mode: SessionMode): void;
  setEffort(level: EffortLevel): void;
  // Past user turns, for the rewind picker, and a filesystem rewind to one.
  rewindPoints(): RewindPoint[];
  rewindFiles(id: string): Promise<RewindResult>;
  // Account/subscription info for /status (raw fields; undefined if unavailable).
  accountInfo(): Promise<Record<string, unknown> | undefined>;
}

// FakeEngine is a deterministic engine for tests and `bedcoder --fake`: it echoes
// the user message and reports a token cost. No network, no auth, no cost. It is
// constructable per session so it can stand in for ClaudeEngine in engine swaps.
export interface FakeEngineConfig {
  sessionId?: string;
  resume?: boolean;
  resumeSessionAt?: string;
}

export class FakeEngine implements AgentEngine {
  private handler: EngineOutputHandler = () => {};
  private currentModel = 'fake-sonnet';
  private currentMode: SessionMode = 'normal';
  private currentEffort: EffortLevel = 'auto';
  private state: 'idle' | 'thinking' = 'idle';
  private readonly points: RewindPoint[] = [];

  constructor(_config: FakeEngineConfig = {}) {}

  onOutput(handler: EngineOutputHandler): void {
    this.handler = handler;
  }

  start(): void {
    // Nothing to spin up; output flows from sendUserMessage().
  }

  sendUserMessage(text: string): void {
    this.points.push({ id: `fake-${this.points.length}`, label: text, ts: Date.now() });
    this.state = 'thinking';
    this.emitStatus();
    // Stream a couple of deltas, then the final message — exercises the app's
    // preview → commit path.
    this.handler({ type: 'delta', text: 'echo: ' });
    this.handler({ type: 'delta', text: text });
    this.handler({ type: 'content', role: 'assistant', text: `echo: ${text}` });
    this.handler({
      type: 'diff',
      filePath: 'demo.txt',
      lines: [
        { op: ' ', text: 'unchanged' },
        { op: '-', text: 'old line' },
        { op: '+', text: `new line: ${text}` },
      ],
    });
    this.handler({
      type: 'tasks',
      items: [
        { content: 'Think about it', status: 'completed', activeForm: 'Thinking about it' },
        { content: `Echo ${text}`, status: 'in_progress', activeForm: `Echoing ${text}` },
      ],
    });
    this.handler({ type: 'cost', inputTokens: text.length, outputTokens: text.length, totalUSD: 0 });
    this.handler({ type: 'context_status', usedPercent: 37 });
    this.state = 'idle';
    this.emitStatus();
  }

  respondPermission(): void {
    // FakeEngine never requests permissions.
  }

  abort(): void {
    this.state = 'idle';
    this.emitStatus();
  }

  stop(): void {}

  listModels(): Promise<ModelOption[]> {
    return Promise.resolve([
      { id: 'fake-sonnet', label: 'Fake Sonnet', detail: 'fast', current: this.currentModel === 'fake-sonnet' },
      { id: 'fake-opus', label: 'Fake Opus', detail: 'capable', current: this.currentModel === 'fake-opus' },
    ]);
  }

  setModel(id: string): void {
    this.currentModel = id;
    this.emitStatus();
  }

  listCommands(): Promise<string[]> {
    return Promise.resolve([
      '/help — show commands',
      '/cost — show last turn cost',
      '/clear — start a new conversation',
      '/resume — pick a session to resume',
      '/model — pick a model',
    ]);
  }

  setPermissionMode(mode: SessionMode): void {
    this.currentMode = mode;
    this.emitStatus();
  }

  setEffort(level: EffortLevel): void {
    this.currentEffort = level;
    this.emitStatus();
  }

  rewindPoints(): RewindPoint[] {
    return this.points;
  }

  rewindFiles(_id: string): Promise<RewindResult> {
    return Promise.resolve({ canRewind: true, filesChanged: 1, insertions: 2, deletions: 0 });
  }

  accountInfo(): Promise<Record<string, unknown> | undefined> {
    return Promise.resolve({ account: 'fake', subscription: 'test' });
  }

  private emitStatus(): void {
    this.handler({
      type: 'status',
      state: this.state,
      mode: this.currentMode,
      model: this.currentModel,
      effort: this.currentEffort,
    });
  }
}
