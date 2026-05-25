import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorktree } from './worktree';

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bedcoder-wt-')));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 'T']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

describe('ensureWorktree', () => {
  let repo: string;
  let cwd: string;

  beforeEach(() => {
    repo = initRepo();
    cwd = process.cwd();
    process.chdir(repo);
  });

  // restore cwd after each (ensureWorktree relies on the process cwd)
  afterEach(() => process.chdir(cwd));

  it('creates .worktrees/<name> on a new branch from HEAD', () => {
    const wt = ensureWorktree('feat-x');
    expect(wt.branch).toBe('feat-x');
    expect(wt.path).toBe(join(repo, '.worktrees', 'feat-x'));
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    const branches = execFileSync('git', ['branch', '--list', 'feat-x'], { cwd: repo, encoding: 'utf8' });
    expect(branches).toContain('feat-x');
  });

  it('reuses an existing worktree (idempotent)', () => {
    const a = ensureWorktree('feat-x');
    const b = ensureWorktree('feat-x');
    expect(b.path).toBe(a.path);
  });

  it('checks out an existing branch', () => {
    execFileSync('git', ['branch', 'existing'], { cwd: repo });
    const wt = ensureWorktree('existing');
    expect(wt.branch).toBe('existing');
    expect(existsSync(wt.path)).toBe(true);
  });

  it('throws outside a git repo', () => {
    const notRepo = realpathSync(mkdtempSync(join(tmpdir(), 'bedcoder-norepo-')));
    process.chdir(notRepo);
    expect(() => ensureWorktree('x')).toThrow(/git repository/);
  });
});
