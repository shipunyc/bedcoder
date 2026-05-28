import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { selectProvider } from './provider_select';
import type { BedcoderConfig } from './providers_config';

// Mirrors makeIo from version_check.test.ts. Builds a settable-isTTY PassThrough
// pair and feeds queued answers to readline prompts as they're attached.
function makeIo(opts: { tty: boolean; answers?: string[] }): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  out: () => string;
} {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  (stdin as unknown as { isTTY: boolean }).isTTY = opts.tty;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c));

  // readline attaches a 'data' listener per prompt — we feed one queued answer
  // for each attach. setImmediate ensures the prompt text is flushed first.
  let answerIdx = 0;
  const answers = opts.answers ?? [];
  if (opts.tty) {
    stdin.on('newListener', (ev) => {
      if (ev === 'data' && answerIdx < answers.length) {
        const a = answers[answerIdx++]!;
        setImmediate(() => stdin.write(a + '\n'));
      }
    });
  }
  return { stdin, stdout, out: () => Buffer.concat(chunks).toString('utf-8') };
}

describe('selectProvider', () => {
  // exit is called on the unhappy non-TTY path; spy on it instead of really
  // exiting the test process. The vi.spyOn signature for `process.exit`
  // doesn't align with the broader MockInstance shape, so we keep the handle
  // as `unknown` and use it only for restore().
  let exitSpy: { mockRestore: () => void };

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('forced --claude flag: no menu, no key needed, returns claude spec', async () => {
    const io = makeIo({ tty: true });
    const writes: BedcoderConfig[] = [];
    const sel = await selectProvider('claude', {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: (c) => writes.push(c),
    });
    expect(sel.spec.id).toBe('claude');
    expect(sel.apiKey).toBeUndefined();
    // First-ever selection of claude → defaultProvider gets persisted.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.defaultProvider).toBe('claude');
  });

  it('forced --glm with cached key: skips prompt, returns the saved key', async () => {
    const io = makeIo({ tty: true });
    const sel = await selectProvider('glm', {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({
        defaultProvider: 'glm',
        providers: { glm: { apiKey: 'cached-glm-key' } },
      }),
      writeConfig: () => {},
    });
    expect(sel.spec.id).toBe('glm');
    expect(sel.apiKey).toBe('cached-glm-key');
    // No prompt was written (cache hit short-circuits all I/O).
    expect(io.out()).toBe('');
  });

  it('forced --glm with env fallback (no cache): uses GLM_API_KEY', async () => {
    const io = makeIo({ tty: true });
    const sel = await selectProvider('glm', {
      stdin: io.stdin,
      stdout: io.stdout,
      env: { GLM_API_KEY: 'env-glm-key' },
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(sel.apiKey).toBe('env-glm-key');
    expect(io.out()).toBe('');
  });

  it('forced --glm, no cache, no env, non-TTY: exits with helpful message', async () => {
    const io = makeIo({ tty: false });
    await expect(
      selectProvider('glm', {
        stdin: io.stdin,
        stdout: io.stdout,
        env: {},
        readConfig: () => ({}),
        writeConfig: () => {},
      }),
    ).rejects.toThrow(/process.exit\(1\)/);
    expect(io.out()).toContain('No saved API key');
    expect(io.out()).toContain('GLM_API_KEY');
  });

  it('forced --glm, no cache, TTY: prompts for key, prompts to save, persists', async () => {
    // Two answers: the key, then "y" to save.
    const io = makeIo({ tty: true, answers: ['the-key', 'y'] });
    const writes: BedcoderConfig[] = [];
    const sel = await selectProvider('glm', {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: (c) => writes.push(c),
    });
    expect(sel.apiKey).toBe('the-key');
    expect(io.out()).toContain('Enter your');
    expect(io.out()).toContain('Save this key');
    // Single write at the end, containing both default + saved key.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.defaultProvider).toBe('glm');
    expect(writes[0]?.providers?.glm?.apiKey).toBe('the-key');
  });

  it('forced --glm, no cache, TTY: declining save still returns the key (in-memory only)', async () => {
    const io = makeIo({ tty: true, answers: ['the-key', 'n'] });
    const writes: BedcoderConfig[] = [];
    const sel = await selectProvider('glm', {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: (c) => writes.push(c),
    });
    expect(sel.apiKey).toBe('the-key');
    // defaultProvider still persisted, but no apiKey saved.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.providers?.glm).toBeUndefined();
  });

  it('no flag, TTY, with cached default glm: menu pre-selects glm, Enter accepts', async () => {
    // One answer: bare Enter → take the cached default.
    const io = makeIo({ tty: true, answers: [''] });
    const sel = await selectProvider(undefined, {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({
        defaultProvider: 'glm',
        providers: { glm: { apiKey: 'cached' } },
      }),
      writeConfig: () => {},
    });
    expect(sel.spec.id).toBe('glm');
    expect(sel.apiKey).toBe('cached');
    expect(io.out()).toContain('Choose your AI provider');
    // Pre-selection asterisk on glm (index 3 / line "  3)").
    expect(io.out()).toMatch(/\* 3\) GLM/);
  });

  it('no flag, TTY, no cached default: menu shows claude as default', async () => {
    const io = makeIo({ tty: true, answers: [''] });
    const sel = await selectProvider(undefined, {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(sel.spec.id).toBe('claude');
    expect(io.out()).toMatch(/\* 1\) Claude/);
  });

  it('no flag, TTY: numeric selection picks the matching provider', async () => {
    // Pick 4 (deepseek), then provide a key and save.
    const io = makeIo({ tty: true, answers: ['4', 'ds-key', 'y'] });
    const writes: BedcoderConfig[] = [];
    const sel = await selectProvider(undefined, {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: (c) => writes.push(c),
    });
    expect(sel.spec.id).toBe('deepseek');
    expect(sel.apiKey).toBe('ds-key');
    expect(writes[0]?.defaultProvider).toBe('deepseek');
  });

  it('no flag, non-TTY: silently uses cached default (no menu)', async () => {
    const io = makeIo({ tty: false });
    const sel = await selectProvider(undefined, {
      stdin: io.stdin,
      stdout: io.stdout,
      env: { GLM_API_KEY: 'env-key' }, // env fallback satisfies the non-TTY key need
      readConfig: () => ({ defaultProvider: 'glm' }),
      writeConfig: () => {},
    });
    expect(sel.spec.id).toBe('glm');
    expect(sel.apiKey).toBe('env-key');
    expect(io.out()).toBe(''); // no menu rendered
  });

  it('invalid menu input falls back to the default with a warning', async () => {
    const io = makeIo({ tty: true, answers: ['banana'] });
    const sel = await selectProvider(undefined, {
      stdin: io.stdin,
      stdout: io.stdout,
      env: {},
      readConfig: () => ({}),
      writeConfig: () => {},
    });
    expect(sel.spec.id).toBe('claude');
    expect(io.out()).toContain('Invalid selection');
  });
});
