import {
  encodePairing,
  decodePairing,
  decodeEnvelope,
  encodePreview,
  decodePreview,
  peekMessageKind,
  type PairingMessage,
  type PreviewFrame,
  type Envelope,
} from '@bedcoder/protocol';

// A minimal socket abstraction so the relay client can be unit-tested with a
// fake and run on Node `ws` in production.
export interface RelaySocket {
  send(data: Uint8Array): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
}

export type SocketFactory = (url: string) => RelaySocket;

export type PairingHandler = (msg: PairingMessage) => void;
export type EnvelopeHandler = (raw: Uint8Array, env: Envelope) => void;
export type PreviewHandler = (frame: PreviewFrame) => void;

export interface Gap {
  from: string;
  expected: number;
  got: number;
}

export interface RelayClientOptions {
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  onReconnect?: () => void;
  onGap?: (gap: Gap) => void;
}

// RelayClient connects to the relay's /ws endpoint for one session and
// dispatches inbound frames as either pairing messages or session envelopes.
// It buffers outbound frames while disconnected (outbox) and auto-reconnects
// with backoff; the relay re-registers the agent by the sid query param.
export class RelayClient {
  private socket?: RelaySocket;
  private open = false;
  private closedByUser = false;
  private readonly outbox: Uint8Array[] = [];
  private reconnectAttempts = 0;
  private readonly lastInboundSeq = new Map<string, number>();

  private pairingHandler: PairingHandler = () => {};
  // Multiple channels (terminal, tunnel, files, mirror) each subscribe; fan every
  // envelope out to all of them. (A single handler would let the last subscriber
  // clobber the rest — which silently broke the chat/terminal channel.)
  private readonly envelopeHandlers: EnvelopeHandler[] = [];
  private previewHandler: PreviewHandler = () => {};

  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly onReconnect: () => void;
  private readonly onGap: (gap: Gap) => void;

  constructor(
    private readonly url: string,
    private readonly factory: SocketFactory,
    options: RelayClientOptions = {},
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 15000;
    this.onReconnect = options.onReconnect ?? (() => {});
    this.onGap = options.onGap ?? (() => {});
  }

  // Resolves once the first connection is open. Reconnects afterwards are silent.
  connect(): Promise<void> {
    return new Promise((resolve) => this.dial(resolve));
  }

  onPairing(handler: PairingHandler): void {
    this.pairingHandler = handler;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.envelopeHandlers.push(handler);
  }

  // Preview control frames (relay <-> agent, plaintext; see DESIGN §5 carve-out).
  onPreview(handler: PreviewHandler): void {
    this.previewHandler = handler;
  }

  sendPreview(frame: PreviewFrame): void {
    this.enqueueOrSend(encodePreview(frame));
  }

  sendPairing(msg: PairingMessage): void {
    this.enqueueOrSend(encodePairing(msg));
  }

  sendRaw(raw: Uint8Array): void {
    this.enqueueOrSend(raw);
  }

  close(): void {
    this.closedByUser = true;
    this.socket?.close();
  }

  private dial(onFirstOpen?: () => void): void {
    const socket = this.factory(this.url);
    this.socket = socket;
    this.open = false;

    socket.onOpen(() => {
      this.open = true;
      const reconnected = this.reconnectAttempts > 0;
      this.reconnectAttempts = 0;
      this.flush();
      if (reconnected) this.onReconnect();
      onFirstOpen?.();
    });
    socket.onMessage((data) => this.handle(data));
    socket.onClose(() => {
      this.open = false;
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.reconnectDelayMs * 2 ** this.reconnectAttempts,
      this.maxReconnectDelayMs,
    );
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.closedByUser) this.dial();
    }, delay);
  }

  private enqueueOrSend(frame: Uint8Array): void {
    if (this.open && this.socket) {
      this.socket.send(frame);
    } else {
      this.outbox.push(frame);
    }
  }

  private flush(): void {
    if (!this.socket) return;
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const frame of pending) this.socket.send(frame);
  }

  private handle(data: Uint8Array): void {
    switch (peekMessageKind(data)) {
      case 'preview':
        this.previewHandler(decodePreview(data));
        break;
      case 'pairing':
        this.pairingHandler(decodePairing(data));
        break;
      case 'envelope': {
        const env = decodeEnvelope(data);
        this.checkGap(env);
        for (const handler of this.envelopeHandlers) handler(data, env);
        break;
      }
      default:
        break;
    }
  }

  // Detect dropped frames: the relay forwards in order and drops when a peer is
  // offline, so a skipped seq means we missed something.
  private checkGap(env: Envelope): void {
    const last = this.lastInboundSeq.get(env.from);
    if (last !== undefined && env.seq > last + 1) {
      this.onGap({ from: env.from, expected: last + 1, got: env.seq });
    }
    this.lastInboundSeq.set(env.from, env.seq);
  }
}
