# bedcoder

Drive [Claude Code](https://bedcoder.org) from your phone. `bedcoder` is a tiny
**headless daemon** you run next to the official `claude`: it shows a pairing
code, then relays the session to your phone — end-to-end encrypted, zero signup.

```bash
npm install -g bedcoder      # or: pnpm add -g bedcoder
```

## Usage

```bash
cd your-project
bedcoder                     # new session; prints a pairing code + QR
```

Open **https://web.bedcoder.org** on your phone, enter the code, and confirm the
6-digit SAS shown on both ends. Then send prompts, approve permissions, and read
replies from your phone. Back at your desk, `claude --resume` picks the session
right back up.

| Flag | Meaning |
|------|---------|
| _(none)_ | New session; connects to the default relay `wss://relay.bedcoder.org`. |
| `--relay <wss://…>` | Use a different relay (e.g. your self-hosted one). |
| `--resume [id]` | Continue this project's latest `~/.claude` session (or a specific id). |
| `--rewind-code` | Enable file checkpointing so `/rewind` can restore code. Off by default — it uses git "shadow repos" and needs git + a normal, writable repo; on setups without that it can stall the agent. Conversation rewind works regardless. |
| `--fake` | Echo engine — pair & test the channel without Claude auth. |
| `--log [path]` | Write a diagnostics log (off by default). Defaults to `~/.bedcoder/agent.log`; pass a path to override. |

Real Claude sessions need Claude auth: run `claude` once to log in, or set
`ANTHROPIC_API_KEY`. The relay is end-to-end encrypted and never sees your
content or keys; you can self-host it (single Go binary) — see the project docs.

### Platform support

macOS and Linux are first-class. On **Windows, run the agent inside WSL2** — it's
the supported path today (zero changes; `claude` + `bedcoder` share WSL's
`~/.claude`). Native Windows is partially supported. See
[`docs/WINDOWS.md`](../docs/WINDOWS.md).

### Diagnostics log

Logging is **off by default**. Run with `--log` to record a JSON-lines trace of
the session (engine lifecycle, status changes, messages in/out) — useful when
reporting a bug:

```bash
bedcoder --log                       # → ~/.bedcoder/agent.log
bedcoder --log /tmp/bedcoder.log      # → custom path
```

The active path is printed in the daemon's `Log:` status line. To keep with the
zero-knowledge design the log records only **shapes and lengths** — event tags,
message types, and field sizes — never message text, prompts, or keys.

Equivalent env var (handy for tests / CI): `BEDCODER_LOG=<path>` enables it,
`BEDCODER_LOG=off` force-disables it (and overrides `--log`).

License: GPL-3.0-or-later.
