import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogTailer } from './log_tailer';

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('LogTailer', () => {
  let dir: string;
  let tailer: LogTailer;
  const got: Record<string, string> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bedcoder-tail-'));
    tailer = new LogTailer((id, data) => {
      got[id] = (got[id] ?? '') + data;
    }, 25);
  });
  afterEach(() => {
    tailer.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams bytes appended to the file after start()', async () => {
    const f = join(dir, 'a.output');
    writeFileSync(f, 'first line\n');
    tailer.start('t1', f);
    await waitUntil(() => (got.t1 ?? '').includes('first line'));

    appendFileSync(f, 'second line\n');
    await waitUntil(() => (got.t1 ?? '').includes('second line'));
    expect(got.t1).toContain('first line');
    expect(got.t1).toContain('second line');
  });

  it('tolerates a not-yet-created file, then picks it up', async () => {
    const f = join(dir, 'later.output');
    tailer.start('t2', f); // file doesn't exist yet
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(f, 'appeared\n');
    await waitUntil(() => (got.t2 ?? '').includes('appeared'));
    expect(got.t2).toContain('appeared');
  });

  it('stop() flushes final bytes and halts further reads', async () => {
    const f = join(dir, 'c.output');
    writeFileSync(f, 'a\n');
    tailer.start('t3', f);
    await waitUntil(() => (got.t3 ?? '').includes('a'));
    appendFileSync(f, 'b\n'); // written just before stop — should be flushed
    tailer.stop('t3');
    expect(got.t3).toContain('b');

    appendFileSync(f, 'c\n'); // after stop — must NOT be read
    await new Promise((r) => setTimeout(r, 60));
    expect(got.t3).not.toContain('c');
  });
});
