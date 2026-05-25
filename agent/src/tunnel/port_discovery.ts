// Port discovery module (DESIGN §4.3 / Phase 2.1.2).
// Discovers listening TCP ports on the local machine for the Preview Tab.
// Supports Linux (/proc/net/tcp) and macOS (lsof fallback).

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { ListeningPort } from '@bedcoder/protocol';

// ============================================================================
// Linux: Parse /proc/net/tcp
// ============================================================================

// /proc/net/tcp format (man 5 proc):
// sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
// 0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345
//
// local_address is hex IP:PORT. st=0A means LISTEN.
// inode can be mapped to /proc/{pid}/fd/* to find the process.

interface ProcNetEntry {
  port: number;
  inode: number;
}

function parseProcNetTcp(content: string): ProcNetEntry[] {
  const lines = content.trim().split('\n').slice(1); // skip header
  const entries: ProcNetEntry[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;

    const localAddr = parts[1];
    const state = parts[3];

    // Only LISTEN state (0A)
    if (!localAddr || state !== '0A') continue;

    // Parse port from hex (e.g., "0100007F:1F90" -> port 8080)
    const [, portHex] = localAddr.split(':');
    if (!portHex) continue;

    const port = parseInt(portHex, 16);
    if (isNaN(port) || port <= 0) continue;

    // inode is the 10th field (0-indexed: 9)
    const inode = parseInt(parts[9] ?? '', 10);

    entries.push({ port, inode: isNaN(inode) ? 0 : inode });
  }

  return entries;
}

// Map inode -> pid by scanning /proc/*/fd/*
function mapInodesToPids(): Map<number, number> {
  const map = new Map<number, number>();

  try {
    const procDirs = execSync('ls -d /proc/[0-9]* 2>/dev/null', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const procDir of procDirs) {
      const pid = parseInt(procDir.replace('/proc/', ''), 10);
      if (isNaN(pid)) continue;

      try {
        const fdDir = `${procDir}/fd`;
        const fds = execSync(`ls -l ${fdDir} 2>/dev/null`, { encoding: 'utf-8' });
        const matches = fds.matchAll(/socket:\[(\d+)\]/g);
        for (const match of matches) {
          const inode = parseInt(match[1] ?? '', 10);
          if (!isNaN(inode)) {
            map.set(inode, pid);
          }
        }
      } catch {
        // Permission denied or process exited
      }
    }
  } catch {
    // /proc not available or ls failed
  }

  return map;
}

// Get process name from /proc/{pid}/comm
function getProcessName(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

// Get command line from /proc/{pid}/cmdline
function getProcessCmdline(pid: number): string | undefined {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8')
      .replace(/\0/g, ' ')
      .trim();
    // Truncate long command lines
    return cmdline.length > 100 ? cmdline.slice(0, 97) + '...' : cmdline;
  } catch {
    return undefined;
  }
}

function discoverLinux(): ListeningPort[] {
  const procNetTcp = '/proc/net/tcp';
  const procNetTcp6 = '/proc/net/tcp6';

  let content = '';
  if (existsSync(procNetTcp)) {
    content += readFileSync(procNetTcp, 'utf-8');
  }
  if (existsSync(procNetTcp6)) {
    content += readFileSync(procNetTcp6, 'utf-8');
  }

  if (!content) return [];

  const entries = parseProcNetTcp(content);
  const inodeToPid = mapInodesToPids();

  // Deduplicate ports (tcp and tcp6 may have same port)
  const portMap = new Map<number, ListeningPort>();

  for (const entry of entries) {
    if (portMap.has(entry.port)) continue;

    const port: ListeningPort = { port: entry.port };
    const pid = inodeToPid.get(entry.inode);

    if (pid) {
      port.pid = pid;
      port.process = getProcessName(pid);
      port.cmdline = getProcessCmdline(pid);
    }

    portMap.set(entry.port, port);
  }

  return Array.from(portMap.values()).sort((a, b) => a.port - b.port);
}

// ============================================================================
// macOS: Parse lsof output
// ============================================================================

// lsof -iTCP -sTCP:LISTEN -nP output (note the trailing "(LISTEN)"):
// COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
// node    12345  user   21u  IPv6 0x1234      0t0  TCP 127.0.0.1:5173 (LISTEN)

// Parse `lsof -sTCP:LISTEN` output into listening ports. Pure, so it's tested.
export function parseLsofListen(output: string): ListeningPort[] {
  const lines = output.trim().split('\n').slice(1); // skip header
  const portMap = new Map<number, ListeningPort>();

  for (const line of lines) {
    // The address (127.0.0.1:5173 / [::1]:6379 / *:3000) precedes "(LISTEN)";
    // the previous code wrongly read the last token, which is "(LISTEN)".
    const portMatch = line.match(/:(\d+)\s*\(LISTEN\)\s*$/);
    if (!portMatch?.[1]) continue;
    const port = parseInt(portMatch[1], 10);
    if (isNaN(port) || port <= 0 || portMap.has(port)) continue;

    const parts = line.trim().split(/\s+/);
    const command = parts[0];
    const pid = parseInt(parts[1] ?? '', 10);

    portMap.set(port, {
      port,
      pid: isNaN(pid) ? undefined : pid,
      process: command || undefined,
    });
  }

  return Array.from(portMap.values()).sort((a, b) => a.port - b.port);
}

