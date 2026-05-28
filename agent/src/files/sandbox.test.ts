// 🔑 SECURITY CRITICAL TESTS
// These tests MUST pass to ensure sandbox security.
// Any failure indicates a potential security vulnerability.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { validatePath, validateDestination, Sandbox, SandboxError } from './sandbox';

// ============================================================================
// Test Setup
// ============================================================================

let testRoot: string;
let sandbox: Sandbox;

beforeEach(() => {
  // Create a temporary test directory
  testRoot = join(tmpdir(), `sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(testRoot, 'src'));
  mkdirSync(join(testRoot, 'nested', 'deep'), { recursive: true });
  writeFileSync(join(testRoot, 'file.txt'), 'content');
  writeFileSync(join(testRoot, 'src', 'index.ts'), 'export {}');

  sandbox = new Sandbox(testRoot);
});

afterEach(() => {
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

// ============================================================================
// Path Traversal Tests (🔑 CRITICAL)
// ============================================================================

describe('Path Traversal Prevention', () => {
  it('blocks ../../../etc/passwd', () => {
    expect(() => validatePath('../../../etc/passwd', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('../../../etc/passwd', testRoot)).toThrow('escapes sandbox');
  });

  it('blocks ../../..', () => {
    expect(() => validatePath('../../..', testRoot)).toThrow(SandboxError);
  });

  it('blocks /etc/passwd (absolute path outside root)', () => {
    expect(() => validatePath('/etc/passwd', testRoot)).toThrow(SandboxError);
  });

  it('blocks /etc/shadow', () => {
    expect(() => validatePath('/etc/shadow', testRoot)).toThrow(SandboxError);
  });

  it('blocks ../', () => {
    expect(() => validatePath('../', testRoot)).toThrow(SandboxError);
  });

  it('blocks ./../file', () => {
    expect(() => validatePath('./../file', testRoot)).toThrow(SandboxError);
  });

  it('blocks nested/../../../escape', () => {
    expect(() => validatePath('nested/../../../escape', testRoot)).toThrow(SandboxError);
  });

  it('blocks foo/../../..', () => {
    expect(() => validatePath('foo/../../..', testRoot)).toThrow(SandboxError);
  });

  it('allows valid relative paths', () => {
    expect(() => validatePath('file.txt', testRoot)).not.toThrow();
    expect(() => validatePath('./file.txt', testRoot)).not.toThrow();
    expect(() => validatePath('src/index.ts', testRoot)).not.toThrow();
    expect(() => validatePath('nested/deep/../file', testRoot)).not.toThrow();
  });

  it('allows . (current directory)', () => {
    const result = validatePath('.', testRoot);
    expect(result).toBe(resolve(testRoot));
  });

  it('blocks null bytes in path', () => {
    expect(() => validatePath('file\0.txt', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('file\0.txt', testRoot)).toThrow('null bytes');
  });
});

// ============================================================================
// Sensitive Path Tests (🔑 CRITICAL)
// ============================================================================

describe('Sensitive Path Blocking', () => {
  it('blocks ~/.ssh/id_rsa', () => {
    // Create a symlink to test the blacklist check
    const home = homedir();
    expect(() => validatePath(`${home}/.ssh/id_rsa`, testRoot)).toThrow(SandboxError);
  });

  it('blocks ~/.aws/credentials', () => {
    const home = homedir();
    expect(() => validatePath(`${home}/.aws/credentials`, testRoot)).toThrow(SandboxError);
  });

  it('blocks ~/.gnupg', () => {
    const home = homedir();
    expect(() => validatePath(`${home}/.gnupg`, testRoot)).toThrow(SandboxError);
  });

  it('blocks .env file', () => {
    // Even if .env exists in project root, it should be blocked
    writeFileSync(join(testRoot, '.env'), 'SECRET=value');
    expect(() => validatePath('.env', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('.env', testRoot)).toThrow('sensitive');
  });

  it('blocks .env.local', () => {
    writeFileSync(join(testRoot, '.env.local'), 'SECRET=value');
    expect(() => validatePath('.env.local', testRoot)).toThrow(SandboxError);
  });

  it('blocks .env.production', () => {
    expect(() => validatePath('.env.production', testRoot)).toThrow(SandboxError);
  });

  it('blocks nested .env files', () => {
    mkdirSync(join(testRoot, 'config'));
    writeFileSync(join(testRoot, 'config', '.env'), 'SECRET=value');
    expect(() => validatePath('config/.env', testRoot)).toThrow(SandboxError);
  });

  it('blocks files with credentials in name', () => {
    expect(() => validatePath('aws_credentials', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('my_credentials.json', testRoot)).toThrow(SandboxError);
  });

  it('blocks files with secret in name', () => {
    expect(() => validatePath('my_secret.txt', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('secrets.json', testRoot)).toThrow(SandboxError);
  });

  it('blocks .pem files', () => {
    expect(() => validatePath('private.pem', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('cert.pem', testRoot)).toThrow(SandboxError);
  });

  it('blocks .key files', () => {
    expect(() => validatePath('server.key', testRoot)).toThrow(SandboxError);
  });

  it('blocks id_rsa files', () => {
    expect(() => validatePath('id_rsa', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('id_rsa.pub', testRoot)).toThrow(SandboxError);
  });

  it('blocks id_ed25519 files', () => {
    expect(() => validatePath('id_ed25519', testRoot)).toThrow(SandboxError);
  });

  it('blocks token files', () => {
    expect(() => validatePath('github_token', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('access_token.txt', testRoot)).toThrow(SandboxError);
  });

  it('blocks api_key files', () => {
    expect(() => validatePath('api_key.txt', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('my_apikey', testRoot)).toThrow(SandboxError);
  });

  it('allows normal project files', () => {
    expect(() => validatePath('package.json', testRoot)).not.toThrow();
    expect(() => validatePath('src/index.ts', testRoot)).not.toThrow();
    expect(() => validatePath('README.md', testRoot)).not.toThrow();
    expect(() => validatePath('tsconfig.json', testRoot)).not.toThrow();
  });
});

// ============================================================================
// Symlink Escape Tests (🔑 CRITICAL)
// ============================================================================

describe('Symlink Escape Prevention', () => {
  it('blocks symlink pointing to /etc', () => {
    // /etc doesn't exist on Windows; the test is only meaningful on Unix.
    if (process.platform === 'win32') return;
    const linkPath = join(testRoot, 'etc-link');
    try {
      symlinkSync('/etc', linkPath);
    } catch {
      // Symlink creation may fail on some systems
      return;
    }

    expect(() => validatePath('etc-link', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('etc-link', testRoot)).toThrow('escape');
  });

  it('blocks symlink pointing to home directory', () => {
    const home = homedir();
    const linkPath = join(testRoot, 'home-link');
    try {
      symlinkSync(home, linkPath);
    } catch {
      return;
    }

    expect(() => validatePath('home-link', testRoot)).toThrow(SandboxError);
  });

  it('blocks symlink pointing to parent directory', () => {
    const linkPath = join(testRoot, 'parent-link');
    try {
      symlinkSync('..', linkPath);
    } catch {
      return;
    }

    expect(() => validatePath('parent-link', testRoot)).toThrow(SandboxError);
  });

  it('allows symlink within sandbox', () => {
    const linkPath = join(testRoot, 'src-link');
    try {
      symlinkSync('./src', linkPath);
    } catch {
      return;
    }

    expect(() => validatePath('src-link', testRoot)).not.toThrow();
  });

  it('blocks symlink to .ssh even if named innocently', () => {
    const home = homedir();
    const sshPath = join(home, '.ssh');
    const linkPath = join(testRoot, 'innocent-link');
    try {
      symlinkSync(sshPath, linkPath);
    } catch {
      return;
    }

    expect(() => validatePath('innocent-link', testRoot)).toThrow(SandboxError);
  });
});

// ============================================================================
// Destination Validation Tests
// ============================================================================

describe('validateDestination', () => {
  it('validates destination for write operations', () => {
    const path = validateDestination('new-file.txt', testRoot);
    expect(path).toBe(join(testRoot, 'new-file.txt'));
  });

  it('validates nested destination', () => {
    const path = validateDestination('nested/new-file.txt', testRoot);
    expect(path).toBe(join(testRoot, 'nested', 'new-file.txt'));
  });

  it('blocks destination outside sandbox', () => {
    expect(() => validateDestination('../outside.txt', testRoot)).toThrow(SandboxError);
  });

  it('blocks sensitive destination', () => {
    expect(() => validateDestination('.env', testRoot)).toThrow(SandboxError);
  });
});

// ============================================================================
// Sandbox Class Tests
// ============================================================================

describe('Sandbox class', () => {
  it('creates sandbox with absolute root', () => {
    expect(sandbox.root).toBe(resolve(testRoot));
  });

  it('validateRead delegates to validatePath', () => {
    expect(sandbox.validateRead('file.txt')).toBe(join(testRoot, 'file.txt'));
    expect(() => sandbox.validateRead('../escape')).toThrow(SandboxError);
  });

  it('validateWrite delegates to validateDestination', () => {
    expect(sandbox.validateWrite('new.txt')).toBe(join(testRoot, 'new.txt'));
    expect(() => sandbox.validateWrite('.env')).toThrow(SandboxError);
  });

  it('relativePath returns path relative to root', () => {
    expect(sandbox.relativePath(join(testRoot, 'src', 'index.ts'))).toBe(join('src', 'index.ts'));
    expect(sandbox.relativePath(testRoot)).toBe('.');
  });

  it('isRoot checks if path is root', () => {
    expect(sandbox.isRoot(testRoot)).toBe(true);
    expect(sandbox.isRoot(join(testRoot, 'src'))).toBe(false);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('handles empty path as current directory', () => {
    // Empty string normalizes to '.'
    const result = validatePath('.', testRoot);
    expect(result).toBe(resolve(testRoot));
  });

  it('handles double slashes', () => {
    const result = validatePath('src//index.ts', testRoot);
    expect(result).toBe(join(testRoot, 'src', 'index.ts'));
  });

  it('handles trailing slashes', () => {
    const result = validatePath('src/', testRoot);
    expect(result).toBe(join(testRoot, 'src'));
  });

  it.skipIf(process.platform === 'win32')('handles case sensitivity (Unix)', () => {
    // On case-sensitive systems, .ENV is different from .env — only exact
    // matches are blocked, to avoid false positives on legit uppercase files.
    expect(() => validatePath('.ENV', testRoot)).not.toThrow();
    // But .env should still be blocked
    expect(() => validatePath('.env', testRoot)).toThrow(SandboxError);
  });

  it.runIf(process.platform === 'win32')('blocks the blacklist case-insensitively (Windows)', () => {
    // NTFS is case-insensitive: .ENV and .env are the same file, so both block.
    expect(() => validatePath('.ENV', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('.env', testRoot)).toThrow(SandboxError);
  });

  it('blocks Windows registry-hive paths (drive-agnostic suffix patterns)', () => {
    // The '**/system32/config/sam' pattern matches regardless of drive; verify
    // it works even when such a path sits inside the sandbox root. (Lowercase,
    // so it matches case-sensitively on Unix and case-folded on Windows.)
    mkdirSync(join(testRoot, 'system32', 'config'), { recursive: true });
    writeFileSync(join(testRoot, 'system32', 'config', 'sam'), 'hive');
    expect(() => validatePath('system32/config/sam', testRoot)).toThrow(SandboxError);
    expect(() => validatePath('system32/config/sam', testRoot)).toThrow('sensitive');
  });

  it('handles unicode filenames', () => {
    const unicodePath = '文件.txt';
    writeFileSync(join(testRoot, unicodePath), 'content');
    expect(() => validatePath(unicodePath, testRoot)).not.toThrow();
  });
});

// ============================================================================
// Comprehensive Blacklist Tests
// ============================================================================

describe('Blacklist Comprehensive', () => {
  const sensitiveFiles = [
    '.ssh/id_rsa',
    '.ssh/id_ed25519',
    '.ssh/config',
    '.aws/credentials',
    '.aws/config',
    '.gnupg/secring.gpg',
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    'config/.env',
    'secrets.json',
    'my_secrets.yaml',
    'private.pem',
    'cert.key',
    'id_rsa',
    'github_token',
    'api_key.json',
    'access_token',
    'credentials.json',
    'aws_credentials',
  ];

  for (const file of sensitiveFiles) {
    it(`blocks ${file}`, () => {
      expect(() => validatePath(file, testRoot)).toThrow(SandboxError);
    });
  }

  const safeFiles = [
    'src/index.ts',
    'package.json',
    'README.md',
    'tsconfig.json',
    'vite.config.ts',
    'test/app.test.ts',
    'public/index.html',
    'assets/logo.png',
    '.gitignore',
    '.prettierrc',
    'Makefile',
    'Dockerfile',
  ];

  for (const file of safeFiles) {
    it(`allows ${file}`, () => {
      expect(() => validatePath(file, testRoot)).not.toThrow();
    });
  }
});
