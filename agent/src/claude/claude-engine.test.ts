import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TerminalOutput } from '@bedcoder/protocol';

// Hoisted so the mock factory can reference it, and so logging is disabled before
// claude-engine.ts (which imports ../log at module load) is evaluated.
const { queryMock } = vi.hoisted(() => {
  process.env.BEDCODER_LOG = 'off';
  return { queryMock: vi.fn() };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import {
  ClaudeEngine,
  mapSessionModeToPermissionMode,
  tokensForEffort,
  derivePattern,
  buildPermissionResult,
} from './claude-engine';

describe('mapSessionModeToPermissionMode', () => {
  it('maps wire modes to SDK permission modes', () => {
    expect(mapSessionModeToPermissionMode('normal')).toBe('default');
    expect(mapSessionModeToPermissionMode('auto_accept')).toBe('acceptEdits');
    expect(mapSessionModeToPermissionMode('plan')).toBe('plan');
    expect(mapSessionModeToPermissionMode('auto')).toBe('bypassPermissions');
  });
});

describe('tokensForEffort', () => {
  it('maps effort levels to thinking-token budgets (auto = null)', () => {
    expect(tokensForEffort('auto')).toBeNull();
    expect(tokensForEffort('low')).toBeGreaterThan(0);
    expect(tokensForEffort('high')).toBeGreaterThan(tokensForEffort('medium') as number);
    expect(tokensForEffort('xhigh')).toBeGreaterThan(tokensForEffort('high') as number);
  });
});

describe('derivePattern', () => {
  it('picks Bash command and Edit/Read/Write file_path; returns undefined otherwise', () => {
    expect(derivePattern('Bash', { command: 'npm test' })).toBe('npm test');
    expect(derivePattern('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(derivePattern('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(derivePattern('Write', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(derivePattern('MultiEdit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(derivePattern('WebFetch', { url: 'https://x' })).toBeUndefined();
    expect(derivePattern('Bash', {})).toBeUndefined();
  });
});

describe('buildPermissionResult (Always persists a session rule)', () => {
  it("'allow' just allows, no rule attached", () => {
    expect(buildPermissionResult('Bash', { command: 'ls' }, 'allow')).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
  });

  it("'deny' returns a deny with a message", () => {
    expect(buildPermissionResult('Bash', { command: 'rm -rf /' }, 'deny')).toEqual({
      behavior: 'deny',
      message: 'denied by user',
    });
  });

  it("'always_allow' attaches a session rule (Bash → command pattern)", () => {
    const r = buildPermissionResult('Bash', { command: 'npm test' }, 'always_allow');
    expect(r).toMatchObject({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' },
      ],
    });
  });

  it("'always_allow' uses an explicit pattern if the app sent one (narrower than the derived default)", () => {
    const r = buildPermissionResult('Bash', { command: 'npm test --foo' }, 'always_allow', 'npm test:*');
    const rules = (r as { updatedPermissions: { rules: { ruleContent: string }[] }[] }).updatedPermissions[0]!.rules;
    expect(rules[0]!.ruleContent).toBe('npm test:*');
  });

  it("'always_allow' for a tool we can't pattern → toolName-only rule (broad allow)", () => {
    const r = buildPermissionResult('WebFetch', { url: 'https://x' }, 'always_allow');
    const rule = (r as { updatedPermissions: { rules: { toolName: string; ruleContent?: string }[] }[] })
      .updatedPermissions[0]!.rules[0]!;
    expect(rule.toolName).toBe('WebFetch');
    expect(rule.ruleContent).toBeUndefined();
  });
});

describe('ClaudeEngine stream-end handling', () => {
  beforeEach(() => queryMock.mockReset());

  function record(engine: ClaudeEngine): TerminalOutput[] {
    const outs: TerminalOutput[] = [];
    engine.onOutput((o) => outs.push(o));
    return outs;
  }

  it('surfaces an error + notice when the SDK stream ends unexpectedly (G1)', async () => {
    queryMock.mockReturnValue((async function* () {})()); // stream ends immediately
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);

    await engine.start();

    expect(outs).toContainEqual({ type: 'status', state: 'error' });
    expect(outs.some((o) => o.type === 'notice')).toBe(true);
  });

  it('reports a dead session on the next message instead of hanging on thinking (G2)', async () => {
    queryMock.mockReturnValue((async function* () {})());
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    await engine.start();

    const before = outs.length;
    engine.sendUserMessage('继续');
    const after = outs.slice(before);

    expect(after.some((o) => o.type === 'status' && o.state === 'error')).toBe(true);
    expect(after.some((o) => o.type === 'notice')).toBe(true);
    // Crucially, it must NOT enter "thinking" (that is the stuck state).
    expect(after.some((o) => o.type === 'status' && o.state === 'thinking')).toBe(false);
  });

  it('marks the engine dead when the stream errors (subprocess exit), not hanging the next message', async () => {
    queryMock.mockReturnValue(
      // eslint-disable-next-line require-yield -- models a stream that throws immediately
      (async function* () {
        throw new Error('Claude Code process exited with code 1');
      })(),
    );
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);

    // start() rethrows so the controller can surface the real error.
    await expect(engine.start()).rejects.toThrow('exited with code 1');

    // The next message must report a dead session, not yield into the gone SDK
    // (which would silently lose it and hang the app on "thinking").
    const before = outs.length;
    engine.sendUserMessage('继续');
    const after = outs.slice(before);
    expect(after.some((o) => o.type === 'notice')).toBe(true);
    expect(after.some((o) => o.type === 'status' && o.state === 'thinking')).toBe(false);
  });

  it('abort resolves a pending permission promise as deny (so the next turn can proceed)', async () => {
    // Gated empty stream so start() hangs until released — gives us time to
    // capture canUseTool and exercise abort while a permission is in flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await gate;
          return { value: undefined, done: true };
        },
      }),
    });

    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const started = engine.start();
    // Wait until start() reaches the query() call (an await import precedes it).
    for (let i = 0; i < 50 && queryMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // Pull canUseTool out of the captured query() call args.
    const call = queryMock.mock.calls[0]?.[0] as { options?: { canUseTool?: (t: string, i: unknown) => Promise<unknown> } };
    const canUseTool = call?.options?.canUseTool;
    expect(canUseTool).toBeDefined();

    // The SDK asks for permission; without abort this promise would hang forever.
    const decisionP = canUseTool!('Bash', { command: 'ls' });
    engine.abort();
    await expect(decisionP).resolves.toEqual({ behavior: 'deny', message: 'denied by user' });

    engine.stop();
    release();
    await started;
  });

  it('does not raise an error when stop() ends the stream normally', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // An async iterable that stays open until the gate opens, then completes —
    // models a stream that ends because we closed it, not because it died.
    queryMock.mockReturnValue({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await gate;
          return { value: undefined, done: true };
        },
      }),
    });

    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    const started = engine.start();

    engine.stop(); // closed = true → a clean shutdown
    release(); // let the SDK stream complete
    await started;

    expect(outs.some((o) => o.type === 'status' && o.state === 'error')).toBe(false);
  });

  it('keeps the live turn "thinking" when system/init arrives after the first message', async () => {
    // In streaming-input mode the SDK emits system/init right after the first
    // user message — it must seed config without resetting "thinking" to idle.
    queryMock.mockReturnValue(
      (async function* () {
        yield { type: 'system', subtype: 'init', model: 'claude-x', permissionMode: 'default' };
      })(),
    );
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    engine.sendUserMessage('hi'); // sets state = thinking
    await engine.start();

    // The status seeded by init carries the model but must remain "thinking".
    const seeded = outs.find((o) => o.type === 'status' && o.model === 'claude-x') as
      | { state: string }
      | undefined;
    expect(seeded?.state).toBe('thinking');
    // No idle should be emitted mid-turn (the bug was init clobbering thinking).
    expect(outs.some((o) => o.type === 'status' && o.state === 'idle')).toBe(false);
  });

  it('emits context_status off a compact_boundary so the bar refreshes after /compact', async () => {
    // The compact's own `result` typically has zero `usage` (the CLI summarized
    // in-memory, no fresh input was sent), so the result path wouldn't refresh
    // the context bar — the boundary message is the only authoritative signal
    // for the new post-compact size.
    queryMock.mockReturnValue(
      (async function* () {
        // System/init seeds currentModel so the percentage uses the right limit.
        yield { type: 'system', subtype: 'init', model: 'claude-sonnet-4-6', permissionMode: 'default' };
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { pre_tokens: 46_000, post_tokens: 10_000 },
        };
        yield { type: 'result', total_cost_usd: 0 }; // no usage → result path can't refresh
      })(),
    );
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    engine.sendUserMessage('/compact');
    await engine.start();

    // 10_000 / 200_000 = 5%
    const ctx = outs.filter((o) => o.type === 'context_status') as Array<{ usedPercent: number }>;
    expect(ctx).toHaveLength(1);
    expect(ctx[0]!.usedPercent).toBe(5);
  });

  it('coalesces streamed text deltas and emits them before the final content', async () => {
    const ev = (text: string) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    queryMock.mockReturnValue(
      (async function* () {
        yield ev('he');
        yield ev('llo');
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
        yield { type: 'result', total_cost_usd: 0 };
      })(),
    );
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    engine.sendUserMessage('hi'); // liveStarted=true so deltas aren't gated as replay
    await engine.start();

    const deltas = outs.filter((o) => o.type === 'delta') as Array<{ text: string }>;
    expect(deltas.map((d) => d.text).join('')).toBe('hello'); // coalesced (1+ chunks)
    const deltaIdx = outs.findIndex((o) => o.type === 'delta');
    const contentIdx = outs.findIndex((o) => o.type === 'content' && o.role === 'assistant');
    expect(deltaIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeLessThan(contentIdx); // streamed text precedes the final message
  });

  it('tracks a Task subagent: emits running, then empty when it finishes', async () => {
    queryMock.mockReturnValue(
      (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'researcher', description: 'dig' } }] } };
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found' }] } };
        yield { type: 'result', total_cost_usd: 0 };
      })(),
    );
    const engine = new ClaudeEngine({ sessionId: 's1', resume: false });
    const outs = record(engine);
    engine.sendUserMessage('go'); // liveStarted=true so agents aren't gated
    await engine.start();

    const agentEmits = outs.filter((o) => o.type === 'agents') as Array<{ running: unknown[] }>;
    expect(agentEmits.length).toBeGreaterThanOrEqual(2);
    expect(agentEmits[0]!.running).toEqual([{ id: 't1', name: 'researcher', description: 'dig' }]);
    expect(agentEmits[agentEmits.length - 1]!.running).toEqual([]); // cleared when done
  });

  it('pins the session id for new sessions via --session-id (invariant 4)', async () => {
    queryMock.mockReturnValue((async function* () {})());
    const engine = new ClaudeEngine({ sessionId: 'my-fixed-id', resume: false });
    record(engine);
    await engine.start();

    const params = queryMock.mock.calls[0]![0] as {
      options: { extraArgs?: Record<string, string | null>; resume?: string };
    };
    // Without this, the SDK uuidgens its own id and the jsonl lands under a
    // different name — breaking `claude --resume <id>` from the desk.
    expect(params.options.extraArgs).toEqual({ 'session-id': 'my-fixed-id' });
    expect(params.options.resume).toBeUndefined();
  });

  it('passes resume (not --session-id) when resuming, so the same file is loaded', async () => {
    queryMock.mockReturnValue((async function* () {})());
    const engine = new ClaudeEngine({ sessionId: 'existing-id', resume: true });
    record(engine);
    await engine.start();

    const params = queryMock.mock.calls[0]![0] as {
      options: { extraArgs?: Record<string, string | null>; resume?: string };
    };
    expect(params.options.resume).toBe('existing-id');
    // Combining --session-id with --resume requires --fork-session; we don't.
    expect(params.options.extraArgs).toBeUndefined();
  });

  it('pins the configured model and lists the catalog', async () => {
    queryMock.mockReturnValue((async function* () {})());
    const engine = new ClaudeEngine({
      sessionId: 's1',
      resume: false,
      model: 'claude-opus-4-7',
      models: [
        { id: 'claude-opus-4-7', label: 'Opus 4.7' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      ],
    });
    record(engine);
    await engine.start();

    const params = queryMock.mock.calls[0]![0] as { options: { model?: string } };
    expect(params.options.model).toBe('claude-opus-4-7');

    const models = await engine.listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
    expect(models.find((m) => m.id === 'claude-opus-4-7')?.current).toBe(true);
  });
});
