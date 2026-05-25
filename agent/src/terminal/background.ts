// Background shell manager (Phase 2.3 — hosted background tasks).
//
// The Agent SDK does not expose Claude's `run_in_background` shells to the host,
// so we take them over at the command level: a PreToolUse hook rewrites a
// background Bash command to record its PID and tee its combined output to a log
// file we own. This module owns the OS-level side — building the rewrite,
// tailing the log, detecting exit, and killing the process tree — and feeds a
// TerminalManager so the existing terminal channel surfaces it to the phone.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readSync, openSync, closeSync, fstatSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TerminalManager } from './manager';

const POLL_MS = 300; // log tail + exit-check cadence

export interface BgPaths {
  logPath: string;
  pidPath: string;
}

// The runs directory where per-task logs and pidfiles live.
export function defaultRunsDir(): string {
  return join(homedir(), '.bedcoder', 'runs');
}

export function bgPaths(runsDir: string, id: string): BgPaths {
  return { logPath: join(runsDir, `${id}.log`), pidPath: join(runsDir, `${id}.pid`) };
}

// Single-quote a string for safe inclusion in a bash command.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rewrite a background command so the host can observe and control it:
 * - `echo $$ > pidfile` records the shell PID, then `exec` replaces that shell
 *   with the user's command, so the recorded PID *is* the command's PID (and the
 *   root of its process tree, for killing).
 * - `> >(tee logfile) 2>&1` mirrors combined output to a log we tail, while still
 *   streaming it to Claude's background shell.
 *
 * Requires bash (process substitution); Claude Code runs Bash via bash.
 */
export function rewriteBackgroundCommand(original: string, paths: BgPaths): string {
  return (
    `echo $$ > ${shellQuote(paths.pidPath)}; ` +
    `exec bash -c ${shellQuote(original)} > >(tee ${shellQuote(paths.logPath)}) 2>&1`
  );
}

// True if a PID is still alive (signal 0 probes without killing).
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

// Direct children of a PID (via pgrep -P; empty if pgrep is unavailable).
export function listChildren(pid: number): number[] {
  const res = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf-8' });
  if (res.status !== 0 || !res.stdout) return [];
  return res.stdout
    .split('\n')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// Collect a PID and all its descendants (depth-first), so we kill the whole tree
// (e.g. `npm run dev` → node). Bounded against pathological depth.
export function processTree(pid: number, children: (p: number) => number[] = listChildren): number[] {
  const out: number[] = [];
  const stack = [pid];
  const seen = new Set<number>();
  while (stack.length && out.length < 1000) {
    const p = stack.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    stack.push(...children(p));
  }
  return out;
}

// One `ps` snapshot mapping ppid -> child pids. Cheaper than many `pgrep -P`
// calls when walking the agent's whole tree. Empty if ps is unavailable.
export function snapshotChildren(
  run: () => string = () => {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' });
    return r.status === 0 && r.stdout ? r.stdout : '';
  },
): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const line of run().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const ppid = parseInt(m[2]!, 10);
    const arr = map.get(ppid);
    if (arr) arr.push(pid);
    else map.set(ppid, [pid]);
  }
  return map;
}

// All live descendant PIDs of rootPid (excluding itself), from one ps snapshot.
// This is how we find what *this agent* — and Claude under it — actually spawned
// (agent → SDK → bash → npm → vite), without depending on our command rewrite:
// the SDK runs run_in_background Bash itself and ignores updatedInput.command, so
// the rewrite (echo $$ / tee) never executes and pidfiles are never written.
export function descendantPids(
  rootPid: number,
  children: Map<number, number[]> = snapshotChildren(),
): Set<number> {
  const out = new Set<number>();
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length && out.size < 5000) {
    const p = stack.pop()!;
    if (out.has(p)) continue;
    out.add(p);
    stack.push(...(children.get(p) ?? []));
  }
  return out;
}

// Kill every descendant of rootPid (leaving rootPid alive). Called on shutdown so
// dev servers Claude started under us don't orphan. Returns how many it signalled.
export function killDescendants(
  rootPid: number,
  sig: NodeJS.Signals = 'SIGTERM',
  deps: { children?: Map<number, number[]>; signal?: (pid: number, s: NodeJS.Signals) => void } = {},
): number {
  const set = descendantPids(rootPid, deps.children ?? snapshotChildren());
  const signal =
    deps.signal ??
    ((p: number, s: NodeJS.Signals) => {
      try {
        process.kill(p, s);
      } catch {
        // already gone / not ours
      }
    });
  let n = 0;
  for (const p of set) {
    signal(p, sig);
    n++;
  }
  return n;
}

