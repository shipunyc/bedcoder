// CLI argument parsing for `bedcoder` (DESIGN §3.1). Phase 1 supports the new
// session, --resume, --relay, a --fake engine for testing without auth, and
// --log to write a diagnostics file.
export interface CliConfig {
  resume: boolean;
  resumeId?: string;
  relayUrl: string;
  fake: boolean;
  log: boolean;
  logPath?: string;
  model?: string; // override the catalog default (e.g. --model claude-sonnet-4-6)
  modelsUrl: string; // where to fetch the model catalog from
  tunnel?: string; // optional port-discovery hint ('auto' or 'p1,p2'); preview is always on
  worktree?: string; // run inside .worktrees/<name> (parallel task on the same repo)
  // Enable SDK file checkpointing so /rewind can restore code. Off by default:
  // it uses git "shadow repos" and can stall/break the agent's CLI subprocess on
  // some setups (no git, non-repo cwd, slow/networked FS) — chat must not depend
  // on it. Requires git + a normal, writable project.
  rewindCode: boolean;
}

export const DEFAULT_RELAY_URL = 'wss://relay.bedcoder.org';
export const DEFAULT_MODELS_URL = 'https://www.bedcoder.org/models.json';

export function parseArgs(argv: string[]): CliConfig {
  const config: CliConfig = {
    resume: false,
    relayUrl: DEFAULT_RELAY_URL,
    fake: false,
    log: false,
    modelsUrl: process.env.BEDCODER_MODELS_URL ?? DEFAULT_MODELS_URL,
    rewindCode: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        // "end of options" separator; some runners (e.g. `pnpm start -- …`)
        // forward it verbatim. Ignore it.
        break;
      case '--resume': {
        config.resume = true;
        // Optional session id: `--resume <id>` (a following non-flag argument).
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          config.resumeId = next;
          i++;
        }
        break;
      }
      case '--fake':
        config.fake = true;
        break;
      case '--rewind-code':
        config.rewindCode = true;
        break;
      case '--log': {
        // Enable the diagnostics log → ~/.bedcoder/agent.log. A following non-flag
        // argument (`--log <path>`) overrides that file. Without --log, nothing
        // is written.
        config.log = true;
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          config.logPath = next;
          i++;
        }
        break;
      }
      case '--relay': {
        const next = argv[i + 1];
        if (!next) throw new Error('--relay requires a URL');
        config.relayUrl = next;
        i++;
        break;
      }
      case '--model': {
        const next = argv[i + 1];
        if (!next) throw new Error('--model requires a model id');
        config.model = next;
        i++;
        break;
      }
      case '--tunnel': {
        // Port preview is always on; --tunnel is accepted for explicitness and
        // takes an optional hint: `--tunnel auto` (default) or `--tunnel 3000,8080`.
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          config.tunnel = next;
          i++;
        } else {
          config.tunnel = 'auto';
        }
        break;
      }
      case '--models-url': {
        const next = argv[i + 1];
        if (!next) throw new Error('--models-url requires a URL');
        config.modelsUrl = next;
        i++;
        break;
      }
      case '--worktree': {
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) throw new Error('--worktree requires a name');
        config.worktree = next;
        i++;
        break;
      }
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return config;
}
