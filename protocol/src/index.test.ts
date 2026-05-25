import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION } from './index';

describe('protocol scaffold', () => {
  it('exposes protocol version 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
