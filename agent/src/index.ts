import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as readline from 'node:readline';
import { generateKey } from '@bedcoder/protocol';
import { parseArgs } from './cli';
import { RelayClient } from './transport/relay';
import { nodeSocketFactory } from './transport/ws-factory';
import { Session } from './session';
import { AgentPairing } from './pairing';
import { TerminalChannel } from './channels/terminal';
import { TunnelChannel } from './channels/tunnel';
import { PreviewProxy, generatePreviewToken, discoverPorts, type PortScheme } from './tunnel';
import { FilesChannel } from './channels/files';
import { MirrorChannel } from './channels/mirror';
import type { EngineFactory } from './channels/session-controller';
import { FakeEngine } from './claude/engine';
import { ClaudeEngine } from './claude/claude-engine';
import { fetchModelCatalog } from './claude/models';
import { ensureWorktree } from './worktree';
import { latestSessionId } from './claude/sessions';
import { encodeQrPayload, renderQr } from './auth/qrcode';
import { log, enableLog, isLogging, logFilePath } from './log';
import {
  TerminalManager,
  TerminalTracker,
  descendantPids,
  killDescendants,
  killProcessTree,
  killTargetPid,
  type TrackableMessage,
} from './terminal';

// The bundled Claude CLI refuses --dangerously-skip-permissions when launched
// as root (uid 0) on Linux/macOS — exits 1 at boot — unless IS_SANDBOX=1 is set.
// We always pass that SDK flag so the user can switch to 'auto' mode at runtime,
// so as root, bedcoder simply won't start without the env var. Setting it bypasses
// an intentional safety guard (root + auto = unconfirmed root commands on this
// host), so we make the user opt in. Accepted -> mutate parent process.env;
// child Claude CLI inherits it. Refused or no TTY -> exit.
async function confirmRootSandbox(): Promise<void> {
  const isRoot =
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0;
  if (!isRoot) return;

  console.log('');
  console.log('⚠️  Running as root (uid 0).');
  console.log('');
  console.log('To start, bedcoder must set IS_SANDBOX=1 on the Claude CLI subprocess.');
  console.log('That bypasses a safety guard which normally refuses');
  console.log('--dangerously-skip-permissions as root. If you later switch the phone to');
  console.log('"auto" mode, Claude will be able to run any command on this host as root');
  console.log('with no confirmation.');
  console.log('');
  console.log('Only accept if this is a sandboxed environment (container, VM, disposable');
  console.log("VPS). Don't accept on a host you care about.");
  console.log('');

  if (!process.stdin.isTTY) {
    console.error(
      'No TTY available to confirm. Re-run with an interactive terminal, or run as a non-root user.',
    );
    process.exit(1);
  }

  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Proceed? [y/N]: ', (a) => {
      rl.close();
      resolve(a);
    });
  });
  const a = answer.trim().toLowerCase();
  if (a !== 'y' && a !== 'yes') {
    console.error('Aborted.');
    process.exit(1);
  }
  process.env.IS_SANDBOX = '1';
  log('root_sandbox_accepted', {});
}

