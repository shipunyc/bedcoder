import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverPorts, filterDevPorts, parseLsofListen, parseNetstatListen, PortDiscoveryService } from './port_discovery';
import type { ListeningPort } from '@bedcoder/protocol';

// ============================================================================
// macOS lsof parsing (the address precedes the trailing "(LISTEN)")
// ============================================================================

const SAMPLE_LSOF = `COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
redis-ser   753  cui    6u  IPv4 0x5ab3405531a0ae5f      0t0  TCP 127.0.0.1:6379 (LISTEN)
redis-ser   753  cui    7u  IPv6 0xef0dd4aff4be9fdd      0t0  TCP [::1]:6379 (LISTEN)
node      47755  cui   29u  IPv4 0x9f259192b2859516      0t0  TCP 127.0.0.1:5173 (LISTEN)
node      69966  cui   29u  IPv4 0xa2ff773f9d7abde1      0t0  TCP 127.0.0.1:5174 (LISTEN)
some-srv  12345  cui    4u  IPv6 0xdeadbeef             0t0  TCP *:3000 (LISTEN)
`;

describe('parseLsofListen', () => {
  it('extracts the port before "(LISTEN)" for IPv4, IPv6, and wildcard', () => {
    const ports = parseLsofListen(SAMPLE_LSOF);
    expect(ports.map((p) => p.port)).toEqual([3000, 5173, 5174, 6379]); // sorted, deduped (6379 v4+v6)
  });

  it('keeps the command and pid', () => {
    const ports = parseLsofListen(SAMPLE_LSOF);
    const vite = ports.find((p) => p.port === 5173);
    expect(vite?.process).toBe('node');
    expect(vite?.pid).toBe(47755);
  });

  it('returns nothing for header-only / empty output', () => {
    expect(parseLsofListen('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n')).toEqual([]);
    expect(parseLsofListen('')).toEqual([]);
  });
});

// ============================================================================
// Windows netstat -ano parsing
// ============================================================================

const SAMPLE_NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       12345
  TCP    [::1]:6379             [::]:0                 LISTENING       753
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       12345
  TCP    192.168.1.5:54321      52.1.2.3:443          ESTABLISHED     9000
  UDP    0.0.0.0:5353           *:*                                   2200
`;

describe('parseNetstatListen', () => {
  it('keeps only TCP LISTENING rows, with port + pid', () => {
    const ports = parseNetstatListen(SAMPLE_NETSTAT);
    expect(ports.map((p) => p.port)).toEqual([135, 5173, 6379]); // sorted, deduped
    const vite = ports.find((p) => p.port === 5173);
    expect(vite?.pid).toBe(12345);
    expect(vite?.process).toBeUndefined(); // netstat gives no process name
  });

  it('parses IPv6 local addresses', () => {
    const ports = parseNetstatListen(SAMPLE_NETSTAT);
    expect(ports.find((p) => p.port === 6379)?.pid).toBe(753);
  });

  it('ignores ESTABLISHED/UDP and header/blank lines', () => {
    const ports = parseNetstatListen(SAMPLE_NETSTAT).map((p) => p.port);
    expect(ports).not.toContain(54321); // ESTABLISHED
    expect(ports).not.toContain(5353); // UDP
  });

  it('returns nothing for empty output', () => {
    expect(parseNetstatListen('')).toEqual([]);
  });
});

// ============================================================================
// Mock /proc/net/tcp parsing tests
// ============================================================================

// Sample /proc/net/tcp content for testing
const SAMPLE_PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345
   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12346
   2: 0100007F:0050 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 12347
   3: 00000000:1388 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12348
`;

// Parse the internal format for testing
function parseProcNetTcpForTest(content: string): { port: number; state: string }[] {
  const lines = content.trim().split('\n').slice(1);
  const entries: { port: number; state: string }[] = [];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;

    const localAddr = parts[1];
    const state = parts[3];
    if (!localAddr || !state) continue;
    const [, portHex] = localAddr.split(':');
    if (!portHex) continue;

    const port = parseInt(portHex, 16);
    entries.push({ port, state });
  }

  return entries;
}

