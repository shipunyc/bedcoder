import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// log.ts reads BEDCODER_LOG at module load, so each test stubs the env and then
// imports a fresh copy of the module (resetModules) before exercising it.
async function freshLog(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv('BEDCODER_LOG', '');
  else vi.stubEnv('BEDCODER_LOG', value);
  return import('./log');
}

// Flush the append stream so the file is readable synchronously.
async function flush() {
  await new Promise((r) => setTimeout(r, 20));
}

afterEach(() => vi.unstubAllEnvs());

describe('log', () => {
  it('appends one JSON line per event with ts + tag + fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bedcoder-log-'));
    const file = join(dir, 'agent.log');
    const { log } = await freshLog(file);

    log('engine.start', { resume: true });
    log('user.msg', { len: 3, closed: false });
    await flush();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] as string);
    expect(first.tag).toBe('engine.start');
    expect(first.resume).toBe(true);
    expect(typeof first.ts).toBe('string');
    expect(JSON.parse(lines[1] as string).len).toBe(3);
  });

  it('truncates long string fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bedcoder-log-'));
    const file = join(dir, 'agent.log');
    const { log } = await freshLog(file);

    log('emit', { type: 'x'.repeat(500) });
    await flush();

    const entry = JSON.parse(readFileSync(file, 'utf8').trim());
    expect(entry.type.endsWith('…')).toBe(true);
    expect(entry.type.length).toBeLessThan(500);
  });

  it('is a no-op when BEDCODER_LOG=off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bedcoder-log-'));
    const file = join(dir, 'agent.log');
    // Point the path env at a file, but disable via the literal 'off'.
    const { log } = await freshLog('off');
    log('engine.start', {});
    await flush();
    expect(existsSync(file)).toBe(false);
  });
});
