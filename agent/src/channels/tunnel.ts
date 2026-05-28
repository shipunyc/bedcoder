// Tunnel channel (DESIGN §4.3 / Phase 2.1).
// Handles HTTP proxy requests and port discovery for the Preview Tab.

import type { TunnelInput, TunnelOutput, Envelope, ListeningPort } from '@bedcoder/protocol';
import type { Session } from '../session';
import { log } from '../log';
import { PortDiscoveryService, processTunnelRequest } from '../tunnel';
import { annotateSchemes, probeScheme, type PortScheme, type SchemeProbe } from '../tunnel/port_probe';

// The transport subset the tunnel channel needs (RelayClient satisfies it).
export interface TunnelTransport {
  sendRaw(raw: Uint8Array): void;
  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void;
}

export interface TunnelChannelOptions {
  // Port discovery interval in milliseconds (default: 5000)
  portScanIntervalMs?: number;
  // HTTP request timeout in milliseconds (default: 30000)
  httpTimeoutMs?: number;
  // The session's preview token; if set, the app is told it via preview_info so
  // it can build https://<port>-<token>.<relayBaseDomain>/ links.
  previewToken?: string;
  // PIDs owned by bedcoder's background tasks; when set, the port list is
  // narrowed to *only* those processes (so Preview shows the hosted ports, not
  // every listener on the machine).
  ownedPids?: () => Set<number>;
  // Shared registry the channel fills with each port's probed scheme, so the
  // preview proxy can fetch the upstream with the right scheme.
  portSchemes?: Map<number, PortScheme>;
  // Classify a port as http/https/none. Defaults to the real network probe;
  // tests inject a stub to stay offline and deterministic.
  probeScheme?: SchemeProbe;
}

/**
 * TunnelChannel manages HTTP tunneling for the Preview Tab.
 * It handles port discovery and proxies HTTP requests to local servers.
 */
export class TunnelChannel {
  private readonly portService: PortDiscoveryService;
  private readonly httpTimeoutMs: number;
  private readonly previewToken?: string;
  private readonly portSchemes?: Map<number, PortScheme>;
  private readonly probe: SchemeProbe;

  constructor(
    private readonly session: Session,
    private readonly transport: TunnelTransport,
    options: TunnelChannelOptions = {},
  ) {
    this.portService = new PortDiscoveryService();
    this.httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
    this.previewToken = options.previewToken;
    this.portSchemes = options.portSchemes;
    this.probe = options.probeScheme ?? ((p) => probeScheme(p));

    // Show only bedcoder-hosted ports (this session's background tasks), not
    // every listener on the machine (postgres, redis, …).
    const owned = options.ownedPids;
    if (owned) {
      this.portService.setFilter((ports) => {
        const pids = owned();
        return ports.filter((p) => p.pid !== undefined && pids.has(p.pid));
      });
    }

    // When the port set changes, probe + send it to the app.
    this.portService.onChange((ports) => {
      void this.emitPorts(ports);
    });
  }

  /**
   * Start the tunnel channel.
   * Begins port discovery and listens for tunnel messages.
   */
  start(portScanIntervalMs = 5000): void {
    // Start listening for tunnel messages
    this.transport.onEnvelope((raw, env) => {
      if (env.ch !== 'tunnel') return;
      const { payload } = this.session.decode<TunnelInput>(raw);
      log('tunnel:recv', { type: payload.type });
      this.handleInput(payload);
    });

    // Start port discovery
    this.portService.start(portScanIntervalMs);

    // Tell the app its preview token (for building <port>-<token>.<relay> links).
    if (this.previewToken) this.emit({ type: 'preview_info', token: this.previewToken });

    // Send initial port list
    void this.emitPorts(this.portService.getPorts());
  }

  /**
   * Stop the tunnel channel.
   */
  stop(): void {
    this.portService.stop();
  }

  /** Force an immediate port rescan (e.g. just after killing a hosted process). */
  rescanPorts(): void {
    this.portService.scan();
  }

  /**
   * Handle incoming tunnel messages from the app.
   */
  private async handleInput(input: TunnelInput): Promise<void> {
    if (input.type === 'refresh_ports') {
      // Re-send the preview token too: the app connects after boot and misses the
      // one-shot preview_info from start(), so resend it on every refresh.
      if (this.previewToken) this.emit({ type: 'preview_info', token: this.previewToken });
      // Force a port scan and send the updated list
      this.portService.scan();
      await this.emitPorts(this.portService.getPorts());
      return;
    }

    if (input.type === 'http_request') {
      // Process the HTTP request
      const result = await processTunnelRequest(input, {
        timeoutMs: this.httpTimeoutMs,
      });

      if (result) {
        this.emit(result);
      }
    }
  }

  /**
   * Probe the (already ownership-filtered) ports, drop the ones a browser can't
   * open, record their schemes for the preview proxy, and send the list.
   */
  private async emitPorts(ports: ListeningPort[]): Promise<void> {
    const web = await annotateSchemes(ports, this.probe);
    if (this.portSchemes) {
      this.portSchemes.clear();
      for (const p of web) if (p.scheme) this.portSchemes.set(p.port, p.scheme);
    }
    this.emit({ type: 'port_list', ports: web });
  }

  /**
   * Send a tunnel output message to the app.
   */
  private emit(output: TunnelOutput): void {
    log('tunnel:emit', { type: output.type });
    this.transport.sendRaw(this.session.encode('tunnel', output));
  }
}
