import { describe, it, expect } from 'vitest';
import { nodeSocketFactory } from './ws-factory';

describe('nodeSocketFactory', () => {
  it('handles a connection error without crashing the process', async () => {
    // Port 1 refuses/fails to connect → ws emits 'error' then 'close'. Without an
    // 'error' listener this would throw an uncaught exception and crash the daemon.
    const socket = nodeSocketFactory('ws://127.0.0.1:1');
    const closed = await new Promise<boolean>((resolve) => {
      socket.onClose(() => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true); // error was handled and surfaced as a close
  });
});
