// File system operations (DESIGN §4.3 / Phase 2.2.2).
// Implements file system RPC for the Files Tab.

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  rmSync,
  renameSync,
  readlinkSync,
  existsSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import type { FilesInput, FilesOutput, FileEntry, FileType } from '@bedcoder/protocol';
import { Sandbox, SandboxError } from './sandbox';

// The `code` of the FilesOutput error variant (all the valid error codes).
type FilesErrorCode = Extract<FilesOutput, { type: 'error' }>['code'];

// ============================================================================
// Configuration
// ============================================================================

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB max read size
const MAX_SEARCH_RESULTS = 100;

// ============================================================================
// Helper Functions
// ============================================================================

function statToEntry(name: string, absPath: string, followSymlinks: boolean): FileEntry {
  const stat = followSymlinks ? statSync(absPath) : lstatSync(absPath);
  const lstat = lstatSync(absPath);

  let type: FileType = 'file';
  if (lstat.isSymbolicLink()) {
    type = 'symlink';
  } else if (stat.isDirectory()) {
    type = 'dir';
  }

  const entry: FileEntry = {
    name,
    type,
    size: stat.isDirectory() ? 0 : stat.size,
    mtime: Math.floor(stat.mtimeMs / 1000),
    mode: stat.mode,
  };

  // Add symlink target if applicable
  if (type === 'symlink') {
    try {
      entry.target = readlinkSync(absPath);
    } catch {
      // Ignore if we can't read the target
    }
  }

  return entry;
}

function sandboxErrorToOutput(id: string, err: SandboxError): FilesOutput {
  let code: FilesErrorCode;

  switch (err.code) {
    case 'path_traversal':
    case 'symlink_escape':
      code = 'invalid_path';
      break;
    case 'blacklisted':
      code = 'permission_denied';
      break;
    default:
      code = 'invalid_path';
  }

  return {
    type: 'error',
    id,
    code,
    message: err.message,
  };
}

function nodeErrorToOutput(id: string, err: NodeJS.ErrnoException): FilesOutput {
  let code: 'not_found' | 'permission_denied' | 'already_exists' | 'not_empty' | 'not_a_directory' | 'not_a_file' | 'io_error';

  switch (err.code) {
    case 'ENOENT':
      code = 'not_found';
      break;
    case 'EACCES':
    case 'EPERM':
      code = 'permission_denied';
      break;
    case 'EEXIST':
      code = 'already_exists';
      break;
    case 'ENOTEMPTY':
      code = 'not_empty';
      break;
    case 'ENOTDIR':
      code = 'not_a_directory';
      break;
    case 'EISDIR':
      code = 'not_a_file';
      break;
    default:
      code = 'io_error';
  }

  return {
    type: 'error',
    id,
    code,
    message: err.message,
  };
}

// ============================================================================
// File Operations
// ============================================================================

