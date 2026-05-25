import { readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '@bedcoder/protocol';
import { parseTodos, summarizeTool } from './events';

// Resolve Claude Code sessions for the current project. Claude Code stores
// sessions as ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl, where the
// cwd is encoded by replacing path punctuation with '-' (e.g. /Users/User/bedcoder
// -> -Users-User-bedcoder). `bedcoder --resume` hands the chosen id to the SDK's
// resume option so the conversation continues from ~/.claude (DESIGN §3.3).
//
// The relay sid and the Claude session id are otherwise independent; on resume
// we deliberately reuse the Claude session id as the relay sid.

// Encode a cwd into Claude Code's project-dir name. We map '/', '.', and the
// Windows separators '\' and drive ':' to '-'. On Unix the latter two never
// occur, so this is byte-identical to the previous behavior (no resume
// regression). NOTE: the SDK's exact Windows encoding for paths containing other
// punctuation (e.g. '_') is unverified — re-check against a real
// %USERPROFILE%\.claude\projects\ name on Windows before relying on --resume.
export function projectDirName(cwd: string): string {
  return cwd.replace(/[/.\\:]/g, '-');
}

function defaultClaudeHome(): string {
  return join(homedir(), '.claude');
}

export interface ClaudeSession {
  id: string;
  mtimeMs: number;
}

// Sessions for the project at `cwd`, newest-first.
export function listSessions(cwd: string, claudeHome: string = defaultClaudeHome()): ClaudeSession[] {
  const dir = join(claudeHome, 'projects', projectDirName(cwd));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no sessions for this project yet
  }
  const sessions: ClaudeSession[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      sessions.push({ id: name.slice(0, -'.jsonl'.length), mtimeMs: statSync(join(dir, name)).mtimeMs });
    } catch {
      // ignore unreadable entries
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

export function latestSessionId(cwd: string, claudeHome: string = defaultClaudeHome()): string | undefined {
  return listSessions(cwd, claudeHome)[0]?.id;
}

export interface ClaudeSessionPreview extends ClaudeSession {
  preview: string; // first user message, for the resume picker
}

// Previews that are pure noise in the resume picker: Claude Code's own warmup
// turns (first user message is literally "Warmup") and sessions with nothing to
// resume. Filtered out so the picker shows only real conversations.
const NOISE_PREVIEWS = new Set(['Warmup', '(no messages)']);

// Like listSessions, but with a human-readable label per session (the first user
// message). Used to render the /resume picker on the phone. Warmup/empty
// sessions are dropped.
export function listSessionsWithPreview(
  cwd: string,
  claudeHome: string = defaultClaudeHome(),
): ClaudeSessionPreview[] {
  const dir = join(claudeHome, 'projects', projectDirName(cwd));
  return listSessions(cwd, claudeHome)
    .map((s) => ({
      ...s,
      preview: firstUserMessage(join(dir, `${s.id}.jsonl`)),
    }))
    .filter((s) => !NOISE_PREVIEWS.has(s.preview));
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : ((asRecord(b)?.text as string | undefined) ?? '')))
      .join(' ');
  }
  return '';
}

function truncate(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 80)}…` : one;
}

// Read the first user message from a session JSONL. Reads only the head of the
// file and tolerates malformed lines so a bad/huge session never throws.
function firstUserMessage(file: string): string {
  const head = readHead(file);
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // partial last line, or non-JSON — skip
    }
    const rec = asRecord(obj);
    const msg = asRecord(rec?.message) ?? rec;
    const isUser = rec?.type === 'user' || msg?.role === 'user';
    if (!isUser) continue;
    const text = truncate(extractText(msg?.content));
    if (text) return text;
  }
  return '(no messages)';
}

function readHead(file: string, max = 65536): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

// One rendered line of a past conversation.
export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string; // whitespace-collapsed, for one-line history rendering
  toolName?: string;
  uuid?: string;
  ts?: number; // epoch ms (from the JSONL `timestamp`), for rewind-point labels
  rawText?: string; // user turns only: original text with newlines, for rewind prefill
}

// Read a session's full conversation from its JSONL and render it the same way
// live output is rendered (user text, assistant text, one line per tool call;
// thinking/tool_result and non-conversation/meta lines are dropped). Returns the
// last `maxLines` entries. Tolerant: a missing/garbled file yields []. Used to
// replay a resumed/rewound session's history to the phone (DESIGN §4.2.2).
export function readTranscript(
  cwd: string,
  id: string,
  claudeHome: string = defaultClaudeHome(),
  opts: { maxLines?: number } = {},
): TranscriptEntry[] {
  const file = join(claudeHome, 'projects', projectDirName(cwd), `${id}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(obj);
    if (!rec) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue; // skip meta/system/snapshot/...
    if (rec.isMeta === true || rec.isSidechain === true) continue;
    const uuid = typeof rec.uuid === 'string' ? rec.uuid : undefined;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || undefined : undefined;
    const content = asRecord(rec.message)?.content;

    if (rec.type === 'user') {
      const raw = extractText(content).trim(); // keep internal newlines for prefill
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text) entries.push({ role: 'user', text, uuid, ts, rawText: raw });
      continue;
    }
    // assistant: an array of blocks (text / tool_use / thinking / tool_result)
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => asRecord(b)?.type === 'text')
      .map((b) => (asRecord(b)?.text as string | undefined) ?? '')
      .join('')
      .trim();
    if (text) entries.push({ role: 'assistant', text, uuid });
    for (const b of content) {
      const block = asRecord(b);
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      if (block.name === 'TodoWrite') continue; // shown as the task list, not a tool line
      entries.push({ role: 'tool', text: summarizeTool(block.name, asRecord(block.input)), toolName: block.name, uuid });
    }
  }
  const max = opts.maxLines ?? 200;
  return entries.length > max ? entries.slice(entries.length - max) : entries;
}

// The most recent TodoWrite task list in a session's JSONL (for restoring the
// task panel on resume). undefined if the session has none. Tolerant of garble.
export function readLatestTasks(
  cwd: string,
  id: string,
  claudeHome: string = defaultClaudeHome(),
): TaskItem[] | undefined {
  const file = join(claudeHome, 'projects', projectDirName(cwd), `${id}.jsonl`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let latest: TaskItem[] | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = asRecord(obj);
    if (rec?.type !== 'assistant') continue;
    const content = asRecord(rec.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = asRecord(b);
      if (block?.type === 'tool_use' && block.name === 'TodoWrite') latest = parseTodos(asRecord(block.input));
    }
  }
  return latest;
}
