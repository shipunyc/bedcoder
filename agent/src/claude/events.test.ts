import { describe, it, expect } from 'vitest';
import {
  buildDiff,
  buildPermissionRequest,
  contextLimitFor,
  mapSdkMessage,
  parseAgentStarts,
  percentUsed,
  toolResultIds,
  truncateToolOutput,
} from './events';

describe('subagents', () => {
  it('parseAgentStarts: Task tool_use → {id,name,description}; ignores non-Task', () => {
    expect(
      parseAgentStarts({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 't1', name: 'Task', input: { subagent_type: 'researcher', description: 'find it' } },
            { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    ).toEqual([{ id: 't1', name: 'researcher', description: 'find it' }]);
    expect(parseAgentStarts({ type: 'user', message: { content: 'hi' } })).toEqual([]);
  });

  it('toolResultIds: the ids a synthetic user message answers', () => {
    expect(
      toolResultIds({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      }),
    ).toEqual(['t1']);
    expect(toolResultIds({ type: 'assistant', message: { content: [] } })).toEqual([]);
  });
});

describe('context window', () => {
  it('contextLimitFor: 1M for [1m] models, else 200k', () => {
    expect(contextLimitFor('claude-opus-4-7[1m]')).toBe(1_000_000);
    expect(contextLimitFor('claude-sonnet-4-6')).toBe(200_000);
    expect(contextLimitFor(undefined)).toBe(200_000);
  });

  it('percentUsed: input+cache over the limit, clamped; undefined when empty', () => {
    expect(percentUsed(undefined, 'claude-sonnet-4-6')).toBeUndefined();
    expect(percentUsed({ input_tokens: 0 }, 'claude-sonnet-4-6')).toBeUndefined();
    // 100k of 200k = 50%
    expect(
      percentUsed({ input_tokens: 40_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000 }, 'claude-sonnet-4-6'),
    ).toBe(50);
    // clamps to 100
    expect(percentUsed({ input_tokens: 999_999 }, 'claude-sonnet-4-6')).toBe(100);
    // modelUsage.contextWindow overrides the heuristic
    expect(percentUsed({ input_tokens: 500_000 }, 'm', { m: { contextWindow: 1_000_000 } })).toBe(50);
  });
});

describe('mapSdkMessage', () => {
  it('joins assistant text blocks into content', () => {
    const out = mapSdkMessage({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use' },
        ],
      },
    });
    expect(out).toEqual([{ type: 'content', role: 'assistant', text: 'hello world' }]);
  });

  it('returns nothing for an assistant message with no text', () => {
    expect(mapSdkMessage({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })).toEqual([]);
  });

  it('maps a result to cost then idle (end of turn)', () => {
    const out = mapSdkMessage({
      type: 'result',
      total_cost_usd: 0.42,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    });
    expect(out[0]).toMatchObject({ type: 'cost', inputTokens: 10, outputTokens: 20, totalUSD: 0.42, cacheRead: 5 });
    // The turn is over; the agent must hand the app back to idle even when there
    // was no assistant text, or the app sticks on "thinking".
    expect(out[1]).toEqual({ type: 'status', state: 'idle' });
  });

  it('returns nothing for unknown message types', () => {
    expect(mapSdkMessage({ type: 'system' })).toEqual([]);
  });

  it('emits a tool line for each tool_use block, after any text', () => {
    const out = mapSdkMessage({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'running it' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm install' } },
          { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } },
        ],
      },
    });
    expect(out).toEqual([
      { type: 'content', role: 'assistant', text: 'running it' },
      { type: 'content', role: 'tool', text: 'Bash(npm install)', toolName: 'Bash' },
      { type: 'content', role: 'tool', text: 'Read(README.md)', toolName: 'Read' },
    ]);
  });

  it('maps a TodoWrite tool_use to tasks (not a 🔧 line) and keeps other tools', () => {
    const out = mapSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            {
              type: 'tool_use',
              name: 'TodoWrite',
              input: {
                todos: [
                  { content: 'a', status: 'completed', activeForm: 'doing a' },
                  { content: 'b', status: 'in_progress', activeForm: 'doing b' },
                  { content: 'bad', status: 'nope', activeForm: 'x' }, // dropped
                ],
              },
            },
          ],
        },
      },
      { liveStarted: true },
    );
    expect(out).toEqual([
      { type: 'content', role: 'tool', text: 'Bash(ls)', toolName: 'Bash' },
      {
        type: 'tasks',
        items: [
          { content: 'a', status: 'completed', activeForm: 'doing a' },
          { content: 'b', status: 'in_progress', activeForm: 'doing b' },
        ],
      },
    ]);
  });

  it('seeds the status line from system/init (model + permission mode)', () => {
    const out = mapSdkMessage({ type: 'system', subtype: 'init', model: 'claude-opus-4-7', permissionMode: 'plan' });
    expect(out).toEqual([{ type: 'status', state: 'idle', mode: 'plan', model: 'claude-opus-4-7', effort: 'auto' }]);
  });
});

