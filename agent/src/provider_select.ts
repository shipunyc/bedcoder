// Interactive provider selection at startup. Three callers:
//   1. forced flag (--minimax etc.)         → skip menu, still resolve key
//   2. no flag, with cached default         → show menu pre-selected to that
//   3. no flag, no cached default           → show menu pre-selected to claude
//
// For non-claude providers, the key resolution order is:
//   1. apiKey saved in ~/.bedcoder/config.json
//   2. <PROVIDER>_API_KEY env (e.g. GLM_API_KEY) — escape hatch for headless
//   3. interactive prompt (TTY only) → optionally save to config
//
// Non-TTY + (no cached key + no env fallback) → fail-fast with a clear message.

import * as readline from 'node:readline';

import {
  PROVIDER_IDS,
  PROVIDERS,
  envFallbackKey,
  type ProviderId,
  type ProviderSpec,
} from './providers';
import {
  readConfig,
  savedApiKey,
  setApiKey,
  setDefaultProvider,
  writeConfig,
  type BedcoderConfig,
} from './providers_config';
import { log } from './log';

export interface ProviderSelection {
  spec: ProviderSpec;
  // undefined for claude (which uses its own auth chain). Set for the other
  // three so applyProviderEnv can write keyEnvName into process.env.
  apiKey?: string;
}

// Hooks let tests stub I/O without touching the real filesystem or stdin.
export interface ProviderSelectIO {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  readConfig?: () => BedcoderConfig;
  writeConfig?: (cfg: BedcoderConfig) => void;
}

// Default for the menu when no flag is given: the cached choice, else claude.
function pickDefaultMenuId(cfg: BedcoderConfig): ProviderId {
  return cfg.defaultProvider ?? 'claude';
}

export async function selectProvider(
  forced: ProviderId | undefined,
  io: ProviderSelectIO = {},
): Promise<ProviderSelection> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  const cfgRead = io.readConfig ?? readConfig;
  const cfgWrite = io.writeConfig ?? writeConfig;

  let cfg = cfgRead();

  // Decide which provider we're using.
  const chosen: ProviderId = forced ?? (await chooseFromMenu(cfg, stdin, stdout));
  const spec = PROVIDERS[chosen];

  // claude needs no key from us.
  if (!spec.needsKey) {
    persistDefaultIfChanged(cfg, chosen, cfgWrite);
    return { spec };
  }

  // 1) cached → 2) env fallback → 3) interactive prompt.
  let apiKey = savedApiKey(cfg, chosen) ?? envFallbackKey(chosen, env);
  if (!apiKey) {
    if (!stdin.isTTY) {
      stdout.write(
        `No saved API key for ${spec.label} and no ${chosen.toUpperCase()}_API_KEY in env.\n` +
          `Re-run interactively to set one, or export ${chosen.toUpperCase()}_API_KEY.\n`,
      );
      process.exit(1);
    }
    apiKey = await promptForKey(spec, stdin, stdout);
    const save = await promptSaveKey(stdin, stdout);
    if (save) {
      cfg = setApiKey(cfg, chosen, apiKey);
      // We're about to persistDefault below, so write once with both changes.
    }
  }

  persistDefaultIfChanged(cfg, chosen, cfgWrite);
  return { spec, apiKey };
}

// Save the chosen provider as default if it differs from what's on disk. We
// always run this — silent no-op when unchanged — so a user who picks the same
// thing repeatedly doesn't cause extra writes.
function persistDefaultIfChanged(
  cfg: BedcoderConfig,
  chosen: ProviderId,
  write: (c: BedcoderConfig) => void,
): void {
  const next = setDefaultProvider(cfg, chosen);
  // Skip the write if nothing changed (both default and providers identical).
  if (cfg.defaultProvider === chosen && cfg.providers === next.providers) return;
  try {
    write(next);
  } catch (err) {
    log('provider.config.write_failed', { err: String(err) });
  }
}

