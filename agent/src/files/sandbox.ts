// Security sandbox for file system access (DESIGN §4.3 / Phase 2.2.3).
// 🔑 SECURITY CRITICAL: This module enforces access control for all file operations.
// All paths must pass through validatePath() before any I/O.

import { resolve, normalize, relative, dirname, basename, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';

// NTFS is case-insensitive, so on Windows we match the blacklist case-folded.
const IS_WINDOWS = process.platform === 'win32';

// Normalize a path for matching: '\' -> '/' (so the '/'-based patterns and the
// separator checks work on Windows) and, on case-insensitive Windows, lowercased.
// On Unix this is a no-op for real paths (they contain no '\').
function normalizeForMatch(p: string): string {
  const s = p.replace(/\\/g, '/');
  return IS_WINDOWS ? s.toLowerCase() : s;
}

// True if a path *relative to the sandbox root* escapes it: a '..' prefix, or an
// absolute path (incl. a different Windows drive, where relative() returns an
// absolute path that startsWith('/') would miss). isAbsolute('/x') === the old
// startsWith('/') on Unix, so this doesn't change Unix behavior.
function escapesRoot(rel: string): boolean {
  return rel.startsWith('..') || isAbsolute(rel);
}

// ============================================================================
// Configuration
// ============================================================================

// Sensitive paths that should NEVER be accessible (relative to home or absolute)
const BLACKLIST_PATTERNS = [
  // SSH keys
  '.ssh',
  '.ssh/**',
  // AWS credentials
  '.aws',
  '.aws/**',
  // GPG keys
  '.gnupg',
  '.gnupg/**',
  // Environment files
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  // Credential files
  '**/credentials',
  '**/credentials.*',
  '**/*credentials*',
  '**/secrets',
  '**/secrets.*',
  '**/*secret*',
  // Private keys
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_rsa.*',
  '**/id_ed25519',
  '**/id_ed25519.*',
  '**/id_ecdsa',
  '**/id_ecdsa.*',
  // System files (Unix)
  '/etc/passwd',
  '/etc/shadow',
  '/etc/sudoers',
  '/etc/sudoers.d/**',
  // System files (Windows) — registry hives. Drive-agnostic suffix patterns,
  // lowercase to match case-folded Windows candidates (see normalizeForMatch).
  '**/system32/config/sam',
  '**/system32/config/security',
  '**/system32/config/system',
  '**/system32/config/software',
  '**/ntuser.dat',
  // macOS keychain
  '**/*.keychain',
  '**/*.keychain-db',
  // Token files
  '**/*token*',
  '**/*api_key*',
  '**/*apikey*',
];

// File extensions that are always blocked
const BLOCKED_EXTENSIONS = new Set(['.pem', '.key', '.keychain', '.keychain-db']);

// ============================================================================
// Sandbox Error Types
// ============================================================================

export type SandboxErrorCode =
  | 'path_traversal' // Path escapes sandbox root
  | 'blacklisted' // Path matches blacklist
  | 'symlink_escape' // Symlink target escapes sandbox
  | 'invalid_path'; // Malformed path

export class SandboxError extends Error {
  constructor(
    public readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Check if a filename matches a glob pattern (simplified).
 */
function matchesPattern(filename: string, pattern: string): boolean {
  // Handle ** (any path)
  if (pattern === '**') return true;

  // Handle exact match
  if (pattern === filename) return true;

  // Handle **/name pattern (matches anywhere)
  if (pattern.startsWith('**/')) {
    const suffix = pattern.slice(3);
    if (filename.endsWith(suffix)) return true;
    if (filename.includes('/' + suffix)) return true;
    if (matchesPattern(filename, suffix)) return true;
  }

  // Handle name/** pattern (matches directory and contents)
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (filename === prefix || filename.startsWith(prefix + '/')) return true;
  }

  // Handle *.ext pattern
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    if (filename.endsWith(ext)) return true;
  }

  // Handle name.* pattern
  if (pattern.endsWith('.*')) {
    const base = pattern.slice(0, -2);
    if (filename === base || filename.startsWith(base + '.')) return true;
  }

  // Handle *name* pattern
  if (pattern.startsWith('*') && pattern.endsWith('*')) {
    const inner = pattern.slice(1, -1);
    if (filename.includes(inner)) return true;
  }

  return false;
}

/**
 * Check if a path matches any blacklist pattern.
 */
function isBlacklisted(relativePath: string, homeDir: string): boolean {
  // Normalize separators (and case on Windows) so the '/'-based, lowercase
  // patterns match regardless of OS.
  const filename = normalizeForMatch(basename(relativePath));
  const relPath = normalizeForMatch(relativePath);
  const pathFromHome = normalizeForMatch(relative(homeDir, resolve(homeDir, relativePath)));

  for (const pattern of BLACKLIST_PATTERNS) {
    // Check against the full relative path
    if (matchesPattern(relPath, pattern)) return true;
    // Check against the filename only
    if (matchesPattern(filename, pattern)) return true;
    // Check against path from home directory
    if (matchesPattern(pathFromHome, pattern)) return true;
  }

  // Check blocked extensions
  const ext = filename.slice(filename.lastIndexOf('.'));
  if (BLOCKED_EXTENSIONS.has(ext.toLowerCase())) return true;

  return false;
}


/**
 * Validate a path against sandbox rules.
 * @param inputPath The path to validate (relative to root, or absolute)
 * @param root The sandbox root directory (project root)
 * @returns The normalized absolute path if valid
 * @throws SandboxError if validation fails
 */
export function validatePath(inputPath: string, root: string): string {
  const homeDir = homedir();
  const absRoot = resolve(root);

  // 1. Normalize the path (remove ., .., etc.)
  const normalized = normalize(inputPath);

  // 2. Check for invalid path characters
  if (inputPath.includes('\0')) {
    throw new SandboxError('invalid_path', 'Path contains null bytes');
  }

  // 3. Resolve to absolute path. isAbsolute handles Unix '/', Windows 'C:\' and
  // UNC '\\server' — startsWith('/') missed the Windows forms.
  let absPath: string;
  if (isAbsolute(inputPath)) {
    // Absolute path - must be within root
    absPath = resolve(normalized);
  } else {
    // Relative path - resolve against root
    absPath = resolve(absRoot, normalized);
  }

  // 4. Check for path traversal
  const rel = relative(absRoot, absPath);
  if (escapesRoot(rel)) {
    throw new SandboxError(
      'path_traversal',
      `Path escapes sandbox: ${inputPath} resolves to ${absPath}`,
    );
  }

  // 5. Check blacklist
  const relPath = relative(absRoot, absPath) || '.';
  if (isBlacklisted(relPath, homeDir)) {
    throw new SandboxError('blacklisted', `Access denied to sensitive path: ${inputPath}`);
  }
  if (isBlacklisted(absPath, homeDir)) {
    throw new SandboxError('blacklisted', `Access denied to sensitive path: ${inputPath}`);
  }

  // 6. Resolve the real path and re-check containment. A symlink *or* an NTFS
  // junction inside the sandbox can still point outside it — and junctions are
  // NOT reported by isSymbolicLink(), so we always resolve, not just for
  // symlinks. (realpath also collapses macOS /var -> /private/var; we resolve
  // root too so an in-sandbox file still compares clean.)
  try {
    const realPath = realpathSync(absPath); // throws ENOENT if not created yet
    const realRoot = realpathSync(absRoot);
    const realRel = relative(realRoot, realPath);

    if (escapesRoot(realRel)) {
      throw new SandboxError(
        'symlink_escape',
        `Path escapes sandbox once resolved: ${inputPath} -> ${realPath}`,
      );
    }

    if (isBlacklisted(realRel || '.', homeDir) || isBlacklisted(realPath, homeDir)) {
      throw new SandboxError(
        'blacklisted',
        `Path resolves to a sensitive location: ${inputPath} -> ${realPath}`,
      );
    }
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    // ENOENT just means the path doesn't exist yet (fine for write ops); other
    // stat errors shouldn't fail the whole validation.
  }

  return absPath;
}

/**
 * Validate a destination path for write/move operations.
 * Additionally checks if parent directory is within sandbox.
 */
export function validateDestination(inputPath: string, root: string): string {
  // First validate the path itself
  const absPath = validatePath(inputPath, root);

  // Also validate the parent directory (for creating new files)
  const parentDir = dirname(absPath);
  const absRoot = resolve(root);
  const parentRel = relative(absRoot, parentDir);

  if (escapesRoot(parentRel)) {
    throw new SandboxError(
      'path_traversal',
      `Parent directory escapes sandbox: ${inputPath}`,
    );
  }

  return absPath;
}

// ============================================================================
// Sandbox Class
// ============================================================================

/**
 * Sandbox provides a secure interface for file system operations.
 * All operations are constrained to the root directory.
 */
export class Sandbox {
  constructor(public readonly root: string) {
    this.root = resolve(root);
  }

  /**
   * Validate a path for read operations.
   */
  validateRead(path: string): string {
    return validatePath(path, this.root);
  }

  /**
   * Validate a path for write operations.
   */
  validateWrite(path: string): string {
    return validateDestination(path, this.root);
  }

  /**
   * Get the relative path from root.
   */
  relativePath(absPath: string): string {
    return relative(this.root, absPath) || '.';
  }

  /**
   * Check if a path is the root directory.
   */
  isRoot(absPath: string): boolean {
    return resolve(absPath) === this.root;
  }
}
