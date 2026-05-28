import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  compareSemver,
  parseCliVersion,
  classifyDrift,
  driftMessage,
  fetchLatestBedcoder,
  runVersionCheck,
  type VersionInfo,
} from './version_check';

describe('compareSemver', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.2.0', '1.10.0')).toBe(-1); // numeric, not lexicographic
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats malformed versions as 0.0.0 (anything else looks newer)', () => {
    expect(compareSemver('not.a.version', '0.0.1')).toBe(-1);
    expect(compareSemver('0.0.1', 'garbage')).toBe(1);
    expect(compareSemver('garbage', 'garbage')).toBe(0);
  });

  it('ignores prerelease/build suffix (first version only)', () => {
    expect(compareSemver('2.1.150-beta.1', '2.1.150')).toBe(0);
    expect(compareSemver('2.1.150', '2.1.151-rc1')).toBe(-1);
  });
});

describe('parseCliVersion', () => {
  it('parses the standard `X.Y.Z (Claude Code)` format', () => {
    expect(parseCliVersion('2.1.150 (Claude Code)\n')).toBe('2.1.150');
    expect(parseCliVersion('0.3.1 (Claude Code)')).toBe('0.3.1');
  });

  it('returns undefined for an unparseable line', () => {
    expect(parseCliVersion('')).toBeUndefined();
    expect(parseCliVersion('error: command not found')).toBeUndefined();
    expect(parseCliVersion('claude version v2.1.150')).toBeUndefined(); // no leading numeric
  });
});

describe('classifyDrift', () => {
  const base: VersionInfo = {
    cliVersion: '2.1.150',
    sdkCliVersion: '2.1.150',
    bedcoderVersion: '0.1.5',
    latestBedcoder: '0.1.5',
  };

  it('returns ok when CLI matches SDK', () => {
    expect(classifyDrift(base)).toEqual({ kind: 'ok' });
  });

  it('returns cli_missing when CLI is undefined', () => {
    expect(classifyDrift({ ...base, cliVersion: undefined })).toEqual({ kind: 'cli_missing' });
  });

  it('returns cli_old when CLI < SDK expected', () => {
    expect(classifyDrift({ ...base, cliVersion: '2.1.71' })).toEqual({
      kind: 'cli_old',
      cli: '2.1.71',
      sdkExpects: '2.1.150',
    });
  });

  it('returns cli_new_bedcoder_old when CLI > SDK expected AND bedcoder is upgradable', () => {
    expect(
      classifyDrift({ ...base, cliVersion: '2.2.0', bedcoderVersion: '0.1.5', latestBedcoder: '0.2.0' }),
    ).toEqual({
      kind: 'cli_new_bedcoder_old',
      cli: '2.2.0',
      sdkExpects: '2.1.150',
      have: '0.1.5',
      latest: '0.2.0',
    });
  });

  it('returns cli_new_bedcoder_latest when CLI > SDK expected but bedcoder is already latest', () => {
    expect(classifyDrift({ ...base, cliVersion: '2.2.0' })).toEqual({
      kind: 'cli_new_bedcoder_latest',
      cli: '2.2.0',
      sdkExpects: '2.1.150',
    });
  });

  it('treats unknown latestBedcoder as "already latest" (network failures are non-blocking)', () => {
    expect(classifyDrift({ ...base, cliVersion: '2.2.0', latestBedcoder: undefined })).toEqual({
      kind: 'cli_new_bedcoder_latest',
      cli: '2.2.0',
      sdkExpects: '2.1.150',
    });
  });
});

