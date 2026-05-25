import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Lightweight append-only diagnostics log. Off by default — turn it on with
// `bedcoder --log [path]` (which calls enableLog). The desktop console is the
// pairing TUI (index.ts uses console.clear()), so diagnostics go to a file.
//
// One JSON line per event: {ts, tag, ...fields}. We deliberately log only shapes
// and lengths (never message text or keys), consistent with the zero-knowledge
// posture (DESIGN §6.1).
//
// Env overrides (handy for tests / ad-hoc runs): BEDCODER_LOG=<path> logs there;
// BEDCODER_LOG=off hard-disables it and wins over --log.

const MAX_FIELD_LEN = 200;
const DEFAULT_PATH = join(homedir(), '.bedcoder', 'agent.log');

let enabled = false;
let filePath = DEFAULT_PATH;
let stream: WriteStream | undefined;

const env = process.env.BEDCODER_LOG;
if (env && env !== 'off') {
  enabled = true;
  filePath = env;
}

// Turn logging on (from `bedcoder --log [path]`). BEDCODER_LOG=off still wins so a
// test or CI run can keep the daemon silent.
export function enableLog(path?: string): void {
  if (process.env.BEDCODER_LOG === 'off') return;
  enabled = true;
  if (path) filePath = path;
}

export function isLogging(): boolean {
  return enabled;
}

export function logFilePath(): string {
  return filePath;
}

function sink(): WriteStream | undefined {
  if (!enabled) return undefined;
  if (!stream) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      stream = createWriteStream(filePath, { flags: 'a' });
    } catch {
      return undefined; // never let logging break the daemon
    }
  }
  return stream;
}

// Truncate string values so a stray large field can't bloat the log; objects are
// left to JSON.stringify (callers pass small, shape-only fields).
function clip(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === 'string' && v.length > MAX_FIELD_LEN ? `${v.slice(0, MAX_FIELD_LEN)}…` : v;
  }
  return out;
}

export function log(tag: string, fields?: Record<string, unknown>): void {
  const s = sink();
  if (!s) return;
  try {
    s.write(`${JSON.stringify({ ts: new Date().toISOString(), tag, ...clip(fields) })}\n`);
  } catch {
    // ignore — diagnostics must never throw into the hot path
  }
}
