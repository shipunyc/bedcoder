import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { decodePairing, encodePairing } from '@bedcoder/protocol';
import { AgentClient, AppClient, hasGo, openWs, startRelay, stopRelay } from './helpers';

const PORT = 18787;
const base = `ws://localhost:${PORT}/ws`;

// These run the real Go relay binary, so they require `go` on PATH. In the
// Node-only CI job (no Go) they self-skip; locally `make test-all` runs them.
describe.skipIf(!hasGo())('relay e2e (real Go relay + protocol clients)', () => {
  let relay: ChildProcess;

  beforeAll(async () => {
    relay = await startRelay(PORT);
  }, 90_000);

  afterAll(() => {
    if (relay) stopRelay(relay);
  });

  it('terminal_flow: pairing handshake establishes a shared key and echoes', async () => {
    const agent = new AgentClient(await openWs(`${base}?role=agent&sid=S1`), 'S1');
    agent.register();

    const app = new AppClient(await openWs(`${base}?role=app`), agent.code);
    app.claim();
    await app.paired;

    expect(app.sid).toBe('S1');
    expect([...app.key!]).toEqual([...agent.key]); // K agreed across processes

    const echo = app.nextContent();
    app.sendMessage('hi');
    expect(await echo).toBe('echo: hi');
  }, 30_000);

  it('multi_session: two sessions run independently', async () => {
    const a = new AgentClient(await openWs(`${base}?role=agent&sid=A`), 'A');
    a.register();
    const b = new AgentClient(await openWs(`${base}?role=agent&sid=B`), 'B');
    b.register();

    const appA = new AppClient(await openWs(`${base}?role=app`), a.code);
    appA.claim();
    const appB = new AppClient(await openWs(`${base}?role=app`), b.code);
    appB.claim();
    await Promise.all([appA.paired, appB.paired]);

    expect(appA.sid).toBe('A');
    expect(appB.sid).toBe('B');

    const echoA = appA.nextContent();
    const echoB = appB.nextContent();
    appA.sendMessage('alpha');
    appB.sendMessage('beta');
    expect(await echoA).toBe('echo: alpha');
    expect(await echoB).toBe('echo: beta');
  }, 30_000);

  it('claim_unknown_code: relay replies with an error', async () => {
    const ws = await openWs(`${base}?role=app`);
    const error = new Promise<string>((resolve) => {
      ws.on('message', (d: Buffer) => {
        const m = decodePairing(new Uint8Array(d));
        if (m.type === 'error') resolve(m.error);
      });
    });
    ws.send(encodePairing({ type: 'claim', code: 'NOPE9999' }));
    expect(await error).toContain('no such');
  }, 30_000);
});
