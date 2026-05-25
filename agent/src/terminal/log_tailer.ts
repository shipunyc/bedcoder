// Log tailer (Phase 2.3). For background (`run_in_background`) tasks the SDK
// writes the command's combined output to a file and tells us the path in the
// initial Bash result ("Output is being written to: <path>"). The agent runs on
// the same host, so we tail that file directly — giving the phone the real,
// live dev-server output instead of only what Claude happens to poll via
// BashOutput.

import { openSync, readSync, closeSync, fstatSync, existsSync } from 'node:fs';

const POLL_MS = 300;

export interface Tailer {
  start(id: string, path: string): void;
  stop(id: string): void;
  dispose(): void;
}

export class LogTailer implements Tailer {
  private readonly paths = new Map<string, string>();
  private readonly offsets = new Map<string, number>(); // bytes already read
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly intervalMs = POLL_MS,
  ) {}

  /** Begin tailing `path`, forwarding new bytes to onData(id, ...). */
  start(id: string, path: string): void {
    this.paths.set(id, path);
    this.offsets.set(id, 0);
    this.timer ??= setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop tailing id (flushes any final bytes first). */
  stop(id: string): void {
    this.drain(id);
    this.paths.delete(id);
    this.offsets.delete(id);
    if (this.paths.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.paths.clear();
    this.offsets.clear();
  }

  private poll(): void {
    for (const id of this.paths.keys()) this.drain(id);
  }

  // Read any bytes appended since last time and forward them.
  private drain(id: string): void {
    const path = this.paths.get(id);
    if (!path || !existsSync(path)) return;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const offset = this.offsets.get(id) ?? 0;
      if (size <= offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      this.offsets.set(id, size);
      this.onData(id, buf.toString('utf-8'));
    } finally {
      closeSync(fd);
    }
  }
}