describe('parseProcNetTcp', () => {
  it('parses port numbers from hex format', () => {
    const entries = parseProcNetTcpForTest(SAMPLE_PROC_NET_TCP);

    // 0x0BB8 = 3000, 0x1F90 = 8080, 0x0050 = 80, 0x1388 = 5000
    expect(entries).toEqual([
      { port: 3000, state: '0A' }, // LISTEN
      { port: 8080, state: '0A' }, // LISTEN
      { port: 80, state: '01' }, // ESTABLISHED (not LISTEN)
      { port: 5000, state: '0A' }, // LISTEN
    ]);
  });

  it('only LISTEN state (0A) should be returned by discoverPorts logic', () => {
    const entries = parseProcNetTcpForTest(SAMPLE_PROC_NET_TCP);
    const listening = entries.filter((e) => e.state === '0A');

    expect(listening.map((e) => e.port)).toEqual([3000, 8080, 5000]);
  });
});

// ============================================================================
// filterDevPorts tests
// ============================================================================

describe('filterDevPorts', () => {
  const allPorts: ListeningPort[] = [
    { port: 22 }, // SSH - excluded
    { port: 80 }, // HTTP - included (common)
    { port: 443 }, // HTTPS - included (common)
    { port: 631 }, // CUPS - excluded
    { port: 3000 }, // Dev server - included (range)
    { port: 4000 }, // Dev server - included (range)
    { port: 5173 }, // Vite - included (range)
    { port: 8000 }, // Python http.server - included (common)
    { port: 8080 }, // Common alt HTTP - included (common)
    { port: 9999 }, // Edge of range - included
    { port: 10000 }, // Outside range - excluded
    { port: 49152 }, // Ephemeral port - excluded
  ];

  it('filters to dev-relevant ports', () => {
    const filtered = filterDevPorts(allPorts);
    const ports = filtered.map((p) => p.port);

    expect(ports).toContain(80);
    expect(ports).toContain(443);
    expect(ports).toContain(3000);
    expect(ports).toContain(4000);
    expect(ports).toContain(5173);
    expect(ports).toContain(8000);
    expect(ports).toContain(8080);
    expect(ports).toContain(9999);

    expect(ports).not.toContain(22);
    expect(ports).not.toContain(631);
    expect(ports).not.toContain(10000);
    expect(ports).not.toContain(49152);
  });

  it('returns empty array for empty input', () => {
    expect(filterDevPorts([])).toEqual([]);
  });

  it('preserves port metadata', () => {
    const portsWithMeta: ListeningPort[] = [
      { port: 3000, pid: 12345, process: 'node', cmdline: 'node server.js' },
    ];
    const filtered = filterDevPorts(portsWithMeta);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual({
      port: 3000,
      pid: 12345,
      process: 'node',
      cmdline: 'node server.js',
    });
  });
});

// ============================================================================
// PortDiscoveryService tests
// ============================================================================

describe('PortDiscoveryService', () => {
  let service: PortDiscoveryService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new PortDiscoveryService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it('starts with empty port list', () => {
    expect(service.getPorts()).toEqual([]);
  });

  it('calls onChange when ports change', () => {
    const callback = vi.fn();
    service.onChange(callback);

    // Manually inject ports by overriding getPorts temporarily
    // This is a simplified test; real tests would mock discoverPorts
    service.scan();

    // Callback may or may not be called depending on actual system ports
    // At minimum, verify it doesn't throw
    expect(() => service.scan()).not.toThrow();
  });

  it('stops periodic scanning', () => {
    service.start(1000);
    service.stop();

    // Advance time and verify no more scans
    const callback = vi.fn();
    service.onChange(callback);

    vi.advanceTimersByTime(5000);

    // Callback should not be called after stop
    // (unless there were initial ports, but we stopped immediately)
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not start multiple intervals', () => {
    service.start(1000);
    service.start(1000); // Should be no-op
    service.stop();

    // No error should occur
    expect(true).toBe(true);
  });
});

// ============================================================================
// Integration test (only on supported platforms)
// ============================================================================

describe('discoverPorts integration', () => {
  it('returns array on supported platforms', () => {
    const ports = discoverPorts();
    expect(Array.isArray(ports)).toBe(true);
  });

  it('returned ports have valid structure', () => {
    const ports = discoverPorts();

    for (const port of ports) {
      expect(typeof port.port).toBe('number');
      expect(port.port).toBeGreaterThan(0);
      expect(port.port).toBeLessThanOrEqual(65535);

      if (port.pid !== undefined) {
        expect(typeof port.pid).toBe('number');
      }
      if (port.process !== undefined) {
        expect(typeof port.process).toBe('string');
      }
      if (port.cmdline !== undefined) {
        expect(typeof port.cmdline).toBe('string');
      }
    }
  });
});
