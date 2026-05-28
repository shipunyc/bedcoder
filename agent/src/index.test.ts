import { describe, it, expect } from 'vitest';
import { parseArgs, DEFAULT_RELAY_URL, DEFAULT_MODELS_URL } from './cli';

describe('parseArgs', () => {
  it('defaults to a new session on the default relay, logging off', () => {
    expect(parseArgs([])).toEqual({
      resume: false,
      relayUrl: DEFAULT_RELAY_URL,
      fake: false,
      log: false,
      modelsUrl: DEFAULT_MODELS_URL,
      rewindCode: false,
      skipVersionCheck: false,
    });
  });

  it('--skip-version-check opts out of the startup compatibility check', () => {
    expect(parseArgs([]).skipVersionCheck).toBe(false);
    expect(parseArgs(['--skip-version-check']).skipVersionCheck).toBe(true);
  });

  it('--rewind-code opts into file checkpointing (off by default)', () => {
    expect(parseArgs([]).rewindCode).toBe(false);
    expect(parseArgs(['--rewind-code']).rewindCode).toBe(true);
  });

  it('parses --model and --models-url (and rejects a bare --model)', () => {
    expect(parseArgs(['--model', 'claude-sonnet-4-6']).model).toBe('claude-sonnet-4-6');
    expect(parseArgs(['--models-url', 'http://localhost/m.json']).modelsUrl).toBe('http://localhost/m.json');
    expect(() => parseArgs(['--model'])).toThrow();
  });

  it('parses --worktree <name> (and rejects a missing name)', () => {
    expect(parseArgs(['--worktree', 'feat-x']).worktree).toBe('feat-x');
    expect(() => parseArgs(['--worktree'])).toThrow();
    expect(() => parseArgs(['--worktree', '--fake'])).toThrow();
  });

  it('parses --log (default path) and --log <path>', () => {
    const bare = parseArgs(['--log']);
    expect(bare.log).toBe(true);
    expect(bare.logPath).toBeUndefined(); // no path → daemon uses the default file
    const c = parseArgs(['--log', '/tmp/bedcoder.log']);
    expect(c.log).toBe(true);
    expect(c.logPath).toBe('/tmp/bedcoder.log');
    // A following flag is not consumed as the path.
    const flagAfter = parseArgs(['--log', '--fake']);
    expect(flagAfter.log).toBe(true);
    expect(flagAfter.fake).toBe(true);
    expect(flagAfter.logPath).toBeUndefined();
  });

  it('parses --resume and --fake', () => {
    const c = parseArgs(['--resume', '--fake']);
    expect(c.resume).toBe(true);
    expect(c.fake).toBe(true);
    expect(c.resumeId).toBeUndefined(); // --fake is a flag, not a resume id
  });

  it('parses --resume <id>', () => {
    const c = parseArgs(['--resume', 'sess-abc-123']);
    expect(c.resume).toBe(true);
    expect(c.resumeId).toBe('sess-abc-123');
  });

  it('parses --relay <url>', () => {
    expect(parseArgs(['--relay', 'wss://example.test']).relayUrl).toBe('wss://example.test');
  });

  it('accepts --tunnel with an optional value (preview is always on)', () => {
    expect(parseArgs(['--tunnel', 'auto']).tunnel).toBe('auto');
    expect(parseArgs(['--tunnel', '3000,8080']).tunnel).toBe('3000,8080');
    expect(parseArgs(['--tunnel']).tunnel).toBe('auto'); // bare flag
    // A following flag is not consumed as the value.
    const flagAfter = parseArgs(['--tunnel', '--fake']);
    expect(flagAfter.tunnel).toBe('auto');
    expect(flagAfter.fake).toBe(true);
  });

  it('rejects --relay without a value', () => {
    expect(() => parseArgs(['--relay'])).toThrow();
  });

  it('ignores a literal "--" separator (e.g. from `pnpm start -- …`)', () => {
    const c = parseArgs(['--', '--relay', 'wss://x', '--fake']);
    expect(c.relayUrl).toBe('wss://x');
    expect(c.fake).toBe(true);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--nope'])).toThrow();
  });
});
