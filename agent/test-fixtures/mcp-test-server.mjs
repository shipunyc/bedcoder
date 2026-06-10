#!/usr/bin/env node
// A tiny zero-dependency MCP server (stdio transport) for testing bedcoder's
// handling of MCP tool calls — in particular the "hung tool freezes the phone"
// bug. Speaks newline-delimited JSON-RPC 2.0, the MCP stdio framing.
//
// Tools:
//   - ping          : returns "pong" immediately (sanity check)
//   - hang_forever  : never returns (reproduces the freeze before the fix; with
//                     MCP_TOOL_TIMEOUT set it fails with a timeout error instead)
//   - throw_error   : returns an error result (the model should recover)
//   - slow_echo     : waits `seconds` then echoes (test a legit slow tool)
//
// Configure it for the `claude` CLI (and therefore bedcoder) by adding to a
// project-local `.mcp.json` or your global `~/.claude.json`:
//
//   { "mcpServers": { "test": { "command": "node",
//       "args": ["/Users/User/bedcode/agent/test-fixtures/mcp-test-server.mjs"] } } }

import { stdin, stdout } from 'node:process';

function send(msg) {
  stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

const TOOLS = [
  { name: 'ping', description: 'Returns "pong" immediately.', inputSchema: { type: 'object', properties: {} } },
  { name: 'hang_forever', description: 'Never returns — used to test tool-timeout handling.', inputSchema: { type: 'object', properties: {} } },
  { name: 'throw_error', description: 'Always returns an error result.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'slow_echo',
    description: 'Waits `seconds` then echoes `text`.',
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'number' }, text: { type: 'string' } },
      required: ['text'],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'ping':
      return { content: [{ type: 'text', text: 'pong' }] };
    case 'hang_forever':
      await new Promise(() => {}); // never resolves
      return { content: [] };
    case 'throw_error':
      return { content: [{ type: 'text', text: 'boom: intentional MCP tool error' }], isError: true };
    case 'slow_echo': {
      const secs = typeof args?.seconds === 'number' ? args.seconds : 3;
      await new Promise((r) => setTimeout(r, secs * 1000));
      return { content: [{ type: 'text', text: String(args?.text ?? '') }] };
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'bedcoder-mcp-test', version: '1.0.0' },
      });
      return;
    case 'notifications/initialized':
      return; // notification: no response
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const result = await callTool(params?.name, params?.arguments);
      reply(id, result);
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(msg);
  }
});
