import {
  genPairCode,
  genEphemeralKeyPair,
  genSalt,
  commit,
  deriveSAS,
  wrapKey,
  type EphemeralKeyPair,
  type PairingMessage,
} from '@bedcoder/protocol';

// The pairing transport subset the agent needs (RelayClient satisfies it).
export interface PairingTransport {
  onPairing(handler: (msg: PairingMessage) => void): void;
  sendPairing(msg: PairingMessage): void;
}

export interface AgentPairingEvents {
  onSAS?: (sas: string) => void;
  onPaired?: () => void;
}

// AgentPairing runs the agent side of the commitment + SAS handshake (DESIGN
// §4.8): register(commit) -> [app claims] -> responder -> reveal + show SAS ->
// [user confirms] -> wrap K with crypto_box -> key.
export class AgentPairing {
  readonly code: string;
  private readonly eph: EphemeralKeyPair;
  private readonly salt: Uint8Array;
  private readonly commitment: Uint8Array;
  private appPub?: Uint8Array;
  private _paired = false;

  get paired(): boolean {
    return this._paired;
  }

  constructor(
    private readonly transport: PairingTransport,
    private readonly sessionKey: Uint8Array,
    private readonly events: AgentPairingEvents = {},
  ) {
    this.code = genPairCode();
    this.eph = genEphemeralKeyPair();
    this.salt = genSalt();
    this.commitment = commit(this.eph.publicKey, this.salt);
  }

  start(): void {
    this.transport.onPairing((msg) => this.handle(msg));
    this.register();
  }

  // Offer the pairing code to the relay. Safe to call again after a reconnect
  // (while still unpaired) to re-create the slot.
  register(): void {
    this.transport.sendPairing({ type: 'register', code: this.code, commit: this.commitment });
  }

  private handle(msg: PairingMessage): void {
    switch (msg.type) {
      case 'responder': {
        this.appPub = msg.appEphPub;
        // Reveal our public key + salt so the app can verify the commitment.
        this.transport.sendPairing({
          type: 'reveal',
          agentEphPub: this.eph.publicKey,
          salt: this.salt,
        });
        this.events.onSAS?.(deriveSAS(this.eph.publicKey, this.appPub));
        break;
      }
      case 'confirm': {
        if (!this.appPub) return;
        // SAS confirmed by the user: deliver K wrapped to the app's public key.
        this.transport.sendPairing({
          type: 'key',
          wrappedKey: wrapKey(this.sessionKey, this.appPub, this.eph.secretKey),
        });
        this._paired = true;
        this.events.onPaired?.();
        break;
      }
      default:
        break;
    }
  }
}
