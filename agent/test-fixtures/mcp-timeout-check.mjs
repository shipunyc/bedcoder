#!/usr/bin/env node
// Integration check for the "hung MCP tool freezes the phone" fix.
//
// Drives the real Agent SDK against the local stdio test server and asserts that
// a tool which never returns (`hang_forever`) does NOT hang the turn forever:
// with MCP_TOOL_TIMEOUT set, the call fails with an error tool_result and the
// turn finalizes with a `result`. Requires Claude auth (`claude login` or
// ANTHROPIC_API_KEY) + network, so it is NOT part of the unit suite.
//
// Run:  MCP_TOOL_TIMEOUT=6000 node test-fixtures/mcp-timeout-check.mjs
// (omit MCP_TOOL_TIMEOUT to observe the original bug — it will hang ~25s.)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'mcp-test-server.mjs');

let closed = false;
const pending = ["Call the test server's hang_forever tool now."];
let wake;
async function* input() {
  while (!closed) {
    const t = pending.shift();
    if (t === undefined) {
      await new Promise((r) => (wake = r));
      continue;
    }
    yield { type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: 's1' };
  }
}

const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1);
const stream = query({
  prompt: input(),
  options: {
    permissionMode: 'default',
    includePartialMessages: true,
    canUseTool: (n, i) => Promise.resolve({ behavior: 'allow', updatedInput: i }),
    mcpServers: { test: { command: 'node', args: [serverPath] } },
  },
});

const timer = setTimeout(() => {
  console.error(`[${T()}s] FAIL: no result after 30s — the turn hung (set MCP_TOOL_TIMEOUT to fix).`);
  process.exit(1);
}, 30000);

for await (const m of stream) {
  if (m.type === 'result') {
    clearTimeout(timer);
    closed = true;
    wake?.();
    console.log(`[${T()}s] PASS: turn finalized with result=${m.subtype} (no infinite hang).`);
    process.exit(0);
  }
}
