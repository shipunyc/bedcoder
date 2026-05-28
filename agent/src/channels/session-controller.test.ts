import { describe, it, expect } from 'vitest';
import type { EffortLevel, RewindPoint, SessionMode, TaskItem, TerminalOutput } from '@bedcoder/protocol';
import type { AgentEngine, EngineOutputHandler, ModelOption, RewindResult } from '../claude/engine';
import type { TranscriptEntry } from '../claude/sessions';
import { SessionController, rewindPointsFromTranscript, type SessionPreview } from './session-controller';

// A recording engine: tracks its config + lifecycle calls and lets the test push
// output through the bound handler.
class RecordingEngine implements AgentEngine {
  handler: EngineOutputHandler = () => {};
  started = 0;
  stopped = 0;
  aborted = 0;
  sent: string[] = [];
  model?: string;
  mode?: SessionMode;
  effort?: EffortLevel;
  rewoundFiles: string[] = [];
  points: RewindPoint[] = [];
  constructor(readonly cfg: { sessionId: string; resume: boolean; resumeSessionAt?: string }) {}
  onOutput(h: EngineOutputHandler): void {
    this.handler = h;
  }
  start(): void {
    this.started++;
  }
  sendUserMessage(text: string): void {
    this.sent.push(text);
  }
  respondPermission(): void {}
  abortError?: string;
  abort(): void {
    this.aborted++;
    if (this.abortError) throw new Error(this.abortError);
  }
  stop(): void {
    this.stopped++;
  }
  listModels(): Promise<ModelOption[]> {
    return Promise.resolve([{ id: 'm1', label: 'Model One', current: true }]);
  }
  setModel(id: string): void {
    this.model = id;
  }
  listCommands(): Promise<string[]> {
    return Promise.resolve(['/help — help']);
  }
  setPermissionMode(mode: SessionMode): void {
    this.mode = mode;
  }
  setEffort(level: EffortLevel): void {
    this.effort = level;
  }
  rewindPoints(): RewindPoint[] {
    return this.points;
  }
  rewindFilesError?: string;
  rewindFiles(id: string): Promise<RewindResult> {
    this.rewoundFiles.push(id);
    if (this.rewindFilesError) return Promise.reject(new Error(this.rewindFilesError));
    return Promise.resolve({ canRewind: true, filesChanged: 2, insertions: 3, deletions: 1 });
  }
  accountInfo(): Promise<Record<string, unknown> | undefined> {
    return Promise.resolve({ email: 'dev@example.com', subscription: 'pro' });
  }
  // Test seam: tests set this to control what the controller sees on resume.
  contextPercentValue?: number;
  contextPercentCalls = 0;
  getContextPercent(): Promise<number | undefined> {
    this.contextPercentCalls++;
    return Promise.resolve(this.contextPercentValue);
  }
}

function setup(
  sessions: SessionPreview[] = [],
  transcript: (id: string) => TranscriptEntry[] = () => [],
  latestTasks: (id: string) => TaskItem[] | undefined = () => undefined,
  label?: string,
) {
  const out: TerminalOutput[] = [];
  const engines: RecordingEngine[] = [];
  const controller = new SessionController(
    (cfg) => {
      const e = new RecordingEngine(cfg);
      engines.push(e);
      return e;
    },
    {
      emit: (o) => out.push(o),
      listSessions: () => sessions,
      readTranscript: transcript,
      readLatestTasks: latestTasks,
      initial: { sessionId: 'S0', resume: false },
      label,
    },
  );
  controller.start();
  return { controller, out, engines };
}

describe('rewindPointsFromTranscript', () => {
  it('keeps only user turns with a uuid, truncates long labels, falls back ts', () => {
    const long = 'x'.repeat(100);
    const pts = rewindPointsFromTranscript([
      { role: 'user', text: 'hi', uuid: 'u1', ts: 10 },
      { role: 'assistant', text: 'reply', uuid: 'a1', ts: 11 },
      { role: 'tool', text: 'Bash(ls)', uuid: 't1', ts: 12 },
      { role: 'user', text: long, uuid: 'u2' }, // no ts → fallback
      { role: 'user', text: 'no uuid', ts: 13 }, // dropped (no uuid)
    ]);
    expect(pts.map((p) => p.id)).toEqual(['u1', 'u2']);
    expect(pts[0]).toEqual({ id: 'u1', label: 'hi', ts: 10 });
    expect(pts[1]!.label).toBe(`${'x'.repeat(80)}…`);
    expect(pts[1]!.ts).toBeGreaterThan(0); // fell back to Date.now()
  });
});

