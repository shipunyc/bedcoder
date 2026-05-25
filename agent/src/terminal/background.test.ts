import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bgPaths,
  shellQuote,
  rewriteBackgroundCommand,
  isAlive,
  processTree,
  killProcessTree,
  snapshotChildren,
  descendantPids,
  killDescendants,
  killTargetPid,
  BackgroundShellManager,
} from './background';
import { TerminalManager } from './manager';

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('pure helpers', () => {
  it('shellQuote escapes single quotes', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('bgPaths builds log + pid paths under the runs dir', () => {
    const p = bgPaths('/runs', 'term-1');
    expect(p.logPath).toBe('/runs/term-1.log');
    expect(p.pidPath).toBe('/runs/term-1.pid');
  });

  it('rewriteBackgroundCommand records the pid, execs, and tees to the log', () => {
    const cmd = rewriteBackgroundCommand('npm run dev', { logPath: '/r/x.log', pidPath: '/r/x.pid' });
    expect(cmd).toContain('echo $$ > ');
    expect(cmd).toContain("'/r/x.pid'");
    expect(cmd).toContain('exec bash -c');
    expect(cmd).toContain("'npm run dev'");
    expect(cmd).toContain("tee '/r/x.log'");
    expect(cmd).toContain('2>&1');
  });
});

describe('process tree', () => {
  const kids: Record<number, number[]> = { 1: [2, 3], 2: [4], 3: [], 4: [] };
  const children = (p: number): number[] => kids[p] ?? [];

  it('collects a pid and all descendants', () => {
    expect(new Set(processTree(1, children))).toEqual(new Set([1, 2, 3, 4]));
  });

  it('handles leaves', () => {
    expect(processTree(4, children)).toEqual([4]);
  });

  it('killProcessTree signals children before the root', () => {
    const signalled: number[] = [];
    const tree = killProcessTree(1, 'SIGTERM', { children, signal: (p) => signalled.push(p) });
    expect(new Set(tree)).toEqual(new Set([1, 2, 3, 4]));
    expect(signalled.at(-1)).toBe(1); // the root is signalled last
    expect(new Set(signalled)).toEqual(new Set([1, 2, 3, 4]));
  });
});

describe('descendant pids (process subtree)', () => {
  const procs: ChildProcess[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) {
      if (p.pid) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('snapshotChildren parses ps output into ppid -> children', () => {
    const map = snapshotChildren(() => '  2     1\n  3     1\n  4     2\n 10   999\n');
    expect(map.get(1)).toEqual([2, 3]);
    expect(map.get(2)).toEqual([4]);
    expect(map.get(999)).toEqual([10]);
  });

  it('descendantPids walks the tree and excludes the root', () => {
    const children = new Map<number, number[]>([[1, [2, 3]], [2, [4]], [3, []]]);
    expect(descendantPids(1, children)).toEqual(new Set([2, 3, 4]));
    expect(descendantPids(4, children)).toEqual(new Set());
  });

  it('killDescendants signals every descendant but not the root', () => {
    const children = new Map<number, number[]>([[1, [2, 3]], [2, [4]]]);
    const signalled: number[] = [];
    const n = killDescendants(1, 'SIGTERM', { children, signal: (p) => signalled.push(p) });
    expect(n).toBe(3);
    expect(new Set(signalled)).toEqual(new Set([2, 3, 4]));
    expect(signalled).not.toContain(1);
  });

  it('killTargetPid picks the matching port, else the sole hosted port', () => {
    const hosted = [{ port: 5173, pid: 100 }, { port: 5174, pid: 200 }];
    // Known port -> its pid
    expect(killTargetPid(5174, hosted)).toBe(200);
    expect(killTargetPid(9999, hosted)).toBeUndefined(); // known but not hosted
    // Unknown port, multiple hosted -> ambiguous -> undefined
    expect(killTargetPid(undefined, hosted)).toBeUndefined();
    // Unknown port, exactly one hosted -> that one
    expect(killTargetPid(undefined, [{ port: 3000, pid: 42 }])).toBe(42);
    expect(killTargetPid(undefined, [])).toBeUndefined();
  });

  it('finds a real spawned child via a live ps snapshot', async () => {
    const child = spawn('bash', ['-c', 'sleep 30']);
    procs.push(child);
    await waitUntil(() => child.pid !== undefined && descendantPids(process.pid).has(child.pid));
    expect(descendantPids(process.pid).has(child.pid!)).toBe(true);
  }, 10000);
});

describe('isAlive', () => {
  it('is true for the current process and false for a bogus pid', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2_000_000_000)).toBe(false);
  });
});

