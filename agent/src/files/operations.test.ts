import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processFilesRequest } from './operations';
import type { FilesInput } from '@bedcoder/protocol';

// ============================================================================
// Test Setup
// ============================================================================

let testRoot: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `files-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });

  // Create test structure
  mkdirSync(join(testRoot, 'src'));
  mkdirSync(join(testRoot, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(testRoot, 'file.txt'), 'Hello World');
  writeFileSync(join(testRoot, 'src', 'index.ts'), 'export const x = 1;');
  writeFileSync(join(testRoot, 'src', 'utils.ts'), 'export function foo() {}');
  writeFileSync(join(testRoot, '.hidden'), 'hidden file');
  writeFileSync(join(testRoot, 'package.json'), '{"name": "test"}');
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// ls Tests
// ============================================================================

describe('ls operation', () => {
  it('lists directory contents', () => {
    const input: FilesInput = { type: 'ls', id: 'test-1', path: '.' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ls_result');
    if (result.type === 'ls_result') {
      expect(result.id).toBe('test-1');
      expect(result.entries.length).toBeGreaterThan(0);

      // Check that directories come first
      const dirIndex = result.entries.findIndex((e) => e.name === 'src');
      const fileIndex = result.entries.findIndex((e) => e.name === 'file.txt');
      expect(dirIndex).toBeLessThan(fileIndex);

      // Check that hidden files are excluded by default
      expect(result.entries.find((e) => e.name === '.hidden')).toBeUndefined();
    }
  });

  it('includes hidden files when requested', () => {
    const input: FilesInput = { type: 'ls', id: 'test-2', path: '.', showHidden: true };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ls_result');
    if (result.type === 'ls_result') {
      expect(result.entries.find((e) => e.name === '.hidden')).toBeDefined();
    }
  });

  it('lists subdirectory', () => {
    const input: FilesInput = { type: 'ls', id: 'test-3', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ls_result');
    if (result.type === 'ls_result') {
      expect(result.entries.find((e) => e.name === 'index.ts')).toBeDefined();
    }
  });

  it('returns error for non-existent directory', () => {
    const input: FilesInput = { type: 'ls', id: 'test-4', path: 'nonexistent' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_found');
    }
  });

  it('returns error for file (not directory)', () => {
    const input: FilesInput = { type: 'ls', id: 'test-5', path: 'file.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_a_directory');
    }
  });

  it('blocks path traversal', () => {
    const input: FilesInput = { type: 'ls', id: 'test-6', path: '../..' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('invalid_path');
    }
  });
});

// ============================================================================
// read Tests
// ============================================================================

describe('read operation', () => {
  it('reads file contents', () => {
    const input: FilesInput = { type: 'read', id: 'test-1', path: 'file.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('read_result');
    if (result.type === 'read_result') {
      const content = Buffer.from(result.contentBase64, 'base64').toString('utf-8');
      expect(content).toBe('Hello World');
      expect(result.size).toBe(11);
      expect(result.truncated).toBeFalsy();
    }
  });

  it('reads nested file', () => {
    const input: FilesInput = { type: 'read', id: 'test-2', path: 'src/index.ts' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('read_result');
    if (result.type === 'read_result') {
      const content = Buffer.from(result.contentBase64, 'base64').toString('utf-8');
      expect(content).toBe('export const x = 1;');
    }
  });

  it('reads binary file', () => {
    // Create a binary file
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
    writeFileSync(join(testRoot, 'binary.bin'), binary);

    const input: FilesInput = { type: 'read', id: 'test-3', path: 'binary.bin' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('read_result');
    if (result.type === 'read_result') {
      const content = Buffer.from(result.contentBase64, 'base64');
      expect(content).toEqual(binary);
    }
  });

  it('reads with offset and limit', () => {
    const input: FilesInput = { type: 'read', id: 'test-4', path: 'file.txt', offset: 6, limit: 5 };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('read_result');
    if (result.type === 'read_result') {
      const content = Buffer.from(result.contentBase64, 'base64').toString('utf-8');
      expect(content).toBe('World');
      expect(result.truncated).toBe(false);
    }
  });

  it('returns error for non-existent file', () => {
    const input: FilesInput = { type: 'read', id: 'test-5', path: 'nonexistent.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_found');
    }
  });

  it('returns error for directory', () => {
    const input: FilesInput = { type: 'read', id: 'test-6', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_a_file');
    }
  });

  it('blocks sensitive files', () => {
    writeFileSync(join(testRoot, '.env'), 'SECRET=value');
    const input: FilesInput = { type: 'read', id: 'test-7', path: '.env' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('permission_denied');
    }
  });
});

// ============================================================================
// write Tests
// ============================================================================

describe('write operation', () => {
  it('writes new file', () => {
    const content = 'New content';
    const input: FilesInput = {
      type: 'write',
      id: 'test-1',
      path: 'new.txt',
      contentBase64: Buffer.from(content).toString('base64'),
    };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'new.txt'))).toBe(true);
    expect(readFileSync(join(testRoot, 'new.txt'), 'utf-8')).toBe(content);
  });

  it('overwrites existing file', () => {
    const content = 'Updated content';
    const input: FilesInput = {
      type: 'write',
      id: 'test-2',
      path: 'file.txt',
      contentBase64: Buffer.from(content).toString('base64'),
    };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(readFileSync(join(testRoot, 'file.txt'), 'utf-8')).toBe(content);
  });

  it('creates parent directories when requested', () => {
    const content = 'Deep content';
    const input: FilesInput = {
      type: 'write',
      id: 'test-3',
      path: 'a/b/c/file.txt',
      contentBase64: Buffer.from(content).toString('base64'),
      createDirs: true,
    };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'a/b/c/file.txt'))).toBe(true);
  });

  it('fails without createDirs when parent missing', () => {
    const content = 'Content';
    const input: FilesInput = {
      type: 'write',
      id: 'test-4',
      path: 'missing/file.txt',
      contentBase64: Buffer.from(content).toString('base64'),
    };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_found');
    }
  });

  it('blocks writing to sensitive paths', () => {
    const input: FilesInput = {
      type: 'write',
      id: 'test-5',
      path: '.env',
      contentBase64: Buffer.from('SECRET=value').toString('base64'),
    };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('permission_denied');
    }
  });
});

// ============================================================================
// mkdir Tests
// ============================================================================

describe('mkdir operation', () => {
  it('creates directory', () => {
    const input: FilesInput = { type: 'mkdir', id: 'test-1', path: 'newdir' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'newdir'))).toBe(true);
  });

  it('creates nested directories with recursive', () => {
    const input: FilesInput = { type: 'mkdir', id: 'test-2', path: 'x/y/z', recursive: true };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'x/y/z'))).toBe(true);
  });

  it('fails for nested without recursive', () => {
    const input: FilesInput = { type: 'mkdir', id: 'test-3', path: 'missing/dir' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_found');
    }
  });

  it('returns error for existing directory', () => {
    const input: FilesInput = { type: 'mkdir', id: 'test-4', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('already_exists');
    }
  });
});

// ============================================================================
// rm Tests
// ============================================================================

describe('rm operation', () => {
  it('removes file', () => {
    const input: FilesInput = { type: 'rm', id: 'test-1', path: 'file.txt' };
    const result = processFilesRequest(testRoot, input);

    if (result.type === 'error') {
      console.log('ERROR (rm file):', result.code, result.message);
    }
    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'file.txt'))).toBe(false);
  });

  it('removes empty directory', () => {
    mkdirSync(join(testRoot, 'empty'));
    const input: FilesInput = { type: 'rm', id: 'test-2', path: 'empty' };
    const result = processFilesRequest(testRoot, input);

    if (result.type === 'error') {
      console.log('ERROR:', result.code, result.message);
    }
    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'empty'))).toBe(false);
  });

  it('removes non-empty directory with recursive', () => {
    const input: FilesInput = { type: 'rm', id: 'test-3', path: 'nested', recursive: true };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'nested'))).toBe(false);
  });

  it('fails on non-empty directory without recursive', () => {
    const input: FilesInput = { type: 'rm', id: 'test-4', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('not_empty');
    }
  });

  it('blocks removing project root', () => {
    const input: FilesInput = { type: 'rm', id: 'test-5', path: '.', recursive: true };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('permission_denied');
    }
  });
});

// ============================================================================
// mv Tests
// ============================================================================

describe('mv operation', () => {
  it('renames file', () => {
    const input: FilesInput = { type: 'mv', id: 'test-1', src: 'file.txt', dst: 'renamed.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'file.txt'))).toBe(false);
    expect(existsSync(join(testRoot, 'renamed.txt'))).toBe(true);
  });

  it('moves file to directory', () => {
    const input: FilesInput = { type: 'mv', id: 'test-2', src: 'file.txt', dst: 'src/moved.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    expect(existsSync(join(testRoot, 'src/moved.txt'))).toBe(true);
  });

  it('fails when destination exists without overwrite', () => {
    const input: FilesInput = { type: 'mv', id: 'test-3', src: 'file.txt', dst: 'package.json' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.code).toBe('already_exists');
    }
  });

  it('overwrites when requested', () => {
    const input: FilesInput = { type: 'mv', id: 'test-4', src: 'file.txt', dst: 'package.json', overwrite: true };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('ok');
    const content = readFileSync(join(testRoot, 'package.json'), 'utf-8');
    expect(content).toBe('Hello World');
  });
});

// ============================================================================
// stat Tests
// ============================================================================

describe('stat operation', () => {
  it('returns file stat', () => {
    const input: FilesInput = { type: 'stat', id: 'test-1', path: 'file.txt' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('stat_result');
    if (result.type === 'stat_result') {
      expect(result.entry.name).toBe('file.txt');
      expect(result.entry.type).toBe('file');
      expect(result.entry.size).toBe(11);
    }
  });

  it('returns directory stat', () => {
    const input: FilesInput = { type: 'stat', id: 'test-2', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('stat_result');
    if (result.type === 'stat_result') {
      expect(result.entry.name).toBe('src');
      expect(result.entry.type).toBe('dir');
    }
  });

  it('returns symlink stat with followSymlinks: false', () => {
    try {
      symlinkSync(join(testRoot, 'src'), join(testRoot, 'link'));
    } catch {
      return; // Skip on systems that don't support symlinks
    }

    const input: FilesInput = { type: 'stat', id: 'test-3', path: 'link', followSymlinks: false };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('stat_result');
    if (result.type === 'stat_result') {
      expect(result.entry.type).toBe('symlink');
      expect(result.entry.target).toBeDefined();
    }
  });
});

// ============================================================================
// search Tests
// ============================================================================

describe('search operation', () => {
  it('searches for files by extension', () => {
    const input: FilesInput = { type: 'search', id: 'test-1', pattern: '*.ts' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('search_result');
    if (result.type === 'search_result') {
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.endsWith('.ts'))).toBe(true);
    }
  });

  it('searches in subdirectory', () => {
    const input: FilesInput = { type: 'search', id: 'test-2', pattern: '*.ts', path: 'src' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('search_result');
    if (result.type === 'search_result') {
      expect(result.matches.length).toBe(2); // index.ts and utils.ts
    }
  });

  it('respects maxResults', () => {
    const input: FilesInput = { type: 'search', id: 'test-3', pattern: '*', maxResults: 2 };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('search_result');
    if (result.type === 'search_result') {
      expect(result.matches.length).toBeLessThanOrEqual(2);
      expect(result.truncated).toBe(true);
    }
  });

  it('returns empty for no matches', () => {
    const input: FilesInput = { type: 'search', id: 'test-4', pattern: '*.xyz' };
    const result = processFilesRequest(testRoot, input);

    expect(result.type).toBe('search_result');
    if (result.type === 'search_result') {
      expect(result.matches.length).toBe(0);
      expect(result.truncated).toBe(false);
    }
  });
});
