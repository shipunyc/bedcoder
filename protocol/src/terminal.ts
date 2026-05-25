import { z } from 'zod';

// Terminal channel payloads (DESIGN §4.2). These are the *plaintext* that the
// crypto layer JSON-encodes then encrypts into Envelope.encrypted — they are not
// msgpack-framed themselves.

export const shortcutKeySchema = z.enum([
  'ctrl+c', 'ctrl+d', 'ctrl+f_f',
  'esc', 'esc_esc',
  'tab', 'shift+tab', 'enter',
  'up', 'down',
]);
export type ShortcutKey = z.infer<typeof shortcutKeySchema>;

export const slashCommandSchema = z.union([
  // Bare name = "run now" or "open the picker" (resume/model).
  z.enum(['compact', 'clear', 'cost', 'config', 'status', 'context', 'help', 'fast', 'model', 'resume']),
  // Object forms carry a selection made in a picker (see session_list/model_list).
  z.object({ name: z.literal('resume'), id: z.string() }),
  z.object({ name: z.literal('model'), id: z.string() }),
]);
export type SlashCommand = z.infer<typeof slashCommandSchema>;

export const rewindActionSchema = z.enum([
  'restore_both', 'restore_conversation', 'restore_code', 'summarize', 'cancel',
]);
export type RewindAction = z.infer<typeof rewindActionSchema>;

// Permission modes. 'auto' = fully automatic (never asks; SDK bypassPermissions).
export const sessionModeSchema = z.enum(['normal', 'auto_accept', 'plan', 'auto']);
export type SessionMode = z.infer<typeof sessionModeSchema>;

// Thinking-effort levels; the agent maps these to a thinking-token budget.
export const effortLevelSchema = z.enum(['auto', 'low', 'medium', 'high', 'xhigh']);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

// One line of a rendered diff: '+' added, '-' removed, ' ' context.
export const diffLineSchema = z.object({ op: z.enum(['+', '-', ' ']), text: z.string() });
export type DiffLine = z.infer<typeof diffLineSchema>;

// One entry of the task list (mirrors the TodoWrite tool's items).
export const taskItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string(),
});
export type TaskItem = z.infer<typeof taskItemSchema>;

export const agentStateSchema = z.enum(['idle', 'thinking', 'tool_use', 'permission', 'error']);
export type AgentState = z.infer<typeof agentStateSchema>;

// A bash child process tracked by the agent, surfaced to the Mirror tab.
export const hostedTerminalSchema = z.object({
  id: z.string(),
  command: z.string(),
  state: z.enum(['running', 'exited']),
  exitCode: z.number().int().optional(),
  port: z.number().int().optional(),
  startedAt: z.number().int(), // Unix timestamp in seconds
  lastOutput: z.string(),
});
export type HostedTerminal = z.infer<typeof hostedTerminalSchema>;

// RewindPoint is not fully specified in DESIGN; this is a provisional shape.
export const rewindPointSchema = z.object({
  id: z.string(),
  label: z.string(),
  ts: z.number().int(),
});
export type RewindPoint = z.infer<typeof rewindPointSchema>;

// App → Agent
export const terminalInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({
    type: z.literal('permission'),
    requestId: z.string(),
    decision: z.enum(['allow', 'deny', 'always_allow']),
    pattern: z.string().optional(),
  }),
  z.object({ type: z.literal('shortcut'), key: shortcutKeySchema }),
  z.object({ type: z.literal('slash'), command: slashCommandSchema }),
  z.object({ type: z.literal('mode_switch'), mode: sessionModeSchema }),
  z.object({ type: z.literal('effort'), level: effortLevelSchema }),
  z.object({ type: z.literal('abort') }),
  // id is the chosen rewind point (a user-message uuid); omitted for 'cancel'.
  z.object({ type: z.literal('rewind'), action: rewindActionSchema, id: z.string().optional() }),
  z.object({ type: z.literal('terminal_switch'), terminalId: z.string() }),
  z.object({ type: z.literal('terminal_input'), terminalId: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal_kill'), terminalId: z.string() }),
  z.object({
    type: z.literal('terminal_resize'),
    terminalId: z.string(),
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
  }),
]);
export type TerminalInput = z.infer<typeof terminalInputSchema>;

