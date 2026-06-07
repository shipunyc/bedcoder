# 🛏️ Bedcoder

> **Drive Claude Code from your phone — in bed.** A mobile-first remote control for AI coding agents — works with Claude, MiniMax, GLM, DeepSeek, or any model on OpenRouter.

Use the official `claude` at your desk. When you want to lie down, start `bedcoder` next to it —
a tiny headless daemon that **end-to-end encrypts** the Agent SDK message stream and relays it to
your phone through a **zero-knowledge relay**. It reuses your `~/.claude` session, so desktop ↔ phone
hand off with context intact.

> Bedcoder is **not** a replacement for `claude` — it runs beside it. The desktop terminal only shows a
> pairing code + QR; all interaction happens on the phone.

This repository is the **open-source core**: the **agent** (the `bedcoder` CLI), the **relay**, the
shared **protocol**, and **e2e** tests. The mobile/web client (Flutter) is maintained separately.

## Clients

| Platform | Link |
|----------|------|
| 🌐 Web | **[web.bedcoder.org](https://web.bedcoder.org)** |
| 🍎 iOS | **[App Store](https://apps.apple.com/us/app/bedcoder/id6773443099)** |
| 🤖 Android | **[Download APK](https://bedcoder-1258375119.cos.ap-shanghai.myqcloud.com/app-release.apk)** |

---

## How it works

```
  phone (web/app)  ⇄ wss ⇄   relay   ⇄ wss ⇄   bedcoder (agent)        next to:
                            (Go, ZK)                ├─ Agent SDK query()   claude (official TUI)
                                                    ├─ HTTP port preview   ↑ shares ~/.claude/
                                                    ├─ filesystem RPC
                                                    └─ terminal mirror
```

- The relay only ever parses the **outer envelope** (routing); the payload is end-to-end encrypted and
  opaque to it.
- **Pairing:** the agent shows an 8-char code + QR; the phone enters the code; both confirm a 6-digit
  SAS (man-in-the-middle check). No accounts, no signup.

## Repository layout

| Dir | Lang | Role |
|-----|------|------|
| `agent/` | TypeScript / Node | The `bedcoder` CLI. Wraps `@anthropic-ai/claude-agent-sdk`; forwards the session and provides port-preview, filesystem RPC, and terminal mirror. |
| `relay/` | Go | Zero-knowledge WebSocket router + WebRTC signaling. Single static binary, embedded SQLite (pure-Go, no CGO). |
| `protocol/` | TypeScript (Zod) | Shared wire types — the Envelope + per-channel payloads. Bundled into the agent. |
| `e2e/` | TypeScript (vitest) | Integration tests across agent + relay + protocol. |

## Quick start

Install the CLI and run it in your project (uses the public relay at `wss://relay.bedcoder.org` by default):

```bash
npm i -g bedcoder
bedcoder                 # new session — prints a pairing code + QR
# or take over an existing ~/.claude session:
bedcoder --resume
```

Then open the **[web client](https://web.bedcoder.org)** (or the [iOS](https://apps.apple.com/us/app/bedcoder/id6773443099)
/ [Android](https://bedcoder-1258375119.cos.ap-shanghai.myqcloud.com/app-release.apk) app), enter the
code, confirm the SAS — and code from your phone. Back at the desk, `claude --resume` picks the same
session right up.

### AI providers

On first launch bedcoder prompts for a backend; the choice is cached so subsequent launches reuse it.
Skip the menu with a flag:

```bash
bedcoder --claude       # Anthropic (uses `claude login` or ANTHROPIC_API_KEY)
bedcoder --minimax      # MiniMax-M2.7
bedcoder --glm          # GLM (Z.AI)
bedcoder --deepseek     # DeepSeek
bedcoder --openrouter   # any model on OpenRouter (Claude / GPT / Llama / …)
```

Non-Anthropic providers ask for an API key once and cache it in `~/.bedcoder/config.json` (mode 0600).
For headless / CI use, set the env var instead: `MINIMAX_API_KEY`, `GLM_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`.

| Provider | Where to get a key |
|----------|--------------------|
| Claude (Anthropic) | `claude login`, or https://console.anthropic.com/settings/keys |
| MiniMax | https://platform.minimaxi.com/user-center/basic-information/interface-key |
| GLM (Z.AI) | https://z.ai/manage-apikey/apikey-list |
| DeepSeek | https://platform.deepseek.com/api_keys |
| OpenRouter | https://openrouter.ai/keys |

Pin a specific model with `--model <id>` (use the provider's native model ID — e.g.
`claude-opus-4-7`, `glm-5.1`, `deepseek-v4-pro`, `openai/gpt-4o`, `meta-llama/llama-3.1-405b-instruct`).
To route opus / sonnet / haiku tiers to different non-Anthropic models, export
`ANTHROPIC_DEFAULT_OPUS_MODEL` / `…_SONNET_MODEL` / `…_HAIKU_MODEL` directly.

### Agent CLI flags

```
--claude / --minimax / --glm / --deepseek / --openrouter
                     skip the provider menu
--resume [id]        continue an existing ~/.claude session (latest, or a specific id)
--relay <url>        relay URL (default wss://relay.bedcoder.org)
--model <id>         pin a model (provider's native model ID)
--models-url <url>   model catalog JSON (or env BEDCODER_MODELS_URL)
--worktree <name>    run inside .worktrees/<name> — parallel tasks on one repo
--tunnel [auto|p1,p2] port-discovery hint for the preview tab (preview is always on)
--rewind-code        enable SDK file checkpointing so /rewind can restore code (opt-in)
--log [path]         write a diagnostics log (default ~/.bedcoder/agent.log)
--skip-version-check skip the startup SDK ↔ claude CLI compatibility check
--fake               run a fake engine (no provider auth) — for development
```

## Self-hosting the relay

```bash
cd relay
CGO_ENABLED=0 go build -trimpath -o bedcoder-relay ./cmd/relay
BEDCODER_ADDR=:8787 ./bedcoder-relay
```

…or use the included `Dockerfile`. Point the agent at it with `bedcoder --relay wss://your-host`.

Relay environment variables:

| Var | Default | Purpose |
|-----|---------|---------|
| `BEDCODER_ADDR` | `:8787` | listen address |
| `BEDCODER_DB` | `bedcoder.db` | SQLite path (sessions table only) |
| `BEDCODER_ALLOWED_ORIGINS` | (any) | comma-separated CORS allowlist |
| `BEDCODER_VAPID_PUBLIC` / `BEDCODER_VAPID_PRIVATE` / `BEDCODER_VAPID_SUBJECT` | — | optional Web Push (VAPID); push is a no-op without them |

## Develop

Requirements: **Node ≥ 20 + pnpm 9**, **Go ≥ 1.24**.

```bash
make install      # pnpm install (protocol + agent + e2e workspace)
make test-all     # protocol + agent + relay + e2e
make lint         # eslint + tsc + gofmt + go vet
make build-agent  # bundle protocol → agent/dist/index.js
make build-relay  # static relay binary
```

## Security model

- **End-to-end encryption.** A per-session symmetric key (XSalsa20-Poly1305 / TweetNaCl) encrypts every
  payload. The key reaches the phone only via the QR (native) or an X25519 ECDH pairing (web) — never
  the relay.
- **Zero-knowledge relay.** It stores only a `sessions` row (id, timestamps, push token) — no message
  content, no history (delivered then dropped), no keys. There is no "user" concept: one code = one
  session = one encrypted channel.
- **MITM-resistant pairing:** commitment + 6-digit SAS comparison.
- **Filesystem sandbox.** The files channel stays within the project directory — rejecting `..` escapes,
  sensitive paths (`/etc/passwd`, `~/.ssh`), and symlink escapes.

## Session interoperability

The agent calls the SDK `query()` with a `sessionId`, so sessions land in `~/.claude/projects/...`,
shared with the official `claude` CLI. `bedcoder --resume` picks up a session created by `claude`, and
vice versa — no parallel session store.

## What's not here

The Flutter mobile/web client is not open-source yet, and we will make them public after the product
receives enough downloads. In the meantime, use the hosted clients: the
[web client](https://web.bedcoder.org), the [iOS app](https://apps.apple.com/us/app/bedcoder/id6773443099),
or the [Android APK](https://bedcoder-1258375119.cos.ap-shanghai.myqcloud.com/app-release.apk).

## License

[GPL-3.0-or-later](./LICENSE).
