// Files channel (DESIGN §4.3 / Phase 2.2).
// Handles file system RPC for the Files Tab.

import type { FilesInput, FilesOutput, Envelope } from '@bedcoder/protocol';
import type { Session } from '../session';
import { log } from '../log';
import { processFilesRequest } from '../files';

// The transport subset the files channel needs (RelayClient satisfies it).
export interface FilesTransport {
  sendRaw(raw: Uint8Array): void;
  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void;
}

export interface FilesChannelOptions {
  // The project root directory (all file operations are relative to this)
  root: string;
}

/**
 * FilesChannel manages file system RPC for the Files Tab.
 * All operations are sandboxed to the project root.
 */
export class FilesChannel {
  private readonly root: string;

  constructor(
    private readonly session: Session,
    private readonly transport: FilesTransport,
    options: FilesChannelOptions,
  ) {
    this.root = options.root;
  }

  /**
   * Start the files channel.
   * Begins listening for files messages.
   */
  start(): void {
    this.transport.onEnvelope((raw, env) => {
      if (env.ch !== 'files') return;
      const { payload } = this.session.decode<FilesInput>(raw);
      log('files:recv', { type: payload.type, id: payload.id });
      this.handleInput(payload);
    });
  }

  /**
   * Handle incoming files messages from the app.
   */
  private handleInput(input: FilesInput): void {
    // Process the file operation (all sandboxed to root)
    const result = processFilesRequest(this.root, input);
    this.emit(result);
  }

  /**
   * Send a files output message to the app.
   */
  private emit(output: FilesOutput): void {
    log('files:emit', { type: output.type, id: output.id });
    this.transport.sendRaw(this.session.encode('files', output));
  }
}
