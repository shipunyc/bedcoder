import { diffLines } from 'diff';
import type { DiffLine, SessionMode, TaskItem, TerminalOutput } from '@bedcoder/protocol';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

// The model's context window, by name. 1M for the [1m] variants, else 200k —
// correct for current Claude models; modelUsage refines it when the SDK gives it.
export function contextLimitFor(model?: string): number {
  return model && /1m|\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}

type UsageLike = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

// Prefer a real contextWindow from modelUsage (camel/snake), else the heuristic.
function contextWindowFrom(modelUsage?: Record<string, { contextWindow?: number; context_window?: number }>): number | undefined {
  if (!modelUsage) return undefined;
  let max = 0;
  for (const v of Object.values(modelUsage)) {
    const w = v?.contextWindow ?? v?.context_window;
    if (typeof w === 'number' && w > max) max = w;
  }
  return max > 0 ? max : undefined;
}

// Percent of the context window used this turn (input + cache ≈ context sent).
// undefined when there's no usage to report. Clamped 0–100.
export function percentUsed(
  usage?: UsageLike,
  model?: string,
  modelUsage?: Record<string, { contextWindow?: number; context_window?: number }>,
): number | undefined {
  if (!usage) return undefined;
  const used = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (used <= 0) return undefined;
  const limit = contextWindowFrom(modelUsage) ?? contextLimitFor(model);
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

function diffToLines(oldStr: string, newStr: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(oldStr, newStr)) {
    const op: DiffLine['op'] = part.added ? '+' : part.removed ? '-' : ' ';
    const ls = part.value.split('\n');
    if (ls.length && ls[ls.length - 1] === '') ls.pop(); // drop the trailing newline's empty
    for (const l of ls) out.push({ op, text: l });
  }
  return out;
}

function capDiff(lines: DiffLine[], cap: number): DiffLine[] {
  return lines.length <= cap
    ? lines
    : [...lines.slice(0, cap), { op: ' ', text: `…(${lines.length - cap} more lines)` }];
}

