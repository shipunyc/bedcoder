import WebSocket from 'ws';
import type { RelaySocket, SocketFactory } from './relay';
import { log } from '../log';

// Production socket factory backed by Node `ws`. Sends a periodic ping so idle
// connections survive proxies/relay heartbeat timeouts.
export const nodeSocketFactory: SocketFactory = (url: string): RelaySocket => {
  const ws = new WebSocket(url);
  ws.binaryType = 'nodebuffer';

  // MUST handle 'error': an unhandled ws error (e.g. ENETUNREACH after the
  // machine sleeps / loses network) becomes an uncaught exception that crashes
  // the whole daemon. `ws` emits 'close' right after 'error', so RelayClient's
  // reconnect (driven by onClose) still kicks in with backoff and recovers.
  ws.on('error', (err) => log('ws.error', { msg: String(err) }));

  let pingTimer: NodeJS.Timeout | undefined;
  ws.on('open', () => {
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 20_000);
  });
  ws.on('close', () => {
    if (pingTimer) clearInterval(pingTimer);
  });

  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (d: Buffer) => cb(new Uint8Array(d))),
    onClose: (cb) => ws.on('close', () => cb()),
  };
};
