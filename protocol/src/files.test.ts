import { describe, it, expect } from 'vitest';
import {
  filesInputSchema,
  filesOutputSchema,
  fileEntrySchema,
  type FilesInput,
  type FilesOutput,
  type FileEntry,
} from './files';

// ============================================================================
// Valid Test Cases
// ============================================================================

const validEntries: FileEntry[] = [
  { name: 'file.txt', type: 'file', size: 1024, mtime: 1700000000 },
  { name: 'dir', type: 'dir', size: 0, mtime: 1700000000, mode: 0o755 },
  { name: 'link', type: 'symlink', size: 0, mtime: 1700000000, target: '../other' },
  { name: '.hidden', type: 'file', size: 512, mtime: 1700000000, mode: 0o644 },
];

const validInputs: FilesInput[] = [
  // ls
  { type: 'ls', id: 'req-1', path: '.' },
  { type: 'ls', id: 'req-2', path: 'src', showHidden: true },
  // read
  { type: 'read', id: 'req-3', path: 'file.txt' },
  { type: 'read', id: 'req-4', path: 'big.bin', offset: 1000, limit: 4096 },
  // write
  { type: 'write', id: 'req-5', path: 'new.txt', contentBase64: 'SGVsbG8=' },
  { type: 'write', id: 'req-6', path: 'deep/nested/file.txt', contentBase64: 'dGVzdA==', createDirs: true },
  // mkdir
  { type: 'mkdir', id: 'req-7', path: 'newdir' },
  { type: 'mkdir', id: 'req-8', path: 'a/b/c', recursive: true },
  // rm
  { type: 'rm', id: 'req-9', path: 'file.txt' },
  { type: 'rm', id: 'req-10', path: 'dir', recursive: true },
  // mv
  { type: 'mv', id: 'req-11', src: 'old.txt', dst: 'new.txt' },
  { type: 'mv', id: 'req-12', src: 'a', dst: 'b', overwrite: true },
  // stat
  { type: 'stat', id: 'req-13', path: 'file.txt' },
  { type: 'stat', id: 'req-14', path: 'link', followSymlinks: false },
  // search
  { type: 'search', id: 'req-15', pattern: '*.ts' },
  { type: 'search', id: 'req-16', pattern: '**/*.test.ts', path: 'src', maxResults: 50 },
];

const validOutputs: FilesOutput[] = [
  // ls_result
  { type: 'ls_result', id: 'req-1', path: '.', entries: validEntries },
  { type: 'ls_result', id: 'req-2', path: 'src', entries: [] },
  // read_result
  { type: 'read_result', id: 'req-3', path: 'file.txt', contentBase64: 'Y29udGVudA==', size: 7 },
  { type: 'read_result', id: 'req-4', path: 'big.bin', contentBase64: 'AAAA', size: 10000, truncated: true },
  // ok
  { type: 'ok', id: 'req-5' },
  { type: 'ok', id: 'req-6', message: 'Created 3 directories' },
  // stat_result
  {
    type: 'stat_result',
    id: 'req-13',
    path: 'file.txt',
    entry: { name: 'file.txt', type: 'file', size: 1024, mtime: 1700000000 },
  },
  // search_result
  { type: 'search_result', id: 'req-15', pattern: '*.ts', matches: ['index.ts', 'utils.ts'] },
  { type: 'search_result', id: 'req-16', pattern: '**/*.test.ts', matches: [], truncated: false },
  // error
  { type: 'error', id: 'req-1', code: 'not_found', message: 'File not found: missing.txt' },
  { type: 'error', id: 'req-2', code: 'permission_denied', message: 'Access denied: ~/.ssh/id_rsa' },
  { type: 'error', id: 'req-3', code: 'already_exists', message: 'Directory already exists: dir' },
  { type: 'error', id: 'req-4', code: 'not_empty', message: 'Directory not empty: dir' },
  { type: 'error', id: 'req-5', code: 'not_a_directory', message: 'Not a directory: file.txt' },
  { type: 'error', id: 'req-6', code: 'not_a_file', message: 'Not a file: dir' },
  { type: 'error', id: 'req-7', code: 'too_large', message: 'File too large: 100MB' },
  { type: 'error', id: 'req-8', code: 'invalid_path', message: 'Invalid path: ../../../etc/passwd' },
  { type: 'error', id: 'req-9', code: 'io_error', message: 'Read error' },
];

// ============================================================================
// Tests
// ============================================================================

describe('fileEntrySchema', () => {
  it.each(validEntries)('accepts %o', (entry) => {
    expect(() => fileEntrySchema.parse(entry)).not.toThrow();
  });

  it('rejects missing name', () => {
    expect(() => fileEntrySchema.parse({ type: 'file', size: 100, mtime: 1 })).toThrow();
  });

  it('rejects invalid type', () => {
    expect(() =>
      fileEntrySchema.parse({ name: 'f', type: 'socket', size: 0, mtime: 1 }),
    ).toThrow();
  });

  it('rejects negative size', () => {
    expect(() =>
      fileEntrySchema.parse({ name: 'f', type: 'file', size: -1, mtime: 1 }),
    ).toThrow();
  });
});

describe('filesInputSchema', () => {
  it.each(validInputs)('accepts %o', (input) => {
    expect(() => filesInputSchema.parse(input)).not.toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => filesInputSchema.parse({ type: 'copy', id: 'r1', src: 'a', dst: 'b' })).toThrow();
  });

  it('rejects missing id', () => {
    expect(() => filesInputSchema.parse({ type: 'ls', path: '.' })).toThrow();
  });

  it('rejects missing path for ls', () => {
    expect(() => filesInputSchema.parse({ type: 'ls', id: 'r1' })).toThrow();
  });

  it('rejects negative offset for read', () => {
    expect(() =>
      filesInputSchema.parse({ type: 'read', id: 'r1', path: 'f', offset: -1 }),
    ).toThrow();
  });

  it('rejects zero limit for read', () => {
    expect(() =>
      filesInputSchema.parse({ type: 'read', id: 'r1', path: 'f', limit: 0 }),
    ).toThrow();
  });
});

describe('filesOutputSchema', () => {
  it.each(validOutputs)('accepts %o', (output) => {
    expect(() => filesOutputSchema.parse(output)).not.toThrow();
  });

  it('rejects unknown type', () => {
    expect(() => filesOutputSchema.parse({ type: 'copy_result', id: 'r1' })).toThrow();
  });

  it('rejects invalid error code', () => {
    expect(() =>
      filesOutputSchema.parse({ type: 'error', id: 'r1', code: 'unknown', message: 'oops' }),
    ).toThrow();
  });

  it('rejects ls_result with invalid entry', () => {
    expect(() =>
      filesOutputSchema.parse({
        type: 'ls_result',
        id: 'r1',
        path: '.',
        entries: [{ name: 'f' }], // missing required fields
      }),
    ).toThrow();
  });
});

describe('round-trip parsing', () => {
  it('parses and re-parses ls input', () => {
    const input: FilesInput = { type: 'ls', id: 'test', path: 'src', showHidden: true };
    const parsed = filesInputSchema.parse(input);
    expect(filesInputSchema.parse(parsed)).toEqual(input);
  });

  it('parses and re-parses ls_result output', () => {
    const output: FilesOutput = {
      type: 'ls_result',
      id: 'test',
      path: 'src',
      entries: [{ name: 'index.ts', type: 'file', size: 100, mtime: 1700000000 }],
    };
    const parsed = filesOutputSchema.parse(output);
    expect(filesOutputSchema.parse(parsed)).toEqual(output);
  });
});