// Render the menu. Marks each line with `[saved]` / `[no key]` so the user
// can see which providers are already configured. Pre-selects the cached
// default; bare Enter takes it.
//
// Three modes:
//   - Non-TTY (CI / piped stdin): silently use the cached default
//   - Raw-mode TTY (real terminals): arrow-key navigation + 1-N shortcuts
//   - Cooked TTY (test PassThrough, exotic terminals without setRawMode):
//     fall back to the line-based "type a number" prompt
async function chooseFromMenu(
  cfg: BedcoderConfig,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<ProviderId> {
  const defId = pickDefaultMenuId(cfg);

  if (!stdin.isTTY) {
    log('provider.menu.no_tty', { default: defId });
    return defId;
  }

  if (typeof stdin.setRawMode === 'function') {
    return chooseFromMenuInteractive(cfg, defId, stdin, stdout);
  }
  return chooseFromMenuLineBased(cfg, defId, stdin, stdout);
}

// Arrow-key menu. Renders, then on each keystroke moves the highlight, redraws
// in place (cursor up + erase line), commits on Enter, aborts on Ctrl-C, and
// 1-N also commits the matching item as a shortcut.
async function chooseFromMenuInteractive(
  cfg: BedcoderConfig,
  defId: ProviderId,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<ProviderId> {
  let index = Math.max(0, PROVIDER_IDS.indexOf(defId));
  const headerLines = 3; // blank + title + blank
  const total = headerLines + PROVIDER_IDS.length;

  const lineFor = (id: ProviderId, i: number): string => {
    const spec = PROVIDERS[id];
    const status = id === 'claude' ? '' : savedApiKey(cfg, id) ? '  [saved]' : '  [no key]';
    const selected = i === index;
    const marker = selected ? '\x1b[36m▸ \x1b[0m' : '  ';
    const body = selected ? `\x1b[36m${spec.label}\x1b[0m` : spec.label;
    const star = id === defId ? ' \x1b[2m(last used)\x1b[0m' : '';
    return `${marker}${body}${status}${star}`;
  };

  const draw = (first: boolean): void => {
    if (!first) {
      // Move cursor back to the top of the menu and clear each line as we redraw.
      stdout.write(`\x1b[${total}A`);
    }
    stdout.write('\n\x1b[2K\x1b[1mChoose your AI provider\x1b[0m \x1b[2m(↑/↓, Enter, 1-' + PROVIDER_IDS.length + ', Ctrl-C to cancel)\x1b[0m\n');
    stdout.write('\x1b[2K\n');
    PROVIDER_IDS.forEach((id, i) => {
      stdout.write('\x1b[2K' + lineFor(id, i) + '\n');
    });
  };

  stdout.write('\x1b[?25l'); // hide cursor
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  draw(true);

  return new Promise<ProviderId>((resolve) => {
    const finish = (chosen: ProviderId, aborted = false): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\x1b[?25h'); // show cursor
      if (aborted) {
        stdout.write('\nAborted.\n');
        process.exit(130);
      }
      // Move past the menu so subsequent output isn't drawn on top of it.
      stdout.write('\n');
      resolve(chosen);
    };

    const onData = (chunk: string): void => {
      // Keys can arrive batched (esp. paste / arrow-key escape sequences split
      // across reads). Handle one logical key at a time.
      let i = 0;
      while (i < chunk.length) {
        const c = chunk[i]!;
        if (c === '\x03') {
          finish(PROVIDER_IDS[index]!, true); // Ctrl-C
          return;
        }
        if (c === '\r' || c === '\n') {
          finish(PROVIDER_IDS[index]!);
          return;
        }
        if (c === '\x1b' && chunk[i + 1] === '[') {
          const dir = chunk[i + 2];
          if (dir === 'A') index = (index - 1 + PROVIDER_IDS.length) % PROVIDER_IDS.length;
          else if (dir === 'B') index = (index + 1) % PROVIDER_IDS.length;
          i += 3;
          draw(false);
          continue;
        }
        // Numeric shortcut: 1-N commits the matching provider immediately.
        const n = parseInt(c, 10);
        if (!isNaN(n) && n >= 1 && n <= PROVIDER_IDS.length) {
          index = n - 1;
          draw(false);
          finish(PROVIDER_IDS[index]!);
          return;
        }
        i++;
      }
    };

    stdin.on('data', onData);
  });
}

// Cooked-TTY fallback: the original "type a number" prompt. Kept for terminals
// without setRawMode (rare) and for unit tests (which use PassThrough).
async function chooseFromMenuLineBased(
  cfg: BedcoderConfig,
  defId: ProviderId,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<ProviderId> {
  stdout.write('\nChoose your AI provider:\n');
  PROVIDER_IDS.forEach((id, i) => {
    const spec = PROVIDERS[id];
    const marker = id === defId ? '* ' : '  ';
    const status = id === 'claude'
      ? '' // claude uses its own auth, nothing for us to mark
      : savedApiKey(cfg, id)
        ? '  [saved]'
        : '  [no key]';
    stdout.write(`${marker}${i + 1}) ${spec.label}${status}\n`);
  });
  stdout.write(`\nPress Enter for [${PROVIDER_IDS.indexOf(defId) + 1}] ${PROVIDERS[defId].label}, or pick 1-${PROVIDER_IDS.length}: `);

  const answer = (await ask(stdin, stdout, '')).trim();
  if (answer === '') return defId;
  const idx = parseInt(answer, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= PROVIDER_IDS.length) return PROVIDER_IDS[idx - 1]!;

  stdout.write(`Invalid selection "${answer}"; using default ${PROVIDERS[defId].label}.\n`);
  return defId;
}

async function promptForKey(
  spec: ProviderSpec,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<string> {
  stdout.write(`\nEnter your ${spec.label} API key`);
  if (spec.keyHelpUrl) stdout.write(` (get one at ${spec.keyHelpUrl})`);
  stdout.write(': ');
  // Plain readline (no masking) — same posture as `claude` itself when it
  // asks for a key, and avoids the cross-platform complexity of toggling raw
  // mode just to hide a string the user immediately stores in plain text.
  const key = (await ask(stdin, stdout, '')).trim();
  if (!key) {
    stdout.write('Empty key; aborting.\n');
    process.exit(1);
  }
  return key;
}

async function promptSaveKey(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): Promise<boolean> {
  const answer = (await ask(stdin, stdout, 'Save this key to ~/.bedcoder/config.json for next time? [Y/n]: '))
    .trim()
    .toLowerCase();
  // Default Y on bare Enter.
  return answer === '' || answer === 'y' || answer === 'yes';
}

function ask(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a);
    });
  });
}