function doLs(sandbox: Sandbox, input: Extract<FilesInput, { type: 'ls' }>): FilesOutput {
  try {
    const absPath = sandbox.validateRead(input.path);

    // Check if it's a directory
    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      return {
        type: 'error',
        id: input.id,
        code: 'not_a_directory',
        message: `Not a directory: ${input.path}`,
      };
    }

    // Read directory contents
    const names = readdirSync(absPath);
    const entries: FileEntry[] = [];

    for (const name of names) {
      // Skip hidden files unless requested
      if (!input.showHidden && name.startsWith('.')) continue;

      try {
        const entryPath = join(absPath, name);
        // Validate each entry (may throw for sensitive files)
        try {
          sandbox.validateRead(join(input.path, name));
        } catch {
          // Skip files that fail validation (sensitive files)
          continue;
        }

        const entry = statToEntry(name, entryPath, true);
        entries.push(entry);
      } catch {
        // Skip entries we can't stat
      }
    }

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      type: 'ls_result',
      id: input.id,
      path: sandbox.relativePath(absPath),
      entries,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doRead(sandbox: Sandbox, input: Extract<FilesInput, { type: 'read' }>): FilesOutput {
  try {
    const absPath = sandbox.validateRead(input.path);

    // Check if it's a file
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      return {
        type: 'error',
        id: input.id,
        code: 'not_a_file',
        message: `Not a file: ${input.path}`,
      };
    }

    // Check file size
    const size = stat.size;
    const offset = input.offset ?? 0;
    const limit = input.limit ?? MAX_FILE_SIZE;

    if (size > MAX_FILE_SIZE && !input.limit) {
      return {
        type: 'error',
        id: input.id,
        code: 'too_large',
        message: `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
      };
    }

    // Read file content
    const buffer = readFileSync(absPath);
    const slice = buffer.slice(offset, offset + limit);
    const truncated = offset + limit < size;

    return {
      type: 'read_result',
      id: input.id,
      path: sandbox.relativePath(absPath),
      contentBase64: slice.toString('base64'),
      size,
      truncated,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doWrite(sandbox: Sandbox, input: Extract<FilesInput, { type: 'write' }>): FilesOutput {
  try {
    const absPath = sandbox.validateWrite(input.path);

    // Create parent directories if requested
    if (input.createDirs) {
      const parentDir = dirname(absPath);
      mkdirSync(parentDir, { recursive: true });
    }

    // Decode and write content
    const content = Buffer.from(input.contentBase64, 'base64');
    writeFileSync(absPath, content);

    return {
      type: 'ok',
      id: input.id,
      message: `Wrote ${content.length} bytes to ${sandbox.relativePath(absPath)}`,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doMkdir(sandbox: Sandbox, input: Extract<FilesInput, { type: 'mkdir' }>): FilesOutput {
  try {
    const absPath = sandbox.validateWrite(input.path);

    mkdirSync(absPath, { recursive: input.recursive ?? false });

    return {
      type: 'ok',
      id: input.id,
      message: `Created directory: ${sandbox.relativePath(absPath)}`,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doRm(sandbox: Sandbox, input: Extract<FilesInput, { type: 'rm' }>): FilesOutput {
  try {
    // Don't allow deleting the root (check before validation to give proper error)
    if (input.path === '.' || input.path === '' || input.path === '/') {
      return {
        type: 'error',
        id: input.id,
        code: 'permission_denied',
        message: 'Cannot delete project root',
      };
    }

    const absPath = sandbox.validateWrite(input.path);

    // Double-check root protection
    if (sandbox.isRoot(absPath)) {
      return {
        type: 'error',
        id: input.id,
        code: 'permission_denied',
        message: 'Cannot delete project root',
      };
    }

    // Check if path exists
    if (!existsSync(absPath)) {
      return {
        type: 'error',
        id: input.id,
        code: 'not_found',
        message: `Path not found: ${input.path}`,
      };
    }

    // Check if directory and non-empty (for better error message)
    const stat = lstatSync(absPath);
    const isDir = stat.isDirectory();

    if (isDir && !input.recursive) {
      try {
        const contents = readdirSync(absPath);
        if (contents.length > 0) {
          return {
            type: 'error',
            id: input.id,
            code: 'not_empty',
            message: `Directory not empty: ${input.path}`,
          };
        }
      } catch {
        // Ignore readdir errors
      }
    }

    // For directories (even empty ones), rmSync needs recursive or we use rmdirSync
    // Using recursive: true with force: true handles both empty and non-empty cases
    rmSync(absPath, { recursive: isDir || (input.recursive ?? false), force: true });

    return {
      type: 'ok',
      id: input.id,
      message: `Removed: ${sandbox.relativePath(absPath)}`,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    const nodeErr = err as NodeJS.ErrnoException;
    // Map ENOTEMPTY to not_empty
    if (nodeErr.code === 'ENOTEMPTY' || nodeErr.message?.includes('not empty')) {
      return {
        type: 'error',
        id: input.id,
        code: 'not_empty',
        message: `Directory not empty: ${input.path}`,
      };
    }
    return nodeErrorToOutput(input.id, nodeErr);
  }
}

function doMv(sandbox: Sandbox, input: Extract<FilesInput, { type: 'mv' }>): FilesOutput {
  try {
    const srcPath = sandbox.validateRead(input.src);
    const dstPath = sandbox.validateWrite(input.dst);

    // Check if destination exists
    if (!input.overwrite && existsSync(dstPath)) {
      return {
        type: 'error',
        id: input.id,
        code: 'already_exists',
        message: `Destination already exists: ${input.dst}`,
      };
    }

    renameSync(srcPath, dstPath);

    return {
      type: 'ok',
      id: input.id,
      message: `Moved ${sandbox.relativePath(srcPath)} to ${sandbox.relativePath(dstPath)}`,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doStat(sandbox: Sandbox, input: Extract<FilesInput, { type: 'stat' }>): FilesOutput {
  try {
    const absPath = sandbox.validateRead(input.path);
    const followSymlinks = input.followSymlinks ?? true;

    const entry = statToEntry(basename(absPath), absPath, followSymlinks);

    return {
      type: 'stat_result',
      id: input.id,
      path: sandbox.relativePath(absPath),
      entry,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

function doSearch(sandbox: Sandbox, input: Extract<FilesInput, { type: 'search' }>): FilesOutput {
  try {
    const startPath = input.path ? sandbox.validateRead(input.path) : sandbox.root;
    const maxResults = input.maxResults ?? MAX_SEARCH_RESULTS;
    const pattern = input.pattern;

    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
      .replace(/\*\*/g, '{{DOUBLESTAR}}') // Placeholder for **
      .replace(/\*/g, '[^/]*') // * matches anything except /
      .replace(/\?/g, '.') // ? matches single char
      .replace(/{{DOUBLESTAR}}/g, '.*'); // ** matches anything

    const regex = new RegExp(`^${regexPattern}$`, 'i');

    const matches: string[] = [];
    const stack: string[] = [startPath];

    while (stack.length > 0 && matches.length < maxResults) {
      const dir = stack.pop()!;

      try {
        const names = readdirSync(dir);

        for (const name of names) {
          // Skip hidden files
          if (name.startsWith('.')) continue;

          const fullPath = join(dir, name);
          const relPath = sandbox.relativePath(fullPath);

          // Check if file matches pattern. Normalize separators to '/' so the
          // '*' -> [^/]* rule still stops at directory boundaries on Windows.
          if (regex.test(name) || regex.test(relPath.replace(/\\/g, '/'))) {
            try {
              sandbox.validateRead(relPath);
              matches.push(relPath);
              if (matches.length >= maxResults) break;
            } catch {
              // Skip files that fail validation
            }
          }

          // Recurse into directories
          try {
            const stat = lstatSync(fullPath);
            if (stat.isDirectory()) {
              stack.push(fullPath);
            }
          } catch {
            // Skip directories we can't stat
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    return {
      type: 'search_result',
      id: input.id,
      pattern: input.pattern,
      matches,
      truncated: matches.length >= maxResults,
    };
  } catch (err) {
    if (err instanceof SandboxError) {
      return sandboxErrorToOutput(input.id, err);
    }
    return nodeErrorToOutput(input.id, err as NodeJS.ErrnoException);
  }
}

// ============================================================================
// Main Processor
// ============================================================================

/**
 * Process a file system RPC request.
 */
export function processFilesRequest(root: string, input: FilesInput): FilesOutput {
  const sandbox = new Sandbox(root);

  switch (input.type) {
    case 'ls':
      return doLs(sandbox, input);
    case 'read':
      return doRead(sandbox, input);
    case 'write':
      return doWrite(sandbox, input);
    case 'mkdir':
      return doMkdir(sandbox, input);
    case 'rm':
      return doRm(sandbox, input);
    case 'mv':
      return doMv(sandbox, input);
    case 'stat':
      return doStat(sandbox, input);
    case 'search':
      return doSearch(sandbox, input);
    default:
      return {
        type: 'error',
        id: (input as FilesInput).id ?? 'unknown',
        code: 'io_error',
        message: `Unknown operation: ${(input as FilesInput).type}`,
      };
  }
}
