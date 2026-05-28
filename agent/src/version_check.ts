// Startup compatibility check between bedcoder, the @anthropic-ai/claude-agent-sdk
// it bundles, and the user's installed `claude` CLI. We hit a silent-hang failure
// when SDK 0.1.x couldn't talk to CLI 2.1.x; this check surfaces that drift early.
//
// Single source of truth for "what CLI does this SDK expect?" is the SDK's own
// package.json — it declares `"claudeCodeVersion": "X.Y.Z"`. We compare that to
// the CLI installed on PATH and to the npm registry's latest bedcoder, and ask
// the user before continuing on a mismatch.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { log } from './log';

const SDK_PKG_NAME = '@anthropic-ai/claude-agent-sdk';
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/bedcoder/latest';
const FETCH_TIMEOUT_MS = 2000;
const CLI_SPAWN_TIMEOUT_MS = 5000;

// =============================================================================
// Pure helpers (tested)
// =============================================================================

// Compare two `X.Y.Z` version strings. Non-numeric / malformed inputs sort
// as `0.0.0` (i.e. treated as "ancient" so anything else looks newer).
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parts = (s: string): [number, number, number] => {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1]!, 10), parseInt(m[2]!, 10), parseInt(m[3]!, 10)];
  };
  const [aMaj, aMin, aPat] = parts(a);
  const [bMaj, bMin, bPat] = parts(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

// Parse `claude --version` output. Format we expect: "2.1.150 (Claude Code)\n".
// Anything else → undefined (treated by classifyDrift as "CLI missing", since
// from the user's POV both cases need the same fix: check your install).
export function parseCliVersion(stdout: string): string | undefined {
  const m = stdout.match(/^(\d+\.\d+\.\d+)/);
  return m?.[1];
}

export interface VersionInfo {
  cliVersion?: string; // user's installed CLI; undefined = not found / unparseable
  sdkCliVersion: string; // CLI version the SDK was built/tested against
  bedcoderVersion: string; // bedcoder we're running now
  latestBedcoder?: string; // npm registry's latest; undefined = fetch failed
}

export type Drift =
  | { kind: 'ok' }
  | { kind: 'cli_missing' }
  | { kind: 'cli_old'; cli: string; sdkExpects: string }
  | { kind: 'cli_new_bedcoder_old'; cli: string; sdkExpects: string; have: string; latest: string }
  | { kind: 'cli_new_bedcoder_latest'; cli: string; sdkExpects: string };

// Decide what mismatch (if any) we're in. The four CLI-newer-than-SDK cases
// fork on whether bedcoder itself can be upgraded — if it can, we push the
// user to upgrade us first (which will bring a newer SDK); if we're already
// latest, there's nothing more to recommend, just keep going.
export function classifyDrift(info: VersionInfo): Drift {
  if (!info.cliVersion) return { kind: 'cli_missing' };
  const cmp = compareSemver(info.cliVersion, info.sdkCliVersion);
  if (cmp === 0) return { kind: 'ok' };
  if (cmp < 0) return { kind: 'cli_old', cli: info.cliVersion, sdkExpects: info.sdkCliVersion };
  // cli > sdkExpects
  if (info.latestBedcoder && compareSemver(info.bedcoderVersion, info.latestBedcoder) < 0) {
    return {
      kind: 'cli_new_bedcoder_old',
      cli: info.cliVersion,
      sdkExpects: info.sdkCliVersion,
      have: info.bedcoderVersion,
      latest: info.latestBedcoder,
    };
  }
  return { kind: 'cli_new_bedcoder_latest', cli: info.cliVersion, sdkExpects: info.sdkCliVersion };
}

// Official install commands per platform (https://claude.ai/install.*).
// Anthropic ships `claude` as a standalone binary; the installer drops it into
// `~/.local/bin` (Unix) or `%USERPROFILE%\.local\bin` (Windows) and arranges PATH.
// We deliberately don't suggest the third-party package-manager route — it
// creates a parallel shim alongside the standalone binary, and `claude upgrade`
// only updates whichever one is on PATH, leading to silent version drift.
function installCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return [
      '  PowerShell:  irm https://claude.ai/install.ps1 | iex',
      '  cmd.exe:     curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
    ].join('\n');
  }
  // darwin, linux, and anything else POSIX-ish
  return '  curl -fsSL https://claude.ai/install.sh | bash';
}

// Build the human-readable warning shown before the y/N prompt. Multi-line.
// `platform` is overridable so tests stay deterministic; production defaults to
// process.platform so the message matches the OS we're actually running on.
export function driftMessage(d: Drift, platform: NodeJS.Platform = process.platform): string {
  switch (d.kind) {
    case 'ok':
      return '';
    case 'cli_missing':
      return [
        '⚠️  Claude CLI not found on PATH (or returned an unparseable --version).',
        '',
        'Install the official `claude` CLI:',
        installCommand(platform),
        '',
        'If it is installed, check that it is on PATH and that `claude --version`',
        'prints `X.Y.Z (Claude Code)`.',
      ].join('\n');
    case 'cli_old':
      return [
        `⚠️  Your installed Claude CLI (${d.cli}) is older than the one this`,
        `   bedcoder's SDK was built against (${d.sdkExpects}).`,
        '',
        'Mismatched protocol versions can cause Chat to hang silently with no',
        'visible error. Upgrade the CLI:',
        '  claude upgrade',
        '',
        'Note: `claude upgrade` updates whichever binary is currently on PATH',
        '(standalone installer or npm-managed). If you have multiple installs',
        '(e.g. an old `~/.local/bin/claude.exe` plus an npm-installed one), only',
        'the one that runs gets updated — `where claude` lists them all.',
      ].join('\n');
    case 'cli_new_bedcoder_old':
      return [
        `⚠️  Your Claude CLI (${d.cli}) is newer than what this bedcoder's SDK was`,
        `   built against (${d.sdkExpects}). A newer bedcoder is also available`,
        `   on npm (${d.have} → ${d.latest}) and likely ships an SDK that supports`,
        '   your CLI version.',
        '',
        'Upgrade bedcoder first:',
        '  npm install -g bedcoder@latest',
      ].join('\n');
    case 'cli_new_bedcoder_latest':
      return [
        `ℹ️  Your Claude CLI (${d.cli}) is newer than what this bedcoder's SDK was`,
        `   built against (${d.sdkExpects}). bedcoder is already up to date, so`,
        '   there is nothing to upgrade — proceeding. If Chat fails, downgrade the',
        `   CLI to ${d.sdkExpects} or wait for a new bedcoder release.`,
      ].join('\n');
  }
}