// bedcoder — headless daemon entry (DESIGN §3). Shows a pairing code + QR and
// relays the Claude session to the phone; renders no conversation locally.
async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (config.log) enableLog(config.logPath); // off unless --log
  log('boot', { resume: config.resume });

  // Root consent gate: must run before relay/QR so we don't connect-then-abort.
  await confirmRootSandbox();

  // SDK file checkpointing (for /rewind code) is OPT-IN via --rewind-code: it
  // uses git "shadow repos" and can stall/kill the CLI subprocess on some setups
  // (no git, non-repo cwd, slow FS), which would break chat itself. Default off
  // so chat is robust everywhere; the user enables it where their env supports it.
  // Must be set before the SDK spawns its CLI subprocess.
  if (config.rewindCode) process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING ??= '1';

  // Last-resort safety net: the SDK's internal machinery (e.g. ProcessTransport
  // .write from streamInput/interrupt) can reject or throw when its CLI
  // subprocess dies — common on a remote box where `claude` isn't authed. Those
  // failures fire outside our await chains, so they'd otherwise crash the daemon
  // and drop the phone's session. Keep running; the real error still reaches the
  // app via the engine's stream-end notice (SessionController.run catches it).
  process.on('unhandledRejection', (reason) => log('unhandledRejection', { err: String(reason) }));
  process.on('uncaughtException', (err) => log('uncaughtException', { err: String(err) }));

  // --worktree: run inside .worktrees/<name> so this conversation works on the
  // repo in parallel without touching the main checkout. chdir before anything
  // reads cwd (sessions, files root, port discovery all scope to it).
  let label: string | undefined;
  if (config.worktree) {
    try {
      const wt = ensureWorktree(config.worktree);
      process.chdir(wt.path);
      label = config.worktree;
      log('worktree', { name: config.worktree, path: wt.path, branch: wt.branch });
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
  }
  // The app labels the conversation by worktree name, else the project dir.
  label ??= basename(process.cwd());

  // On --resume, continue an existing ~/.claude session (specific id or the
  // latest for this project) and reuse its id as the relay sid. Otherwise start
  // fresh; the SDK persists the new session to ~/.claude so `claude --resume`
  // can pick it up later.
  let sid: string;
  let resume = false;
  if (config.resume) {
    const resolved = config.resumeId ?? latestSessionId(process.cwd());
    if (!resolved) {
      console.error('No Claude session to resume in this project. Run `claude` here first, or start without --resume.');
      process.exit(1);
    }
    sid = resolved;
    resume = true;
  } else {
    sid = randomUUID();
  }
  const key = generateKey();
  const url = `${config.relayUrl}/ws?role=agent&sid=${encodeURIComponent(sid)}`;

  let pairing: AgentPairing | undefined;
  let previewProxy: PreviewProxy | undefined;
  let status = 'waiting for phone…';
  let sas = '';

  const relay = new RelayClient(url, nodeSocketFactory, {
    onReconnect: () => {
      // The relay re-registers us by sid; if we hadn't paired yet, re-offer the code.
      if (pairing && !pairing.paired) pairing.register();
      previewProxy?.register(); // re-claim the preview token after a reconnect
      status = 'reconnected';
      render();
    },
    onGap: (gap) => {
      status = `dropped ${gap.got - gap.expected + 1} message(s) from ${gap.from}`;
      render();
    },
  });
  await relay.connect();

  // Terminal manager for Mirror Tab (tracks hosted bash processes). The tracker
  // observes the SDK message stream (Bash, incl. run_in_background, + BashOutput)
  // to surface output and exit — the SDK ignores our command rewrite, so we read
  // what Claude sees rather than tee-ing a wrapper.
  const terminalManager = new TerminalManager();
  const terminalTracker = new TerminalTracker(terminalManager);

  // Model catalog: which models to offer + the default (www.bedcoder.org/models.json,
  // with a baked-in fallback). --model overrides the default.
  const catalog = await fetchModelCatalog(config.modelsUrl);
  const model = config.model ?? catalog.default;
  log('models', { default: catalog.default, chosen: model, count: catalog.models.length });

  // Factory so the terminal channel can swap engines at runtime (/resume, /clear).
  // Each engine is wired to the terminal tracker for Mirror Tab support.
  const factory: EngineFactory = config.fake
    ? (cfg) => new FakeEngine(cfg)
    : (cfg) => {
        const engine = new ClaudeEngine({ ...cfg, model, models: catalog.models });
        engine.onRawMessage((msg) => {
          terminalTracker.track(msg as TrackableMessage);
        });
        return engine;
      };

  const session = new Session(sid, key);
  const cwd = process.cwd();

  // Phase 2.1: preview reverse-proxy — claim a token with the relay and answer
  // its preview requests by fetching localhost ports (DESIGN §5 carve-out).
  // The tunnel channel probes each port's scheme into this shared map so the
  // proxy fetches http vs https correctly.
  const portSchemes = new Map<number, PortScheme>();
  const previewToken = generatePreviewToken();
  previewProxy = new PreviewProxy(relay, previewToken, { schemeFor: (p) => portSchemes.get(p) });
  previewProxy.start();

  // Phase 1: Terminal channel (chat UI)
  new TerminalChannel(session, relay, factory, { initial: { sessionId: sid, resume }, label }).start();

  // Phase 2.1: Tunnel channel (Preview Tab) — only the ports this session hosts,
  // plus the preview token.
  const tunnel = new TunnelChannel(session, relay, {
    previewToken,
    // Ports hosted by this conversation = anything the agent (and Claude under
    // it) spawned. Derived from our own process subtree, because the SDK runs
    // run_in_background Bash itself and ignores our command rewrite.
    ownedPids: () => descendantPids(process.pid),
    portSchemes,
  });
  tunnel.start();

  // Phase 2.2: Files channel (Files Tab - file browsing)
  new FilesChannel(session, relay, { root: cwd }).start();

  // Phase 2.3: Mirror channel (Mirror Tab - hosted terminals + background shells).
  // Stop kills the dev server via the descendant tree's hosted ports: match the
  // port we learned from the task's output, or — if unknown but the agent hosts
  // exactly one port — that one. The SDK doesn't expose the shell's OS pid, so we
  // go via the port; then rescan so the Ports tab drops it.
  new MirrorChannel(session, relay, terminalManager, {
    onTerminalKill: (terminalId) => {
      const owned = descendantPids(process.pid);
      const hosted = discoverPorts().filter((p) => p.pid !== undefined && owned.has(p.pid));
      const pid = killTargetPid(terminalManager.getTerminal(terminalId)?.port, hosted);
      if (pid !== undefined) {
        killProcessTree(pid);
        setTimeout(() => tunnel.rescanPorts(), 1000); // let it die, then refresh Ports
      }
      terminalManager.setExited(terminalId, -1);
    },
  }).start();

  // On shutdown, kill everything Claude spawned under us so it doesn't orphan and
  // hold ports (Ctrl+C, kill). Without this `npm run dev` etc. survive bedcoder.
  // We kill our whole process subtree (not pidfiles): the SDK runs background
  // Bash itself and ignores our command rewrite, so pidfiles are never written.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const killed = killDescendants(process.pid);
    log('shutdown', { signal, killed });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const qr = await renderQr(encodeQrPayload({ relayUrl: config.relayUrl, sid, key }));

  pairing = new AgentPairing(relay, key, {
    onSAS: (s) => {
      sas = s;
      status = 'verify the SAS on your phone';
      render();
    },
    onPaired: () => {
      status = 'paired ✅';
      render();
    },
  });

  function render(): void {
    console.clear();
    console.log('🛏️  Bedcoder\n');
    console.log(`🔑 Pairing code:  ${pairing?.code ?? '…'}`);
    if (sas) console.log(`🔢 SAS (compare): ${sas}`);
    console.log('\n📱 or scan (native app):');
    console.log(qr);
    if (config.worktree) console.log(`Worktree: ${config.worktree}  (${process.cwd()})`);
    console.log(`Session: ${sid}`);
    console.log(`Relay:   ${config.relayUrl}`);
    console.log(`Status:  ${status}`);
    console.log(`Log:     ${isLogging() ? logFilePath() : 'off (--log to enable)'}`);
    console.log('\nCtrl+C to stop. Use `claude --resume` to continue on desktop.');
  }

  pairing.start();
  render();
}

main().catch((err: unknown) => {
  log('fatal', { err: String(err) });
  console.error(err);
  process.exit(1);
});