// Build a unified line diff for an edit tool (undefined for non-edit tools).
export function buildDiff(
  tool: string,
  input: unknown,
  cap = 200,
): { filePath?: string; lines: DiffLine[] } | undefined {
  if (!EDIT_TOOLS.has(tool)) return undefined;
  const i = asRecord(input) ?? {};
  const filePath = typeof i.file_path === 'string' ? i.file_path : undefined;
  let lines: DiffLine[];
  if (tool === 'Write') {
    lines = diffToLines('', typeof i.content === 'string' ? i.content : '');
  } else if (tool === 'MultiEdit') {
    lines = [];
    for (const e of Array.isArray(i.edits) ? i.edits : []) {
      const er = asRecord(e);
      lines.push(...diffToLines(strOf(er?.old_string), strOf(er?.new_string)));
    }
  } else {
    lines = diffToLines(strOf(i.old_string), strOf(i.new_string));
  }
  return { filePath, lines: capDiff(lines, cap) };
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// One content block of an assistant/user message.
interface SdkBlock {
  type: string;
  text?: string;
  id?: string; // tool_use: the tool call id
  name?: string; // tool_use: the tool name
  input?: Record<string, unknown>; // tool_use: the tool input
  tool_use_id?: string; // tool_result: the call it answers
  content?: unknown; // tool_result: the output (string | array of text blocks)
  is_error?: boolean; // tool_result: failure flag
}

// Read-only tools whose output is bulky + low-signal on a phone; their results
// are suppressed unless they errored.
const SUPPRESS_OUTPUT = new Set(['Read', 'Glob', 'LS', 'Grep', 'TodoWrite']);

// Minimal structural view of the Agent SDK messages we map. The real SDKMessage
// union is large; we read only the fields we need (DESIGN §3.5 / §3.6).
export interface SdkMessageLike {
  type: string;
  subtype?: string; // system message subtype, e.g. 'init'
  uuid?: string; // user/assistant message id (used for rewind points)
  model?: string; // present on system/init
  permissionMode?: string; // present on system/init
  message?: { role?: string; content?: string | SdkBlock[] };
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Per-model usage on `result`; carries the real context window when present
  // (camelCase per the .d.ts; read snake_case too defensively).
  modelUsage?: Record<string, { contextWindow?: number; context_window?: number }>;
  // User-message flags (SDKUserMessageReplay etc.). isReplay marks a replayed or
  // acknowledged user message; isSynthetic / tool_use_result mark non-prompt ones.
  isReplay?: boolean;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  // Partial-assistant streaming (type:'stream_event'); event is a raw Anthropic
  // streaming event. delta.type distinguishes text_delta from thinking_delta.
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

export function userText(content: string | SdkBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return '';
}

// A friendly per-tool description for the permission card.
function describeTool(tool: string, file?: string): string {
  switch (tool) {
    case 'ExitPlanMode':
      return 'Claude finished planning — review and choose how to proceed.';
    case 'Bash':
      return 'Run a shell command?';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return file ? `Edit ${file}?` : 'Edit a file?';
    case 'Read':
      return file ? `Read ${file}?` : 'Read a file?';
    default:
      return `Allow ${tool}?`;
  }
}

// Build a permission_request enriched from the tool input, so the card can show
// the command / file / plan instead of a bare "Allow X?". Pure + unit-tested.
export function buildPermissionRequest(requestId: string, tool: string, input: unknown): TerminalOutput {
  const i = asRecord(input) ?? {};
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  const filePath = str('file_path') ?? str('path');
  const diff = buildDiff(tool, input); // Edit/Write/MultiEdit → a diff supersedes the detail preview
  return {
    type: 'permission_request',
    requestId,
    tool,
    description: describeTool(tool, filePath),
    ...(str('command') ? { command: str('command') } : {}),
    ...(filePath ? { filePath } : {}),
    ...(str('plan') ? { plan: str('plan') } : {}),
    ...(diff ? { diff: diff.lines } : {}),
  };
}

// One running subagent, identified from a Task tool_use block.
export interface AgentStart {
  id: string;
  name: string;
  description?: string;
}

// The Task subagents launched by an assistant message (the SDK exposes no agent
// identity in the stream, so we read subagent_type/description off the call).
export function parseAgentStarts(msg: SdkMessageLike): AgentStart[] {
  if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) return [];
  const out: AgentStart[] = [];
  for (const b of msg.message.content) {
    if (b.type !== 'tool_use' || b.name !== 'Task' || typeof b.id !== 'string') continue;
    const i = asRecord(b.input) ?? {};
    out.push({
      id: b.id,
      name: typeof i.subagent_type === 'string' ? i.subagent_type : 'agent',
      ...(typeof i.description === 'string' ? { description: i.description } : {}),
    });
  }
  return out;
}

// The tool_use ids a synthetic user message answers (a tool finished).
export function toolResultIds(msg: SdkMessageLike): string[] {
  if (msg.type !== 'user' || !Array.isArray(msg.message?.content)) return [];
  const ids: string[] = [];
  for (const b of msg.message.content) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') ids.push(b.tool_use_id);
  }
  return ids;
}

// Flatten a tool_result block's content (string or array of text parts) to text.
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : ((asRecord(b)?.text as string | undefined) ?? ''))).join('');
  }
  return '';
}

// Cap tool output, keeping the head and tail (where the signal usually is).
export function truncateToolOutput(text: string, cap = 1500): string {
  const t = text.trimEnd();
  if (t.length <= cap) return t;
  const keep = Math.floor((cap - 40) / 2);
  const elided = t.length - keep * 2;
  return `${t.slice(0, keep)}\n…(${elided} chars elided)…\n${t.slice(-keep)}`;
}

// Parse the TodoWrite tool input into validated task items (skips malformed).
export function parseTodos(input: Record<string, unknown> | undefined): TaskItem[] {
  const raw = input?.todos;
  if (!Array.isArray(raw)) return [];
  const items: TaskItem[] = [];
  for (const t of raw) {
    const r = asRecord(t);
    const status = r?.status;
    if (typeof r?.content !== 'string' || typeof r?.activeForm !== 'string') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue;
    items.push({ content: r.content, status, activeForm: r.activeForm });
  }
  return items;
}

// A one-line summary of a tool call, e.g. "npm install" for Bash.
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const s = (k: string): string | undefined => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined);
  const arg =
    s('command') ?? s('file_path') ?? s('path') ?? s('pattern') ?? s('url') ?? s('description') ?? '';
  return arg ? `${name}(${arg})` : name;
}