// =============================================================================
// I/O (collected here so the pure logic above stays mockable)
// =============================================================================

// Read the SDK's own package.json to discover which CLI version it was tested
// against. The SDK's `exports` map doesn't expose `./package.json`, so we can't
// require it directly — instead we resolve the main entry, then read the
// sibling package.json. Works under pnpm's deep node_modules layout too.
export function readSdkCliVersion(): string {
  const req = createRequire(import.meta.url);
  try {
    const mainPath = req.resolve(SDK_PKG_NAME);
    const pkgPath = join(dirname(mainPath), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      claudeCodeVersion?: unknown;
      version?: unknown;
    };
    if (typeof pkg.claudeCodeVersion === 'string') return pkg.claudeCodeVersion;
    log('version.check.no_sdk_field', { sdkVersion: String(pkg.version) });
  } catch (err) {
    log('version.check.sdk_pkg_read_failed', { err: String(err) });
  }
  // Either the SDK doesn't declare the field, or we couldn't read its
  // package.json — fall back to "0.0.0" so the user's CLI always sorts as
  // "newer" (soft-warn path), never the harder "you must upgrade" path.
  return '0.0.0';
}

// Read our own package.json. Same trick — works in both dev and bundled forms,
// because `../package.json` resolves to `agent/package.json` from either
// `agent/src/version_check.ts` or `agent/dist/index.js`.
export function readBedcoderVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Probe the user's installed CLI. We use spawnSync with a short timeout so a
// hung `claude` (rare but possible) doesn't deadlock startup.
//
// On Windows, Node's default spawn only matches `.exe`/`.com` from PATH — not
// `.cmd` shims (which is what `claude` looks like when installed via the
// official installer or npm). Setting `shell: true` makes cmd.exe do the
// PATHEXT resolution for us. The args contain no user input, so command
// injection isn't a concern.
export function probeCliVersion(timeoutMs: number = CLI_SPAWN_TIMEOUT_MS): string | undefined {
  const r = spawnSync('claude', ['--version'], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    shell: process.platform === 'win32',
  });
  if (r.status !== 0 || !r.stdout) return undefined;
  return parseCliVersion(r.stdout);
}

// Fetch npm's latest bedcoder version. Mirrors fetchModelCatalog's pattern: any
// failure → undefined (never throws). We don't want a slow/down npm registry to
// block startup.
export async function fetchLatestBedcoder(
  url: string = NPM_REGISTRY_URL,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function gatherVersionInfo(): Promise<VersionInfo> {
  // Local reads are sync; only the npm fetch needs awaiting.
  const sdkCliVersion = readSdkCliVersion();
  const bedcoderVersion = readBedcoderVersion();
  const cliVersion = probeCliVersion();
  const latestBedcoder = await fetchLatestBedcoder();
  return { cliVersion, sdkCliVersion, bedcoderVersion, latestBedcoder };
}

// =============================================================================
// Orchestrator
// =============================================================================

export interface RunVersionCheckIO {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  // Hook for tests so we don't have to spawn / fetch the real world.
  gather?: () => Promise<VersionInfo>;
}

// Returns true if startup may proceed, false if the user declined or we cannot
// continue (e.g. CLI missing in a TTY where the user said no). The caller is
// expected to process.exit on false.
export async function runVersionCheck(io: RunVersionCheckIO = {}): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const gather = io.gather ?? gatherVersionInfo;

  const info = await gather();
  const drift = classifyDrift(info);
  log('version.check', { drift: drift.kind, ...info });

  if (drift.kind === 'ok' || drift.kind === 'cli_new_bedcoder_latest') {
    // No prompt; the "newer than tested" case is informational only. Still
    // print the soft note so the user knows about it.
    if (drift.kind === 'cli_new_bedcoder_latest') {
      stdout.write(driftMessage(drift) + '\n\n');
    }
    return true;
  }

  // Drift cases below need user attention. Show the message, then prompt.
  stdout.write(driftMessage(drift) + '\n\n');

  // Non-TTY (CI, nohup, piped stdin): no one to answer the prompt. cli_missing
  // is still fatal (we can't run without a CLI), but the other cases just warn
  // and proceed so headless setups keep working.
  if (!stdin.isTTY) {
    if (drift.kind === 'cli_missing') {
      stdout.write('No TTY for confirmation; cannot proceed without `claude`.\n');
      return false;
    }
    stdout.write('No TTY for confirmation; continuing anyway (--skip-version-check to silence).\n\n');
    return true;
  }

  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question('Continue anyway? [y/N] ', (a) => {
      rl.close();
      resolve(a);
    });
  });
  const yes = ['y', 'yes'].includes(answer.trim().toLowerCase());
  if (!yes) stdout.write('Aborted.\n');
  return yes;
}