// Agent → App
export const terminalOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('content'),
    // 'user' is used when replaying a resumed conversation's history.
    role: z.enum(['assistant', 'tool', 'user']),
    text: z.string(),
    toolName: z.string().optional(),
  }),
  // Incremental assistant text streamed during a turn; the app shows a live
  // preview and replaces it with the final `content` message.
  z.object({ type: z.literal('delta'), text: z.string() }),
  // The current task list (from the TodoWrite tool); replaces the prior list.
  z.object({ type: z.literal('tasks'), items: z.array(taskItemSchema) }),
  // A tool's result/output (arrives after the tool call completes).
  z.object({
    type: z.literal('tool_output'),
    text: z.string(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
  }),
  // A code change (Edit/Write/MultiEdit) rendered as a unified diff.
  z.object({ type: z.literal('diff'), filePath: z.string().optional(), lines: z.array(diffLineSchema) }),
  z.object({
    type: z.literal('permission_request'),
    requestId: z.string(),
    tool: z.string(),
    description: z.string(),
    command: z.string().optional(), // Bash
    filePath: z.string().optional(), // Edit/Write/Read
    plan: z.string().optional(), // ExitPlanMode plan markdown
    detail: z.string().optional(), // extra preview (non-edit tools)
    diff: z.array(diffLineSchema).optional(), // Edit/Write/MultiEdit change
  }),
  z.object({
    type: z.literal('status'),
    state: agentStateSchema,
    mode: sessionModeSchema.optional(),
    model: z.string().optional(),
    effort: effortLevelSchema.optional(),
    label: z.string().optional(), // session label (worktree/branch or project dir) for the app
  }),
  z.object({
    type: z.literal('cost'),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    totalUSD: z.number(),
    cacheRead: z.number().int().optional(),
    cacheCreation: z.number().int().optional(),
  }),
  z.object({ type: z.literal('context_status'), usedPercent: z.number() }),
  // Currently-running Task subagents (a flat list; replaces the prior list).
  z.object({
    type: z.literal('agents'),
    running: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional() })),
  }),
  z.object({ type: z.literal('rewind_options'), points: z.array(rewindPointSchema) }),
  // Put text into the app's composer (e.g. the rewound message, to edit/resend).
  z.object({ type: z.literal('input_prefill'), text: z.string() }),
  z.object({ type: z.literal('terminal_list'), terminals: z.array(hostedTerminalSchema) }),
  z.object({
    type: z.literal('terminal_output'),
    terminalId: z.string(),
    data: z.string(),
    ansi: z.boolean(),
    seq: z.number().int().nonnegative().optional(), // Sequence number for ordering
  }),
  // Picker payloads: the app opens a chooser; its selection comes back as a
  // slash object form ({name:'resume'|'model', id}).
  z.object({
    type: z.literal('session_list'),
    sessions: z.array(z.object({ id: z.string(), mtimeMs: z.number(), preview: z.string() })),
  }),
  z.object({
    type: z.literal('model_list'),
    models: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        detail: z.string().optional(), // capabilities/version, shown under the label
        current: z.boolean().optional(),
      }),
    ),
  }),
  // Out-of-band notices. session_reset tells the app to clear its transcript and
  // show a banner; info/unsupported render as a system line; 'dialog' opens a
  // closable dialog (with an optional title) — used by /help, /status, /context.
  z.object({
    type: z.literal('notice'),
    kind: z.enum(['session_reset', 'info', 'unsupported', 'dialog']),
    text: z.string(),
    title: z.string().optional(),
    sessionId: z.string().optional(),
  }),
]);
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;

export const parseTerminalInput = (u: unknown): TerminalInput => terminalInputSchema.parse(u);
export const parseTerminalOutput = (u: unknown): TerminalOutput => terminalOutputSchema.parse(u);
