import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectDirName,
  listSessions,
  latestSessionId,
  listSessionsWithPreview,
  readTranscript,
  readLatestTasks,
} from './sessions';

describe('projectDirName', () => {
  it('encodes a Unix cwd like Claude Code (/ and . -> -)', () => {
    expect(projectDirName('/Users/User/bedcoder')).toBe('-Users-User-bedcoder');
    expect(projectDirName('/a/b.c')).toBe('-a-b-c');
  });

  it('encodes Windows separators (\\ and drive :) -> -', () => {
    expect(projectDirName('C:\\Users\\User\\bedcoder')).toBe('C--Users-User-bedcoder');
    expect(projectDirName('D:\\work\\proj.v2')).toBe('D--work-proj-v2');
  });
});

describe('listSessions / latestSessionId', () => {
  const cwd = '/work/proj';
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bedcoder-claude-'));
  });

  function writeSession(id: string, mtimeSeconds: number): void {
    const dir = join(home, 'projects', projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, '{}');
    utimesSync(file, mtimeSeconds, mtimeSeconds);
  }

  it('returns sessions newest-first', () => {
    writeSession('older', 1000);
    writeSession('newer', 2000);
    expect(listSessions(cwd, home).map((s) => s.id)).toEqual(['newer', 'older']);
    expect(latestSessionId(cwd, home)).toBe('newer');
  });

  it('ignores non-jsonl files', () => {
    writeSession('s1', 1000);
    writeFileSync(join(home, 'projects', projectDirName(cwd), 'notes.txt'), 'x');
    expect(listSessions(cwd, home).map((s) => s.id)).toEqual(['s1']);
  });

  it('returns empty / undefined for an unknown project', () => {
    expect(listSessions('/no/such/project', home)).toEqual([]);
    expect(latestSessionId('/no/such/project', home)).toBeUndefined();
  });
});

describe('listSessionsWithPreview', () => {
  const cwd = '/work/proj';
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bedcoder-claude-'));
  });

  function writeJsonl(id: string, lines: string, mtimeSeconds = 1000): void {
    const dir = join(home, 'projects', projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, lines);
    utimesSync(file, mtimeSeconds, mtimeSeconds);
  }

  it('uses the first user message as the preview (string content)', () => {
    writeJsonl('s1', `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the dart2js bug' } })}\n`);
    expect(listSessionsWithPreview(cwd, home)).toEqual([
      { id: 's1', mtimeMs: expect.any(Number), preview: 'fix the dart2js bug' },
    ]);
  });

  it('extracts text from array content and skips non-user lines', () => {
    const lines =
      `${JSON.stringify({ type: 'system', subtype: 'init' })}\n` +
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello there' }] } })}\n`;
    writeJsonl('s1', lines);
    expect(listSessionsWithPreview(cwd, home)[0]!.preview).toBe('hello there');
  });

  it('filters out warmup / empty / malformed sessions, keeps real ones', () => {
    // Noise: Claude Code's warmup turns and sessions with nothing to resume.
    writeJsonl('warm', `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Warmup' } })}\n`);
    writeJsonl('bad', 'not json at all\n{partial'); // → (no messages)
    writeJsonl('empty', ''); // → (no messages)
    writeJsonl('real', `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' } })}\n`);

    const sessions = listSessionsWithPreview(cwd, home);
    expect(sessions.map((s) => s.id)).toEqual(['real']); // noise dropped, no throw on bad files
    expect(sessions[0]!.preview).toBe('do the thing');
  });
});

describe('readTranscript', () => {
  const cwd = '/work/proj';
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bedcoder-claude-'));
  });

  function writeJsonl(id: string, lines: string): void {
    const dir = join(home, 'projects', projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines);
  }

  it('renders user/assistant text + tool lines, dropping thinking and meta', () => {
    const lines =
      `${JSON.stringify({ type: 'permission-mode', permissionMode: 'default' })}\n` +
      `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'do it' } })}\n` +
      `${JSON.stringify({ type: 'system', subtype: 'turn_duration' })}\n` +
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'hmm' },
            { type: 'text', text: 'on it' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      })}\n` +
      `${JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta noise' } })}\n` +
      `${JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent' } })}\n`;
    writeJsonl('s1', lines);

    expect(readTranscript(cwd, 's1', home)).toEqual([
      { role: 'user', text: 'do it', uuid: 'u1', rawText: 'do it' },
      { role: 'assistant', text: 'on it', uuid: 'a1' },
      { role: 'tool', text: 'Bash(ls)', toolName: 'Bash', uuid: 'a1' },
    ]);
  });

  it('keeps user newlines in rawText (text is collapsed for display)', () => {
    writeJsonl('s1', JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'line one\nline two' } }));
    const e = readTranscript(cwd, 's1', home)[0]!;
    expect(e.text).toBe('line one line two'); // collapsed
    expect(e.rawText).toBe('line one\nline two'); // preserved for rewind prefill
  });

  it('handles string and array user content', () => {
    const lines =
      `${JSON.stringify({ type: 'user', message: { content: 'plain string' } })}\n` +
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'from array' }] } })}\n`;
    writeJsonl('s1', lines);
    expect(readTranscript(cwd, 's1', home).map((e) => e.text)).toEqual(['plain string', 'from array']);
  });

  it('keeps only the last maxLines entries', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `m${i}` } }),
    ).join('\n');
    writeJsonl('s1', lines);
    const out = readTranscript(cwd, 's1', home, { maxLines: 3 });
    expect(out.map((e) => e.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('returns [] for a missing session', () => {
    expect(readTranscript(cwd, 'nope', home)).toEqual([]);
  });

  it('skips TodoWrite tool lines (shown as the task list instead)', () => {
    const lines = `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] },
    })}\n`;
    writeJsonl('s1', lines);
    expect(readTranscript(cwd, 's1', home)).toEqual([]);
  });
});

describe('readLatestTasks', () => {
  const cwd = '/work/proj';
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'bedcoder-claude-'));
  });

  function writeJsonl(id: string, lines: string): void {
    const dir = join(home, 'projects', projectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines);
  }

  it('returns the latest TodoWrite todo list', () => {
    const todo = (c: string, s: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: c, status: s, activeForm: c }] } }] },
      });
    writeJsonl('s1', `${todo('first', 'completed')}\n${todo('second', 'in_progress')}\n`);
    expect(readLatestTasks(cwd, 's1', home)).toEqual([
      { content: 'second', status: 'in_progress', activeForm: 'second' },
    ]);
  });

  it('returns undefined when there are no todos / missing file', () => {
    writeJsonl('none', `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
    expect(readLatestTasks(cwd, 'none', home)).toBeUndefined();
    expect(readLatestTasks(cwd, 'missing', home)).toBeUndefined();
  });
});
