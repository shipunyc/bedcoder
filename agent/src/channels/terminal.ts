import type { TerminalInput, TerminalOutput, NotifyHint, Envelope } from '@bedcoder/protocol';
import type { Session } from '../session';
import { log } from '../log';
import {
  listSessionsWithPreview,
  readTranscript,
  readLatestTasks,
  type TranscriptEntry,
} from '../claude/sessions';
import { SessionController, type EngineFactory, type SessionPreview } from './session-controller';

// The transport subset the terminal channel needs (RelayClient satisfies it).
export interface SessionTransport {
  sendRaw(raw: Uint8Array): void;
  onEnvelope(handler: (raw: Uint8Array, env: Envelope) => void): void;
}

export interface TerminalChannelOptions {
  initial: { sessionId: string; resume: boolean };
  cwd?: string;
  label?: string; // worktree/branch or project-dir name, sent to the app
  // Overridable for tests so they don't touch ~/.claude.
  listSessions?: () => SessionPreview[];
  readTranscript?: (sessionId: string) => TranscriptEntry[];
}

// TerminalChannel is the transport adapter: it decodes app envelopes into
// TerminalInput and encodes engine TerminalOutput back, delegating all session
// orchestration to a SessionController.
export class TerminalChannel {
  private readonly controller: SessionController;

  constructor(
    private readonly session: Session,
    private readonly transport: SessionTransport,
    factory: EngineFactory,
    options: TerminalChannelOptions,
  ) {
    const cwd = options.cwd ?? process.cwd();
    this.controller = new SessionController(factory, {
      emit: (out) => {
        log('emit', { type: out.type });
        this.transport.sendRaw(this.session.encode('terminal', out, notifyFor(out)));
      },
      listSessions: options.listSessions ?? (() => listSessionsWithPreview(cwd)),
      readTranscript: options.readTranscript ?? ((id) => readTranscript(cwd, id)),
      readLatestTasks: (id) => readLatestTasks(cwd, id),
      initial: options.initial,
      cwd,
      label: options.label,
    });
  }

  start(): void {
    this.transport.onEnvelope((raw, env) => {
      if (env.ch !== 'terminal') return;
      const { payload } = this.session.decode<TerminalInput>(raw);
      log('recv', { type: payload.type, seq: env.seq });
      this.controller.dispatch(payload);
    });
    this.controller.start();
  }
}

function notifyFor(out: TerminalOutput): NotifyHint | undefined {
  if (out.type === 'permission_request') return 'permission_needed';
  if (out.type === 'status' && out.state === 'error') return 'error_occurred';
  return undefined;
}
