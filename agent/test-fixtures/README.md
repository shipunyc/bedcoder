# MCP test fixtures

Tools for reproducing and verifying the **hung-MCP-tool freeze** fix.

Background: the `claude` CLI's default `MCP_TOOL_TIMEOUT` is ~1e8 ms (≈27 h),
effectively infinite. If an MCP tool never returns, the SDK awaits its result
forever, so no `result` message is emitted, the engine stays in "thinking", and
the phone shows the timer until the user hits Abort.

Two-layer fix:

1. **Backstop** — the agent defaults `MCP_TOOL_TIMEOUT` to `600000` (10 min) at
   boot (`src/index.ts`). A genuinely stuck call eventually fails with an error
   tool_result and the turn recovers on its own. It is a hard wall-clock cap, so
   it's kept high to avoid false-killing a legit slow tool; override via env.
2. **Stall watchdog** — `claude-engine.ts` watches for a running turn that goes
   `STALL_WARN_MS` (60 s) with no SDK message while a tool is in flight (and no
   permission is pending), and pushes a non-destructive `info` notice naming the
   tool so the user can tell "stuck" from "slow" and Abort by hand — long before
   the 10-min backstop.

## `mcp-test-server.mjs`

A zero-dependency stdio MCP server. Tools:

- `ping` — returns "pong" immediately (sanity check)
- `hang_forever` — never returns (reproduces the freeze)
- `throw_error` — returns an error result (model should recover)
- `slow_echo` — waits `seconds`, then echoes `text`

Wire it into `claude` (and therefore bedcoder) via a project `.mcp.json` or your
global `~/.claude.json`:

```json
{
  "mcpServers": {
    "test": {
      "command": "node",
      "args": ["/Users/User/bedcode/agent/test-fixtures/mcp-test-server.mjs"]
    }
  }
}
```

## `mcp-timeout-check.mjs`

Automated integration check (needs Claude auth + network):

```bash
# Verify the fix — should PASS (turn recovers in a few seconds):
MCP_TOOL_TIMEOUT=6000 node test-fixtures/mcp-timeout-check.mjs

# Observe the original bug — hangs ~30s, then FAILs:
node test-fixtures/mcp-timeout-check.mjs
```
