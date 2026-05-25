import { execFileSync } from 'node:child_process';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A git worktree bedcoder runs inside, so different conversations work on the
// same repo in parallel without stepping on each other's files (DESIGN §3.7).
export interface Worktree {
  path: string; // absolute checkout dir
  branch: string; // the branch checked out there
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Ensure a `.worktrees/<name>` checkout on branch <name> exists, creating the
// branch (from current HEAD) and the worktree if needed; reused if present.
// Throws a friendly error when not in a git repo.
export function ensureWorktree(name: string): Worktree {
  let root: string;
  try {
    root = git(['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('--worktree requires a git repository (run `git init` or cd into one).');
  }

  const path = join(root, '.worktrees', name);
  excludeWorktreesDir(root);

  // Already a checkout there → reuse it (reconnect).
  if (existsSync(path)) return { path, branch: name };

  // Create the worktree: reuse the branch if it exists, else branch from HEAD.
  const branchExists = (() => {
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return true;
    } catch {
      return false;
    }
  })();
  git(branchExists ? ['worktree', 'add', path, name] : ['worktree', 'add', '-b', name, path], root);
  return { path, branch: name };
}

// Keep `.worktrees/` out of git via .git/info/exclude (doesn't touch the user's
// tracked .gitignore). Best-effort.
function excludeWorktreesDir(root: string): void {
  try {
    const file = join(root, '.git', 'info', 'exclude');
    if (!existsSync(file)) return; // .git is a file (nested worktree) — skip
    const line = '.worktrees/';
    if (!readFileSync(file, 'utf8').split('\n').includes(line)) appendFileSync(file, `\n${line}\n`);
  } catch {
    // non-fatal
  }
}
