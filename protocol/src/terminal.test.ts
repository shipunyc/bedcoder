import { describe, it, expect } from 'vitest';
import {
  terminalInputSchema,
  terminalOutputSchema,
  type TerminalInput,
  type TerminalOutput,
} from './terminal';

const validInputs: TerminalInput[] = [
  { type: 'message', text: 'hi' },
  { type: 'permission', requestId: 'r1', decision: 'allow' },
  { type: 'permission', requestId: 'r1', decision: 'always_allow', pattern: 'Bash(*)' },
  { type: 'shortcut', key: 'ctrl+c' },
  { type: 'slash', command: 'compact' },
  { type: 'slash', command: 'context' },
  { type: 'slash', command: 'resume' },
  { type: 'slash', command: 'model' },
  { type: 'slash', command: { name: 'resume', id: 's1' } },
  { type: 'slash', command: { name: 'model', id: 'claude-opus-4-7' } },
  { type: 'mode_switch', mode: 'plan' },
  { type: 'mode_switch', mode: 'auto' },
  { type: 'effort', level: 'high' },
  { type: 'effort', level: 'xhigh' },
  { type: 'abort' },
  { type: 'rewind', action: 'restore_both' },
  { type: 'rewind', action: 'restore_conversation', id: 'uuid-1' },
  { type: 'terminal_switch', terminalId: 't1' },
  { type: 'terminal_input', terminalId: 't1', data: 'ls\n' },
  { type: 'terminal_kill', terminalId: 't1' },
  { type: 'terminal_resize', terminalId: 't1', rows: 24, cols: 80 },
];

const validOutputs: TerminalOutput[] = [
  { type: 'content', role: 'assistant', text: 'hello' },
  { type: 'content', role: 'tool', text: 'out', toolName: 'Bash' },
  { type: 'content', role: 'user', text: 'replayed turn' },
  { type: 'delta', text: 'partial ' },
  {
    type: 'tasks',
    items: [{ content: 'do it', status: 'in_progress', activeForm: 'doing it' }],
  },
  { type: 'tool_output', text: 'stdout…', toolName: 'Bash' },
  { type: 'tool_output', text: 'ENOENT', toolName: 'Read', isError: true },
  {
    type: 'diff',
    filePath: 'src/a.ts',
    lines: [{ op: ' ', text: 'ctx' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }],
  },
  { type: 'context_status', usedPercent: 42 },
  { type: 'agents', running: [{ id: 't1', name: 'researcher', description: 'dig' }] },
  { type: 'permission_request', requestId: 'r1', tool: 'Bash', description: 'run npm i', command: 'npm i' },
  {
    type: 'permission_request',
    requestId: 'r2',
    tool: 'ExitPlanMode',
    description: 'review the plan',
    plan: '# Plan\n1. do a thing',
  },
  { type: 'status', state: 'thinking' },
  { type: 'status', state: 'idle', mode: 'auto_accept' },
  { type: 'status', state: 'idle', mode: 'plan', model: 'claude-opus-4-7', effort: 'auto' },
  { type: 'status', state: 'idle', label: 'feat-x' },
  { type: 'cost', inputTokens: 10, outputTokens: 20, totalUSD: 0.42 },
  { type: 'context_status', usedPercent: 42 },
  { type: 'rewind_options', points: [{ id: 'p1', label: 'before edit', ts: 1 }] },
  {
    type: 'terminal_list',
    terminals: [{ id: 't1', command: 'npm run dev', state: 'running', port: 3000, startedAt: 1700000000, lastOutput: 'ready' }],
  },
  { type: 'terminal_output', terminalId: 't1', data: 'foo', ansi: true, seq: 0 },
  { type: 'terminal_output', terminalId: 't1', data: 'bar', ansi: false },
  {
    type: 'session_list',
    sessions: [{ id: 's1', mtimeMs: 1_700_000_000_000, preview: 'fix the dart2js bug' }],
  },
  {
    type: 'model_list',
    models: [{ id: 'default', label: 'Default', detail: 'Claude Opus 4.7', current: true }],
  },
  { type: 'notice', kind: 'session_reset', text: 'Resumed s1', sessionId: 's1' },
  { type: 'notice', kind: 'info', text: 'Model set to Opus 4.7' },
  { type: 'notice', kind: 'unsupported', text: '/compact is not supported yet' },
  { type: 'notice', kind: 'dialog', title: 'Commands', text: '/help — show commands' },
];

describe('terminalInputSchema', () => {
  it.each(validInputs)('accepts %o', (input) => {
    expect(() => terminalInputSchema.parse(input)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => terminalInputSchema.parse({ type: 'nope' })).toThrow();
  });

  it('rejects a missing required field', () => {
    expect(() => terminalInputSchema.parse({ type: 'message' })).toThrow();
  });

  it('rejects a bad enum value', () => {
    expect(() => terminalInputSchema.parse({ type: 'shortcut', key: 'ctrl+x' })).toThrow();
  });
});

describe('terminalOutputSchema', () => {
  it.each(validOutputs)('accepts %o', (output) => {
    expect(() => terminalOutputSchema.parse(output)).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() => terminalOutputSchema.parse({ type: 'nope' })).toThrow();
  });

  it('rejects a bad agent state', () => {
    expect(() => terminalOutputSchema.parse({ type: 'status', state: 'sleeping' })).toThrow();
  });

  it('rejects a malformed hosted terminal', () => {
    expect(() =>
      terminalOutputSchema.parse({ type: 'terminal_list', terminals: [{ id: 't1' }] }),
    ).toThrow();
  });

  it('rejects a bad notice kind', () => {
    expect(() => terminalOutputSchema.parse({ type: 'notice', kind: 'boom', text: 'x' })).toThrow();
  });

  it('rejects a bad effort level on status', () => {
    expect(() => terminalOutputSchema.parse({ type: 'status', state: 'idle', effort: 'max' })).toThrow();
  });
});