describe('buildPermissionRequest', () => {
  it('forwards the Bash command', () => {
    expect(buildPermissionRequest('r1', 'Bash', { command: 'npm install' })).toMatchObject({
      type: 'permission_request',
      requestId: 'r1',
      tool: 'Bash',
      command: 'npm install',
    });
  });

  it('forwards the file path + a diff for edits', () => {
    const out = buildPermissionRequest('r2', 'Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' });
    expect(out).toMatchObject({ filePath: 'src/a.ts' });
    expect((out as { diff?: unknown[] }).diff).toEqual([
      { op: '-', text: 'a' },
      { op: '+', text: 'b' },
    ]);
    expect((out as { detail?: string }).detail).toBeUndefined();
  });

  it('forwards the plan for ExitPlanMode', () => {
    const out = buildPermissionRequest('r3', 'ExitPlanMode', { plan: '# Plan\n- step' });
    expect(out).toMatchObject({ tool: 'ExitPlanMode', plan: '# Plan\n- step' });
  });

  it('builds diffs for edit tools (and nothing for others)', () => {
    expect(buildDiff('Bash', { command: 'ls' })).toBeUndefined();
    expect(buildDiff('Edit', { file_path: 'a', old_string: 'x', new_string: 'y' })).toEqual({
      filePath: 'a',
      lines: [{ op: '-', text: 'x' }, { op: '+', text: 'y' }],
    });
    // Write = all-added.
    expect(buildDiff('Write', { file_path: 'b', content: 'l1\nl2' })?.lines).toEqual([
      { op: '+', text: 'l1' },
      { op: '+', text: 'l2' },
    ]);
    // MultiEdit concatenates per-edit diffs.
    expect(
      buildDiff('MultiEdit', { file_path: 'c', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })?.lines,
    ).toEqual([
      { op: '-', text: 'a' },
      { op: '+', text: 'b' },
      { op: '-', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    // cap adds a truncation marker.
    const big = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
    const capped = buildDiff('Write', { content: big }, 10)!.lines;
    expect(capped.length).toBe(11);
    expect(capped[10]!.text).toContain('more lines');
  });

  it('an Edit tool_use emits a diff instead of a tool line', () => {
    const out = mapSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a', old_string: 'x', new_string: 'y' } }] },
      },
      { liveStarted: true },
    );
    expect(out).toEqual([
      { type: 'diff', filePath: 'a', lines: [{ op: '-', text: 'x' }, { op: '+', text: 'y' }] },
    ]);
  });

  it('falls back to a generic description with no extra fields', () => {
    const out = buildPermissionRequest('r4', 'WebFetch', { url: 'https://x' });
    expect(out).toEqual({ type: 'permission_request', requestId: 'r4', tool: 'WebFetch', description: 'Allow WebFetch?' });
  });

  it('never renders user turns from the SDK stream (shown locally / via JSONL replay)', () => {
    expect(mapSdkMessage({ type: 'user', message: { content: 'live' } }, { liveStarted: true })).toEqual([]);
    expect(
      mapSdkMessage({ type: 'user', isReplay: true, message: { content: 'old' } }, { liveStarted: false }),
    ).toEqual([]);
  });

  it('maps a text_delta stream_event to a delta (and skips thinking/boundaries)', () => {
    const ev = (delta: { type?: string; text?: string }) => ({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta },
    });
    expect(mapSdkMessage(ev({ type: 'text_delta', text: 'hi' }), { liveStarted: true })).toEqual([
      { type: 'delta', text: 'hi' },
    ]);
    expect(mapSdkMessage(ev({ type: 'thinking_delta', text: 'hmm' }), { liveStarted: true })).toEqual([]);
    expect(mapSdkMessage({ type: 'stream_event', event: { type: 'message_stop' } }, { liveStarted: true })).toEqual([]);
    // gated before live input (resume replay)
    expect(mapSdkMessage(ev({ type: 'text_delta', text: 'hi' }), { liveStarted: false })).toEqual([]);
  });

  it('suppresses assistant + tool content before live input (SDK resume replay)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'replayed' }, { type: 'tool_use', name: 'Bash', input: {} }] },
    };
    expect(mapSdkMessage(msg, { liveStarted: false })).toEqual([]);
    expect(mapSdkMessage(msg, { liveStarted: true })).toEqual([
      { type: 'content', role: 'assistant', text: 'replayed' },
      { type: 'content', role: 'tool', text: 'Bash', toolName: 'Bash' },
    ]);
  });

  it('maps a tool_result user message to tool_output (with name + error), gated + suppressed', () => {
    const userMsg = (block: { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }) => ({
      type: 'user',
      message: { content: [block] },
    });
    const nameFor = (id?: string) => (id === 'b1' ? 'Bash' : id === 'r1' ? 'Read' : undefined);

    // Bash result → tool_output with toolName.
    expect(
      mapSdkMessage(userMsg({ type: 'tool_result', tool_use_id: 'b1', content: 'done' }), {
        liveStarted: true,
        toolNameFor: nameFor,
      }),
    ).toEqual([{ type: 'tool_output', text: 'done', toolName: 'Bash' }]);

    // Read result is suppressed (noisy read-only)…
    expect(
      mapSdkMessage(userMsg({ type: 'tool_result', tool_use_id: 'r1', content: 'big file' }), {
        liveStarted: true,
        toolNameFor: nameFor,
      }),
    ).toEqual([]);
    // …unless it errored.
    expect(
      mapSdkMessage(userMsg({ type: 'tool_result', tool_use_id: 'r1', content: 'ENOENT', is_error: true }), {
        liveStarted: true,
        toolNameFor: nameFor,
      }),
    ).toEqual([{ type: 'tool_output', text: 'ENOENT', toolName: 'Read', isError: true }]);

    // Typed user text (string content) and pre-live replay produce nothing.
    expect(mapSdkMessage({ type: 'user', message: { content: 'hello' } }, { liveStarted: true })).toEqual([]);
    expect(
      mapSdkMessage(userMsg({ type: 'tool_result', tool_use_id: 'b1', content: 'x' }), { liveStarted: false }),
    ).toEqual([]);
  });

  it('truncateToolOutput keeps head + tail under the cap', () => {
    const long = 'x'.repeat(5000);
    const out = truncateToolOutput(long);
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain('elided');
    expect(truncateToolOutput('short')).toBe('short');
  });

  it('always emits cost/idle and status, even before live input', () => {
    expect(mapSdkMessage({ type: 'result', total_cost_usd: 0.1 }, { liveStarted: false })).toEqual([
      { type: 'cost', inputTokens: 0, outputTokens: 0, totalUSD: 0.1, cacheRead: undefined, cacheCreation: undefined },
      { type: 'status', state: 'idle' },
    ]);
    expect(
      mapSdkMessage({ type: 'system', subtype: 'init', model: 'm', permissionMode: 'plan' }, { liveStarted: false }),
    ).toEqual([{ type: 'status', state: 'idle', mode: 'plan', model: 'm', effort: 'auto' }]);
  });
});