// Pick which hosted port's process to kill when the phone's Stop button fires.
// Prefer the port we learned from the task's output; otherwise, if the agent
// hosts exactly one port, it's unambiguously the one (so kill works even when the
// server never printed a parseable URL). Returns undefined when it can't tell.
export function killTargetPid(
  knownPort: number | undefined,
  hosted: ReadonlyArray<{ port: number; pid?: number }>,
): number | undefined {
  if (knownPort !== undefined) return hosted.find((p) => p.port === knownPort)?.pid;
  if (hosted.length === 1) return hosted[0]!.pid;
  return undefined;
}

export interface KillDeps {
  children?: (p: number) => number[];
  signal?: (pid: number, sig: NodeJS.Signals) => void;
}

// Kill a process and its descendants: SIGTERM the leaves-first order. Returns the
// PIDs it signalled.
export function killProcessTree(pid: number, sig: NodeJS.Signals = 'SIGTERM', deps: KillDeps = {}): number[] {
  const children = deps.children ?? listChildren;
  const signal =
    deps.signal ??
    ((p: number, s: NodeJS.Signals) => {
      try {
        process.kill(p, s);
      } catch {
        // already gone / not ours
      }
    });
  const tree = processTree(pid, children);
  // Children before parents so a parent can't re-fork after we signal it.
  for (const p of tree.slice().reverse()) signal(p, sig);
  return tree;
}

export interface BackgroundTask {
  id: string;
  command: string; // the original command (for display)
  logPath: string;
  pidPath: string;
}

/**
 * Owns the lifecycle of hosted background shells: registers them in a
 * TerminalManager, tails their logs, detects exit, and kills on request.
 */
export class BackgroundShellManager {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly offsets = new Map<string, number>(); // bytes already tailed
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly manager: TerminalManager,
    private readonly runsDir: string = defaultRunsDir(),
  ) {}

  /**
   * Register a background command. Returns the terminal id and the rewritten
   * command the hook should hand back to the SDK. Begins tailing once output
   * starts appearing.
   */
  register(command: string): { id: string; rewrittenCommand: string } {
    mkdirSync(this.runsDir, { recursive: true });
    const id = this.manager.register(command);
    const paths = bgPaths(this.runsDir, id);
    this.tasks.set(id, { id, command, logPath: paths.logPath, pidPath: paths.pidPath });
    this.offsets.set(id, 0);
    this.ensurePolling();
    return { id, rewrittenCommand: rewriteBackgroundCommand(command, paths) };
  }

  /**
   * The PIDs of every process owned by our background tasks (each task's full
   * process tree). Used to show only *bedcoder-hosted* ports in the Preview tab.
   */
  ownedPids(): Set<number> {
    const pids = new Set<number>();
    for (const task of this.tasks.values()) {
      const pid = this.readPid(task);
      if (pid === undefined) continue;
      for (const p of processTree(pid)) pids.add(p);
    }
    return pids;
  }

  /** Kill a background task's process tree and mark it exited. */
  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    const pid = this.readPid(task);
    if (pid !== undefined) killProcessTree(pid);
    this.drainLog(id, task); // capture any final bytes
    this.manager.setExited(id, -1);
    this.forget(id);
    return true;
  }

  /**
   * Kill every tracked background process tree — call on daemon shutdown so the
   * shells bedcoder spawned (e.g. `npm run dev`) don't orphan and hold ports.
   * Synchronous (killProcessTree uses spawnSync) so it completes in a signal
   * handler before exit. Returns how many tasks it killed.
   */
  killAll(): number {
    let killed = 0;
    for (const task of this.tasks.values()) {
      const pid = this.readPid(task);
      if (pid !== undefined) {
        killProcessTree(pid, 'SIGTERM');
        killed++;
      }
    }
    this.dispose();
    return killed;
  }

  /** Stop all polling (call on shutdown). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tasks.clear();
    this.offsets.clear();
  }

  // --- internals ---

  private ensurePolling(): void {
    this.timer ??= setInterval(() => this.poll(), POLL_MS);
  }

  private poll(): void {
    for (const [id, task] of this.tasks) {
      this.drainLog(id, task);
      const pid = this.readPid(task);
      if (pid !== undefined && !isAlive(pid)) {
        this.drainLog(id, task); // final flush
        this.manager.setExited(id, 0);
        this.forget(id);
      }
    }
    if (this.tasks.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private readPid(task: BackgroundTask): number | undefined {
    if (!existsSync(task.pidPath)) return undefined;
    const pid = parseInt(readFileSync(task.pidPath, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  }

  // Read any bytes appended to the log since last time and forward to the manager.
  private drainLog(id: string, task: BackgroundTask): void {
    if (!existsSync(task.logPath)) return;
    const fd = openSync(task.logPath, 'r');
    try {
      const size = fstatSync(fd).size;
      let offset = this.offsets.get(id) ?? 0;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      this.offsets.set(id, offset);
      this.manager.appendOutput(id, buf.toString('utf-8'));
    } finally {
      closeSync(fd);
    }
  }

  private forget(id: string): void {
    this.tasks.delete(id);
    this.offsets.delete(id);
  }
}
