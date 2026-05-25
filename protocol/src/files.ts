import { z } from 'zod';

// Files channel payloads (DESIGN §4.3). These enable file system operations
// for the Files Tab, allowing mobile app to browse and edit project files.

// ============================================================================
// File Entry (directory listing item)
// ============================================================================

export const fileTypeSchema = z.enum(['file', 'dir', 'symlink']);
export type FileType = z.infer<typeof fileTypeSchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  type: fileTypeSchema,
  size: z.number().int().nonnegative(), // bytes (0 for directories)
  mtime: z.number().int(), // Unix timestamp in seconds
  mode: z.number().int().optional(), // Unix permissions (e.g., 0o644)
  target: z.string().optional(), // Symlink target (only for symlinks)
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

// ============================================================================
// File Operations
// ============================================================================

export const fileOperationSchema = z.enum([
  'ls', // List directory contents
  'read', // Read file contents
  'write', // Write file contents
  'mkdir', // Create directory
  'rm', // Remove file or directory
  'mv', // Move/rename file or directory
  'stat', // Get file metadata
  'search', // Search for files by name pattern
]);
export type FileOperation = z.infer<typeof fileOperationSchema>;

// ============================================================================
// Files Channel Messages
// ============================================================================

// App → Agent: File system RPC requests.
export const filesInputSchema = z.discriminatedUnion('type', [
  // List directory contents.
  z.object({
    type: z.literal('ls'),
    id: z.string(),
    path: z.string(), // Relative to project root
    showHidden: z.boolean().optional(), // Include dotfiles (default: false)
  }),
  // Read file contents.
  z.object({
    type: z.literal('read'),
    id: z.string(),
    path: z.string(),
    // For large files, support range reads
    offset: z.number().int().nonnegative().optional(), // Start byte offset
    limit: z.number().int().positive().optional(), // Max bytes to read
  }),
  // Write file contents.
  z.object({
    type: z.literal('write'),
    id: z.string(),
    path: z.string(),
    contentBase64: z.string(), // Content as base64
    createDirs: z.boolean().optional(), // Create parent directories if needed
  }),
  // Create directory.
  z.object({
    type: z.literal('mkdir'),
    id: z.string(),
    path: z.string(),
    recursive: z.boolean().optional(), // Create parent directories (default: false)
  }),
  // Remove file or directory.
  z.object({
    type: z.literal('rm'),
    id: z.string(),
    path: z.string(),
    recursive: z.boolean().optional(), // Remove directory contents (required for non-empty dirs)
  }),
  // Move/rename file or directory.
  z.object({
    type: z.literal('mv'),
    id: z.string(),
    src: z.string(),
    dst: z.string(),
    overwrite: z.boolean().optional(), // Overwrite if destination exists (default: false)
  }),
  // Get file metadata.
  z.object({
    type: z.literal('stat'),
    id: z.string(),
    path: z.string(),
    followSymlinks: z.boolean().optional(), // Follow symlinks (default: true)
  }),
  // Search for files by name pattern.
  z.object({
    type: z.literal('search'),
    id: z.string(),
    pattern: z.string(), // Glob pattern (e.g., "*.ts", "**/*.test.ts")
    path: z.string().optional(), // Start directory (default: project root)
    maxResults: z.number().int().positive().optional(), // Limit results (default: 100)
  }),
]);
export type FilesInput = z.infer<typeof filesInputSchema>;

// Agent → App: File system RPC responses.
export const filesOutputSchema = z.discriminatedUnion('type', [
  // Success response for ls.
  z.object({
    type: z.literal('ls_result'),
    id: z.string(),
    path: z.string(), // Normalized path
    entries: z.array(fileEntrySchema),
  }),
  // Success response for read.
  z.object({
    type: z.literal('read_result'),
    id: z.string(),
    path: z.string(),
    contentBase64: z.string(),
    size: z.number().int().nonnegative(), // Total file size
    truncated: z.boolean().optional(), // True if content was truncated
  }),
  // Success response for write/mkdir/rm/mv.
  z.object({
    type: z.literal('ok'),
    id: z.string(),
    message: z.string().optional(),
  }),
  // Success response for stat.
  z.object({
    type: z.literal('stat_result'),
    id: z.string(),
    path: z.string(),
    entry: fileEntrySchema,
  }),
  // Success response for search.
  z.object({
    type: z.literal('search_result'),
    id: z.string(),
    pattern: z.string(),
    matches: z.array(z.string()), // List of matching paths
    truncated: z.boolean().optional(), // True if results were limited
  }),
  // Error response for any operation.
  z.object({
    type: z.literal('error'),
    id: z.string(),
    code: z.enum([
      'not_found', // File or directory not found
      'permission_denied', // Access denied (sandbox violation)
      'already_exists', // File/directory already exists
      'not_empty', // Directory not empty (rm without recursive)
      'not_a_directory', // Expected directory, got file
      'not_a_file', // Expected file, got directory
      'too_large', // File too large to read
      'invalid_path', // Invalid or malformed path
      'io_error', // Generic I/O error
    ]),
    message: z.string(),
  }),
]);
export type FilesOutput = z.infer<typeof filesOutputSchema>;

// ============================================================================
// Parser Functions
// ============================================================================

export const parseFilesInput = (u: unknown): FilesInput => filesInputSchema.parse(u);
export const parseFilesOutput = (u: unknown): FilesOutput => filesOutputSchema.parse(u);