describe('SessionController', () => {
  it('starts the initial engine and forwards messages/abort', () => {
    const { controller, engines } = setup();
    expect(engines[0]!.started).toBe(1);
    controller.dispatch({ type: 'message', text: 'hi' });
    expect(engines[0]!.sent).toEqual(['hi']);
    controller.dispatch({ type: 'abort' });
    expect(engines[0]!.aborted).toBe(1);
  });

  it('/resume (bare) emits the session list', () => {
    const sessions = [{ id: 's1', mtimeMs: 2, preview: 'fix bug' }];
    const { controller, out } = setup(sessions);
    controller.dispatch({ type: 'slash', command: 'resume' });
    expect(out).toContainEqual({ type: 'session_list', sessions });
  });

  it('resume selection swaps to the chosen session and resets', async () => {
    const { controller, out, engines } = setup();
    controller.dispatch({ type: 'slash', command: { name: 'resume', id: 'abc123ef-9999' } });
    await Promise.resolve();
    expect(engines[0]!.stopped).toBe(1);
    expect(engines[1]!.cfg).toEqual({ sessionId: 'abc123ef-9999', resume: true });
    expect(engines[1]!.started).toBe(1);
    expect(out.some((o) => o.type === 'notice' && o.kind === 'session_reset')).toBe(true);
  });

  it('/clear swaps to a fresh non-resumed session', async () => {
    const { controller, engines } = setup();
    controller.dispatch({ type: 'slash', command: 'clear' });
    await Promise.resolve();
    expect(engines[1]!.cfg.resume).toBe(false);
    expect(engines[1]!.cfg.sessionId).not.toBe('S0');
  });

  it('/clear resets the context bar to 0 (no stale value from the prior session)', async () => {
    const { controller, out } = setup();
    controller.dispatch({ type: 'slash', command: 'clear' });
    await Promise.resolve();
    expect(out).toContainEqual({ type: 'context_status', usedPercent: 0 });
  });

  it('resume queries getContextPercent and emits a fresh context_status', async () => {
    const { controller, out, engines } = setup();
    // Seed the next engine's response before the swap so the polling tick finds it.
    let next: RecordingEngine | undefined;
    const factoryHandle = (e: RecordingEngine): void => {
      next = e;
      e.contextPercentValue = 73;
    };
    // Re-wire the factory by intercepting the second engine via a small hack:
    // dispatch the swap, then set the value on the freshly-created engine before
    // its async refreshContextAfterResume tick polls.
    controller.dispatch({ type: 'slash', command: { name: 'resume', id: 'sess-abc' } });
    await Promise.resolve();
    factoryHandle(engines[1]!);
    next = engines[1]!;
    // refreshContextAfterResume schedules its first tick 100ms out; advance time.
    await new Promise((r) => setTimeout(r, 200));
    expect(next.contextPercentCalls).toBeGreaterThan(0);
    expect(out).toContainEqual({ type: 'context_status', usedPercent: 73 });
  });

  it('resume that gets undefined from getContextPercent keeps polling (then gives up quietly)', async () => {
    const { controller, out, engines } = setup();
    controller.dispatch({ type: 'slash', command: { name: 'resume', id: 'sess-xyz' } });
    await Promise.resolve();
    // Leave contextPercentValue undefined → polling never resolves. We don't
    // wait the full 5s in the test; just confirm no bogus context_status was emitted.
    await new Promise((r) => setTimeout(r, 400));
    expect(engines[1]!.contextPercentCalls).toBeGreaterThan(0);
    expect(out.filter((o) => o.type === 'context_status')).toHaveLength(0);
  });

  it('a throwing abort during a swap is caught (no crash) and surfaces a notice', async () => {
    const { controller, out, engines } = setup();
    engines[0]!.abortError = 'ProcessTransport is not ready for writing';
    controller.dispatch({ type: 'slash', command: 'clear' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      out.some((o) => o.type === 'notice' && /Command failed/.test((o as { text?: string }).text ?? '')),
    ).toBe(true);
  });

  it('does not double-emit output after a swap (old engine detached)', async () => {
    const { controller, out, engines } = setup();
    controller.dispatch({ type: 'slash', command: 'clear' });
    await Promise.resolve();
    out.length = 0;
    // The torn-down engine must no longer reach the sink.
    engines[0]!.handler({ type: 'content', role: 'assistant', text: 'stale' });
    engines[1]!.handler({ type: 'content', role: 'assistant', text: 'live' });
    expect(out).toEqual([{ type: 'content', role: 'assistant', text: 'live' }]);
  });

  it('/model lists, and a selection sets the model + notice', async () => {
    const { controller, out, engines } = setup();
    controller.dispatch({ type: 'slash', command: 'model' });
    await Promise.resolve();
    expect(out.some((o) => o.type === 'model_list')).toBe(true);
    controller.dispatch({ type: 'slash', command: { name: 'model', id: 'm9' } });
    expect(engines[0]!.model).toBe('m9');
    expect(out).toContainEqual({ type: 'notice', kind: 'info', text: 'Model set to m9' });
  });

  it('/cost re-emits the last cost, or notices when none yet', async () => {
    const { controller, out, engines } = setup();
    controller.dispatch({ type: 'slash', command: 'cost' });
    await Promise.resolve();
    expect(out).toContainEqual({ type: 'notice', kind: 'info', text: 'No cost recorded yet this session.' });
    const cost: TerminalOutput = { type: 'cost', inputTokens: 1, outputTokens: 2, totalUSD: 0.5 };
    engines[0]!.handler(cost);
    out.length = 0;
    controller.dispatch({ type: 'slash', command: 'cost' });
    await Promise.resolve();
    expect(out).toContainEqual(cost);
  });

  it('/help opens a Commands dialog', async () => {
    const { controller, out } = setup();
    controller.dispatch({ type: 'slash', command: 'help' });
    await Promise.resolve();
    expect(
      out.some((o) => o.type === 'notice' && o.kind === 'dialog' && o.title === 'Commands' && o.text.includes('/help — help')),
    ).toBe(true);
  });

  it('/status opens a Status dialog with account + model', async () => {
    const { controller, out } = setup();
    controller.dispatch({ type: 'slash', command: 'status' });
    await Promise.resolve();
    await Promise.resolve();
    const dialog = out.find((o) => o.type === 'notice' && o.kind === 'dialog' && o.title === 'Status');
    expect(dialog).toBeDefined();
    if (dialog && dialog.type === 'notice') {
      expect(dialog.text).toContain('dev@example.com');
      expect(dialog.text).toContain('Model:');
    }
  });

  it('/context opens a Context dialog with the last turn tokens', async () => {
    const { controller, out, engines } = setup();
    engines[0]!.handler({ type: 'context_status', usedPercent: 42 });
    engines[0]!.handler({ type: 'cost', inputTokens: 100, outputTokens: 20, totalUSD: 0.1, cacheRead: 5 });
    out.length = 0;
    controller.dispatch({ type: 'slash', command: 'context' });
    await Promise.resolve();
    const dialog = out.find((o) => o.type === 'notice' && o.kind === 'dialog' && o.title === 'Context');
    expect(dialog).toBeDefined();
    if (dialog && dialog.type === 'notice') {
      expect(dialog.text).toContain('42% used');
      expect(dialog.text).toContain('in 100');
    }
  });

  it('marks unsupported commands as such', async () => {
    const { controller, out } = setup();
    // /compact is no longer in this list — it's now forwarded to the engine as a
    // literal user message, relying on the CLI subprocess to intercept it the
    // same way the TUI does (SDK has no programmatic compact API).
    for (const cmd of ['config', 'fast'] as const) {
      controller.dispatch({ type: 'slash', command: cmd });
    }
    await Promise.resolve();
    expect(out.filter((o) => o.type === 'notice' && o.kind === 'unsupported')).toHaveLength(2);
  });

  it('/compact is forwarded to the engine as a literal user message', async () => {
    const { controller, engines } = setup();
    controller.dispatch({ type: 'slash', command: 'compact' });
    await Promise.resolve();
    expect(engines[0]!.sent).toContain('/compact');
  });

  it('mode_switch and effort reach the engine', () => {
    const { controller, engines } = setup();
    controller.dispatch({ type: 'mode_switch', mode: 'plan' });
    controller.dispatch({ type: 'effort', level: 'high' });
    expect(engines[0]!.mode).toBe('plan');
    expect(engines[0]!.effort).toBe('high');
  });

  it('esc_esc emits rewind points from the transcript (the SDK never streams the user prompts)', () => {
    const { controller, out } = setup([], () => [
      { role: 'user', text: 'first prompt', uuid: 'u1', ts: 1 },
      { role: 'assistant', text: 'sure', uuid: 'a1', ts: 2 },
      { role: 'tool', text: 'Bash(ls)', toolName: 'Bash', uuid: 't1', ts: 3 },
      { role: 'user', text: 'second prompt', uuid: 'u2', ts: 4 },
    ]);
    controller.dispatch({ type: 'shortcut', key: 'esc_esc' });
    expect(out).toContainEqual({
      type: 'rewind_options',
      points: [
        { id: 'u1', label: 'first prompt', ts: 1 },
        { id: 'u2', label: 'second prompt', ts: 4 },
      ],
    });
  });

  it('rewind restore_code calls rewindFiles and notices, without swapping', async () => {
    const { controller, engines } = setup();
    controller.dispatch({ type: 'rewind', action: 'restore_code', id: 'u1' });
    await Promise.resolve();
    expect(engines[0]!.rewoundFiles).toEqual(['u1']);
    expect(engines).toHaveLength(1); // no engine swap for code-only
  });

  it('a rejecting rewindFiles is caught (no crash) and surfaces a notice', async () => {
    const { controller, out, engines } = setup();
    engines[0]!.rewindFilesError = 'File rewinding is not enabled.';
    controller.dispatch({ type: 'rewind', action: 'restore_code', id: 'u1' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      out.some((o) => o.type === 'notice' && /Rewind failed/.test((o as { text?: string }).text ?? '')),
    ).toBe(true);
  });

  // A transcript with two complete turns + a third prompt, for rewind tests.
  const rewindTx = (): TranscriptEntry[] => [
    { role: 'user', text: 'p1', uuid: 'u1', ts: 1 },
    { role: 'assistant', text: 'a1', uuid: 'aa1', ts: 2 },
    { role: 'user', text: 'p2', uuid: 'u2', ts: 3 },
    { role: 'assistant', text: 'a2', uuid: 'aa2', ts: 4 },
    { role: 'user', text: 'p3', uuid: 'u3', ts: 5 },
  ];

  it('rewind restore_conversation resumes to *before* the message and prefills it', async () => {
    const { controller, out, engines } = setup([], rewindTx);
    controller.dispatch({ type: 'rewind', action: 'restore_conversation', id: 'u2' });
    await Promise.resolve();
    await Promise.resolve();
    // Resume to the previous entry (aa1), not u2 — so u2 isn't re-run; same session.
    expect(engines[1]!.cfg).toMatchObject({ resume: true, resumeSessionAt: 'aa1' });
    expect(engines[1]!.cfg.sessionId).toBe('S0');
    expect(out).toContainEqual({ type: 'input_prefill', text: 'p2' });
  });

  it('rewind restore_both rewinds files (at the chosen id) then resumes before it', async () => {
    const { controller, out, engines } = setup([], rewindTx);
    controller.dispatch({ type: 'rewind', action: 'restore_both', id: 'u3' });
    for (let i = 0; i < 6; i++) await Promise.resolve(); // rewindFiles + swap + emit
    expect(engines[0]!.rewoundFiles).toEqual(['u3']); // files revert at the chosen point
    expect(engines[1]!.cfg).toMatchObject({ resumeSessionAt: 'aa2' });
    expect(out).toContainEqual({ type: 'input_prefill', text: 'p3' });
  });

  it('rewind prefills the original text with newlines preserved', async () => {
    const tx = (): TranscriptEntry[] => [
      { role: 'user', text: 'one two', uuid: 'u1', ts: 1, rawText: 'one\ntwo' },
      { role: 'assistant', text: 'ok', uuid: 'aa1', ts: 2 },
      { role: 'user', text: 'line a line b', uuid: 'u2', ts: 3, rawText: 'line a\nline b' },
    ];
    const { controller, out } = setup([], tx);
    controller.dispatch({ type: 'rewind', action: 'restore_conversation', id: 'u2' });
    await Promise.resolve();
    await Promise.resolve();
    expect(out).toContainEqual({ type: 'input_prefill', text: 'line a\nline b' });
  });

  it('rewind to the first message starts fresh with it in the composer', async () => {
    const { controller, out, engines } = setup([], rewindTx);
    controller.dispatch({ type: 'rewind', action: 'restore_conversation', id: 'u1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(engines[1]!.cfg.resume).toBe(false);
    expect(engines[1]!.cfg.sessionId).not.toBe('S0');
    expect(out).toContainEqual({ type: 'input_prefill', text: 'p1' });
  });

  it('rewind cancel does nothing', async () => {
    const { controller, engines, out } = setup();
    controller.dispatch({ type: 'rewind', action: 'cancel' });
    await Promise.resolve();
    expect(engines).toHaveLength(1);
    expect(engines[0]!.rewoundFiles).toEqual([]);
    expect(out).toEqual([]);
  });

  it('replays the resumed session transcript after session_reset', async () => {
    const transcript: TranscriptEntry[] = [
      { role: 'user', text: 'old prompt', uuid: 'u1' },
      { role: 'assistant', text: 'old reply', uuid: 'a1' },
    ];
    const { controller, out } = setup([], () => transcript);
    out.length = 0;
    controller.dispatch({ type: 'slash', command: { name: 'resume', id: 'sess9' } });
    await Promise.resolve();
    // session_reset first, then the transcript content in order.
    const types = out.map((o) => o.type);
    expect(types[0]).toBe('notice');
    expect(out).toContainEqual({ type: 'content', role: 'user', text: 'old prompt' });
    expect(out).toContainEqual({ type: 'content', role: 'assistant', text: 'old reply' });
    expect(out.indexOf(out.find((o) => o.type === 'notice')!)).toBeLessThan(
      out.indexOf(out.find((o) => o.type === 'content' && o.role === 'user')!),
    );
  });

  it('rewind restore_conversation replays history up to *before* the chosen point', async () => {
    const transcript: TranscriptEntry[] = [
      { role: 'user', text: 'first', uuid: 'u1' },
      { role: 'assistant', text: 'r1', uuid: 'a1' },
      { role: 'user', text: 'second', uuid: 'u2' },
      { role: 'assistant', text: 'r2', uuid: 'a2' },
    ];
    const { controller, out } = setup([], () => transcript);
    out.length = 0;
    controller.dispatch({ type: 'rewind', action: 'restore_conversation', id: 'u2' });
    await Promise.resolve();
    await Promise.resolve();
    const texts = out.filter((o) => o.type === 'content').map((o) => (o as { text: string }).text);
    expect(texts).toEqual(['first', 'r1']); // history before u2 (resumed to a1)
    expect(out).toContainEqual({ type: 'input_prefill', text: 'second' });
  });

  it('a fresh /clear swap replays nothing', async () => {
    const { controller, out } = setup([], () => []);
    out.length = 0;
    controller.dispatch({ type: 'slash', command: 'clear' });
    await Promise.resolve();
    expect(out.filter((o) => o.type === 'content')).toEqual([]);
  });

  it('resume restores the task list after the transcript', async () => {
    const tasks: TaskItem[] = [{ content: 'a', status: 'in_progress', activeForm: 'doing a' }];
    const { controller, out } = setup([], () => [], () => tasks);
    out.length = 0;
    controller.dispatch({ type: 'slash', command: { name: 'resume', id: 'sess9' } });
    await Promise.resolve();
    expect(out).toContainEqual({ type: 'tasks', items: tasks });
  });
});

describe('session label', () => {
  it('emits an initial status carrying the label on start', () => {
    const { out } = setup([], () => [], () => undefined, 'feat-x');
    expect(out).toContainEqual({ type: 'status', state: 'idle', label: 'feat-x' });
  });

  it('emits no label status when none is set', () => {
    const { out } = setup();
    expect(out.some((o) => o.type === 'status' && 'label' in o && o.label !== undefined)).toBe(false);
  });
});