// These run a real bash to validate the rewrite wrapper end-to-end (the only
// unverified part is whether the SDK passes our command to bash unchanged).
describe('rewrite wrapper (real bash)', () => {
  let dir: string;
  const procs: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bedcoder-bg-'));
  });
  afterEach(() => {
    for (const p of procs.splice(0)) {
      if (p.pid) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes output to the log and records a live pid', async () => {
    const paths = bgPaths(dir, 'term-1');
    const rewritten = rewriteBackgroundCommand('echo hello-bg; sleep 0.5', paths);
    procs.push(spawn('bash', ['-c', rewritten]));

    await waitUntil(() => existsSync(paths.logPath) && readFileSync(paths.logPath, 'utf-8').includes('hello-bg'));
    await waitUntil(() => existsSync(paths.pidPath) && readFileSync(paths.pidPath, 'utf-8').trim().length > 0);

    const pid = parseInt(readFileSync(paths.pidPath, 'utf-8').trim(), 10);
    expect(isAlive(pid)).toBe(true); // still sleeping
  }, 10000);

  it('killProcessTree stops a long-running command', async () => {
    const paths = bgPaths(dir, 'term-2');
    const rewritten = rewriteBackgroundCommand('sleep 30', paths);
    procs.push(spawn('bash', ['-c', rewritten]));

    await waitUntil(() => existsSync(paths.pidPath) && readFileSync(paths.pidPath, 'utf-8').trim().length > 0);
    const pid = parseInt(readFileSync(paths.pidPath, 'utf-8').trim(), 10);
    expect(isAlive(pid)).toBe(true);

    killProcessTree(pid, 'SIGKILL');
    await waitUntil(() => !isAlive(pid));
    expect(isAlive(pid)).toBe(false);
  }, 10000);
});

describe('BackgroundShellManager (real bash)', () => {
  let dir: string;
  let terminals: TerminalManager;
  let mgr: BackgroundShellManager;
  const procs: ChildProcess[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bedcoder-bgm-'));
    terminals = new TerminalManager();
    mgr = new BackgroundShellManager(terminals, dir);
  });
  afterEach(() => {
    for (const p of procs.splice(0)) {
      if (p.pid) try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    mgr.dispose();
    terminals.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers, tails output, and detects exit', async () => {
    const { id, rewrittenCommand } = mgr.register('echo streamed-line; sleep 0.3');
    expect(terminals.getTerminalList().some((t) => t.id === id && t.state === 'running')).toBe(true);

    procs.push(spawn('bash', ['-c', rewrittenCommand]));

    await waitUntil(() => terminals.getOutput(id).includes('streamed-line'));
    await waitUntil(() => terminals.getTerminal(id)?.state === 'exited');
    expect(terminals.getTerminal(id)?.state).toBe('exited');
  }, 10000);

  it('kill() terminates the process and marks the terminal exited', async () => {
    const { id, rewrittenCommand } = mgr.register('sleep 30');
    procs.push(spawn('bash', ['-c', rewrittenCommand]));

    const paths = bgPaths(dir, id);
    await waitUntil(() => existsSync(paths.pidPath) && readFileSync(paths.pidPath, 'utf-8').trim().length > 0);
    const pid = parseInt(readFileSync(paths.pidPath, 'utf-8').trim(), 10);

    expect(mgr.kill(id)).toBe(true);
    await waitUntil(() => !isAlive(pid));
    expect(terminals.getTerminal(id)?.state).toBe('exited');
  }, 10000);

  it('ownedPids() reports the live pids of registered tasks', async () => {
    const { id, rewrittenCommand } = mgr.register('sleep 30');
    procs.push(spawn('bash', ['-c', rewrittenCommand]));

    const paths = bgPaths(dir, id);
    await waitUntil(() => existsSync(paths.pidPath) && readFileSync(paths.pidPath, 'utf-8').trim().length > 0);
    const pid = parseInt(readFileSync(paths.pidPath, 'utf-8').trim(), 10);

    await waitUntil(() => mgr.ownedPids().has(pid));
    expect(mgr.ownedPids().has(pid)).toBe(true);
  }, 10000);

  it('ownedPids() is empty when nothing is registered', () => {
    expect(mgr.ownedPids().size).toBe(0);
  });

  it('killAll() terminates every tracked task (shutdown cleanup)', async () => {
    const a = mgr.register('sleep 30');
    const b = mgr.register('sleep 30');
    procs.push(spawn('bash', ['-c', a.rewrittenCommand]), spawn('bash', ['-c', b.rewrittenCommand]));

    const pidFileA = bgPaths(dir, a.id).pidPath;
    const pidFileB = bgPaths(dir, b.id).pidPath;
    const hasPid = (f: string): boolean => existsSync(f) && readFileSync(f, 'utf-8').trim().length > 0;
    await waitUntil(() => hasPid(pidFileA) && hasPid(pidFileB));
    const pa = parseInt(readFileSync(pidFileA, 'utf-8').trim(), 10);
    const pb = parseInt(readFileSync(pidFileB, 'utf-8').trim(), 10);

    expect(mgr.killAll()).toBe(2);
    await waitUntil(() => !isAlive(pa) && !isAlive(pb));
    expect(isAlive(pa)).toBe(false);
    expect(isAlive(pb)).toBe(false);
  }, 10000);
});