// Map an SDK permission mode back to our wire mode (inverse of the agent mapping).
function sdkModeToSession(mode: string | undefined): SessionMode | undefined {
  switch (mode) {
    case 'acceptEdits':
      return 'auto_accept';
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
      return 'auto';
    case 'default':
      return 'normal';
    default:
      return undefined;
  }
}

// Map one SDK message to zero or more TerminalOutputs. One SDK message can yield
// several outputs (a `result` ends the turn, so it emits both the cost and a
// status reset to idle) or none if it carries nothing the app needs to render.
//
// `liveStarted` is false until the engine has sent a live user message. While it
// is false the only content the SDK produces is resume replay, which we suppress
// here — resumed history is sourced authoritatively from the session JSONL
// (SessionController.replayTranscript) to avoid double-painting. cost/status are
// always emitted (they keep the UI unstuck / seed the status line).
export function mapSdkMessage(
  msg: SdkMessageLike,
  opts: { liveStarted: boolean; toolNameFor?: (id?: string) => string | undefined } = { liveStarted: true },
): TerminalOutput[] {
  switch (msg.type) {
    case 'user': {
      // Typed user messages have string content (shown locally); tool results
      // arrive as synthetic user messages whose content is tool_result blocks.
      if (!opts.liveStarted) return []; // resume replay comes from JSONL
      const content = msg.message?.content;
      if (!Array.isArray(content)) return [];
      const out: TerminalOutput[] = [];
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const name = opts.toolNameFor?.(b.tool_use_id);
        const isError = b.is_error === true;
        if (name && SUPPRESS_OUTPUT.has(name) && !isError) continue; // noisy read-only tool
        const text = truncateToolOutput(toolResultText(b.content));
        if (!text) continue;
        out.push({ type: 'tool_output', text, ...(name ? { toolName: name } : {}), ...(isError ? { isError } : {}) });
      }
      return out;
    }
    case 'stream_event': {
      // Incremental assistant text. The full `assistant` message still arrives at
      // the end (the app replaces the streamed preview with it). thinking_delta is
      // skipped; gated like other content so resume replay doesn't stream.
      if (!opts.liveStarted) return [];
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        return [{ type: 'delta', text: ev.delta.text }];
      }
      return [];
    }
    case 'assistant': {
      if (!opts.liveStarted) return []; // pre-live = SDK resume replay; suppress
      const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
      const out: TerminalOutput[] = [];
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (text !== '') out.push({ type: 'content', role: 'assistant', text });
      // Surface each tool call as a one-line entry (its output arrives later).
      // TodoWrite is special-cased into the task list instead of a tool line.
      for (const b of blocks) {
        if (b.type !== 'tool_use' || !b.name) continue;
        if (b.name === 'TodoWrite') {
          out.push({ type: 'tasks', items: parseTodos(b.input) });
          continue;
        }
        const diff = buildDiff(b.name, b.input);
        if (diff) {
          out.push({ type: 'diff', ...(diff.filePath ? { filePath: diff.filePath } : {}), lines: diff.lines });
          continue;
        }
        out.push({ type: 'content', role: 'tool', text: summarizeTool(b.name, b.input), toolName: b.name });
      }
      return out;
    }
    case 'system': {
      // The init message carries the starting model + permission mode; seed the
      // status line (effort defaults to auto until the user changes it).
      if (msg.subtype && msg.subtype !== 'init') return [];
      if (!msg.model && !msg.permissionMode) return [];
      return [
        {
          type: 'status',
          state: 'idle',
          mode: sdkModeToSession(msg.permissionMode),
          model: msg.model,
          effort: 'auto',
        },
      ];
    }
    case 'result': {
      const u = msg.usage ?? {};
      // A result marks end-of-turn. Emit the cost, then return to idle so the
      // app stops showing "thinking" — even when the turn produced no assistant
      // text (e.g. a slash command the SDK swallowed).
      return [
        {
          type: 'cost',
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          totalUSD: msg.total_cost_usd ?? 0,
          cacheRead: u.cache_read_input_tokens,
          cacheCreation: u.cache_creation_input_tokens,
        },
        { type: 'status', state: 'idle' },
      ];
    }
    default:
      return [];
  }
}