function discoverMacOS(): ListeningPort[] {
  try {
    return parseLsofListen(execSync('lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null', { encoding: 'utf-8' }));
  } catch {
    return [];
  }
}

// ============================================================================
// Windows: Parse `netstat -ano` output
// ============================================================================

// `netstat -ano` lines for listeners (proto, local, foreign, state, pid):
//   TCP    127.0.0.1:5173     0.0.0.0:0     LISTENING     12345
//   TCP    [::1]:6379         [::]:0        LISTENING     753
// We keep only TCP + LISTENING, take the port from the local address (the digits
// after the last ':'), and the PID from the final column. netstat doesn't give a
// process name (that needs a tasklist join), so `process` is left undefined.
// Pure, so it's unit-tested without a Windows host.
export function parseNetstatListen(output: string): ListeningPort[] {
  const portMap = new Map<number, ListeningPort>();

  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    // [proto, local, foreign, state, pid]
    if (parts.length < 5) continue;
    if (parts[0] !== 'TCP') continue;
    if (parts[3] !== 'LISTENING') continue;

    const local = parts[1] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const port = parseInt(local.slice(colon + 1), 10);
    if (isNaN(port) || port <= 0 || portMap.has(port)) continue;

    const pid = parseInt(parts[4] ?? '', 10);
    portMap.set(port, { port, pid: isNaN(pid) ? undefined : pid });
  }

  return Array.from(portMap.values()).sort((a, b) => a.port - b.port);
}

function discoverWindows(): ListeningPort[] {
  try {
    return parseNetstatListen(execSync('netstat -ano -p TCP', { encoding: 'utf-8' }));
  } catch {
    return [];
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover all listening TCP ports on the local machine.
 * Uses /proc/net/tcp on Linux, lsof on macOS.
 */
export function discoverPorts(): ListeningPort[] {
  if (process.platform === 'linux') {
    return discoverLinux();
  }
  if (process.platform === 'darwin') {
    return discoverMacOS();
  }
  if (process.platform === 'win32') {
    return discoverWindows();
  }
  // Unsupported platform
  return [];
}

/**
 * Filter ports to common development server ranges.
 * Excludes system ports (<1024) and uncommon high ports.
 */
export function filterDevPorts(ports: ListeningPort[]): ListeningPort[] {
  // Common dev server ports: 3000-9999, and some specific ones
  const commonPorts = new Set([80, 443, 8000, 8080, 8443]);
  return ports.filter((p) => {
    if (commonPorts.has(p.port)) return true;
    return p.port >= 3000 && p.port < 10000;
  });
}

// ============================================================================
// Port Discovery Service (periodic scanning)
// ============================================================================

export type PortChangeCallback = (ports: ListeningPort[]) => void;

export class PortDiscoveryService {
  private ports: ListeningPort[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private callback: PortChangeCallback | null = null;
  // How to narrow the raw discovered ports (default: common dev ports). The
  // tunnel channel overrides this to "only bedcoder-hosted ports".
  private portFilter: (ports: ListeningPort[]) => ListeningPort[] = filterDevPorts;

  /** Replace the port filter (re-evaluated on every scan). */
  setFilter(fn: (ports: ListeningPort[]) => ListeningPort[]): void {
    this.portFilter = fn;
  }

  /**
   * Start periodic port scanning.
   * @param intervalMs Scan interval in milliseconds (default: 5000)
   */
  start(intervalMs = 5000): void {
    if (this.interval) return;

    // Initial scan
    this.scan();

    // Periodic scan
    this.interval = setInterval(() => this.scan(), intervalMs);
  }

  /**
   * Stop periodic scanning.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Register a callback for port list changes.
   */
  onChange(callback: PortChangeCallback): void {
    this.callback = callback;
  }

  /**
   * Get the current port list.
   */
  getPorts(): ListeningPort[] {
    return this.ports;
  }

  /**
   * Force an immediate scan.
   */
  scan(): void {
    const newPorts = this.portFilter(discoverPorts());
    const changed = this.hasChanged(newPorts);

    if (changed) {
      this.ports = newPorts;
      this.callback?.(newPorts);
    }
  }

  private hasChanged(newPorts: ListeningPort[]): boolean {
    if (newPorts.length !== this.ports.length) return true;

    const oldSet = new Set(this.ports.map((p) => p.port));
    for (const p of newPorts) {
      if (!oldSet.has(p.port)) return true;
    }

    return false;
  }
}