describe('driftMessage', () => {
  it('returns empty string for ok', () => {
    expect(driftMessage({ kind: 'ok' })).toBe('');
  });

  it('cli_missing message includes the platform-appropriate install command', () => {
    // Pass platform explicitly so the test is deterministic regardless of OS.
    const unix = driftMessage({ kind: 'cli_missing' }, 'linux');
    expect(unix).toContain('curl -fsSL https://claude.ai/install.sh | bash');
    expect(unix).not.toContain('PowerShell');

    const win = driftMessage({ kind: 'cli_missing' }, 'win32');
    expect(win).toContain('irm https://claude.ai/install.ps1 | iex');
    expect(win).toContain('install.cmd'); // cmd.exe variant also shown
    expect(win).not.toContain('curl -fsSL https://claude.ai/install.sh');
  });

  it('cli_old message names both versions and recommends `claude upgrade`', () => {
    const msg = driftMessage({ kind: 'cli_old', cli: '2.1.71', sdkExpects: '2.1.150' });
    expect(msg).toContain('2.1.71');
    expect(msg).toContain('2.1.150');
    expect(msg).toContain('claude upgrade');
    // It also calls out the multi-install footgun (since `claude upgrade` only
    // updates the one it shadows over).
    expect(msg).toContain('where claude');
  });

  it('cli_new_bedcoder_old message recommends upgrading bedcoder', () => {
    const msg = driftMessage({
      kind: 'cli_new_bedcoder_old',
      cli: '2.2.0',
      sdkExpects: '2.1.150',
      have: '0.1.5',
      latest: '0.2.0',
    });
    expect(msg).toContain('0.1.5');
    expect(msg).toContain('0.2.0');
    expect(msg).toContain('npm install -g bedcoder@latest');
  });

  it('cli_new_bedcoder_latest is informational only (no install command)', () => {
    const msg = driftMessage({ kind: 'cli_new_bedcoder_latest', cli: '2.2.0', sdkExpects: '2.1.150' });
    expect(msg).not.toContain('npm install');
    expect(msg).toContain('2.2.0');
    expect(msg).toContain('2.1.150');
  });
});

describe('fetchLatestBedcoder', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the version field on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.2.0' }) })));
    expect(await fetchLatestBedcoder('http://x')).toBe('0.2.0');
  });

  it('returns undefined on non-ok / missing version / throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await fetchLatestBedcoder('http://x')).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await fetchLatestBedcoder('http://x')).toBeUndefined();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchLatestBedcoder('http://x')).toBeUndefined();
  });
});

describe('runVersionCheck', () => {
  // A pair of streams we can introspect + drive. isTTY is settable so we can
  // exercise both interactive and non-TTY paths.
  function makeIo(opts: { tty: boolean; answer?: string }): {
    stdin: NodeJS.ReadStream;
    stdout: NodeJS.WriteStream;
    out: () => string;
  } {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    (stdin as unknown as { isTTY: boolean }).isTTY = opts.tty;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c));
    // Feed the answer once a 'data' listener is attached (readline writes its
    // prompt synchronously after attaching).
    if (opts.tty && opts.answer !== undefined) {
      stdin.on('newListener', (ev) => {
        if (ev === 'data') setImmediate(() => stdin.write(opts.answer + '\n'));
      });
    }
    return { stdin, stdout, out: () => Buffer.concat(chunks).toString('utf-8') };
  }

  const okInfo: VersionInfo = {
    cliVersion: '2.1.150',
    sdkCliVersion: '2.1.150',
    bedcoderVersion: '0.1.5',
    latestBedcoder: '0.1.5',
  };

  it('returns true silently on ok', async () => {
    const io = makeIo({ tty: true });
    const ok = await runVersionCheck({ stdin: io.stdin, stdout: io.stdout, gather: async () => okInfo });
    expect(ok).toBe(true);
    expect(io.out()).toBe('');
  });

  it('prints the soft note (no prompt) on cli_new_bedcoder_latest', async () => {
    const io = makeIo({ tty: true });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: '2.2.0' }),
    });
    expect(ok).toBe(true);
    expect(io.out()).toContain('newer than what this bedcoder');
  });

  it('prompts on cli_old and returns false on N', async () => {
    const io = makeIo({ tty: true, answer: 'n' });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: '2.0.0' }),
    });
    expect(ok).toBe(false);
    expect(io.out()).toContain('older than');
    expect(io.out()).toContain('Aborted');
  });

  it('prompts on cli_old and returns true on y', async () => {
    const io = makeIo({ tty: true, answer: 'y' });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: '2.0.0' }),
    });
    expect(ok).toBe(true);
  });

  it('treats empty answer (just enter) as N — default decline', async () => {
    const io = makeIo({ tty: true, answer: '' });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: '2.0.0' }),
    });
    expect(ok).toBe(false);
  });

  it('non-TTY + cli_missing returns false (can\'t run without CLI)', async () => {
    const io = makeIo({ tty: false });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: undefined }),
    });
    expect(ok).toBe(false);
    expect(io.out()).toContain('Claude CLI not found');
    expect(io.out()).toContain('cannot proceed');
  });

  it('non-TTY + cli_old continues anyway (CI shouldn\'t block on prompt)', async () => {
    const io = makeIo({ tty: false });
    const ok = await runVersionCheck({
      stdin: io.stdin,
      stdout: io.stdout,
      gather: async () => ({ ...okInfo, cliVersion: '2.0.0' }),
    });
    expect(ok).toBe(true);
    expect(io.out()).toContain('continuing anyway');
  });
});
