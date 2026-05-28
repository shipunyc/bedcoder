import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readConfig,
  writeConfig,
  savedApiKey,
  setApiKey,
  setDefaultProvider,
  type BedcoderConfig,
} from './providers_config';

describe('providers_config', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bedcoder-cfg-'));
    path = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readConfig', () => {
    it('returns empty config when file is missing', () => {
      expect(readConfig(path)).toEqual({});
    });

    it('returns empty config when JSON is malformed', () => {
      writeFileSync(path, '{not valid', 'utf-8');
      expect(readConfig(path)).toEqual({});
    });

    it('drops unknown provider ids and non-string apiKeys', () => {
      writeFileSync(
        path,
        JSON.stringify({
          defaultProvider: 'bogus',
          providers: {
            glm: { apiKey: 'real-key' },
            anthropic: { apiKey: 'wrong-id-drop' },
            minimax: { apiKey: 42 }, // non-string
          },
        }),
        'utf-8',
      );
      const cfg = readConfig(path);
      expect(cfg.defaultProvider).toBeUndefined();
      expect(cfg.providers?.glm?.apiKey).toBe('real-key');
      expect((cfg.providers as Record<string, unknown>).anthropic).toBeUndefined();
      // minimax entry exists but apiKey is dropped (non-string)
      expect(cfg.providers?.minimax).toEqual({});
    });

    it('round-trips a valid config', () => {
      const cfg: BedcoderConfig = {
        defaultProvider: 'glm',
        providers: { glm: { apiKey: 'k1' }, deepseek: { apiKey: 'k2' } },
      };
      writeConfig(cfg, path);
      expect(readConfig(path)).toEqual(cfg);
    });
  });

  describe('writeConfig', () => {
    it('creates the parent directory if missing', () => {
      const nested = join(dir, 'nested', 'sub', 'config.json');
      writeConfig({ defaultProvider: 'claude' }, nested);
      expect(JSON.parse(readFileSync(nested, 'utf-8'))).toEqual({ defaultProvider: 'claude' });
    });

    it('writes atomically (no .tmp left on success)', () => {
      writeConfig({ defaultProvider: 'glm' }, path);
      const tmpName = `${path}.tmp.${process.pid}`;
      expect(() => statSync(tmpName)).toThrow();
    });

    if (process.platform !== 'win32') {
      it('chmods the file to 0600 on POSIX', () => {
        writeConfig({ defaultProvider: 'glm' }, path);
        const mode = statSync(path).mode & 0o777;
        expect(mode).toBe(0o600);
      });
    }
  });

  describe('helpers', () => {
    it('savedApiKey returns the key for the given provider', () => {
      const cfg: BedcoderConfig = { providers: { glm: { apiKey: 'k' } } };
      expect(savedApiKey(cfg, 'glm')).toBe('k');
      expect(savedApiKey(cfg, 'deepseek')).toBeUndefined();
      expect(savedApiKey({}, 'glm')).toBeUndefined();
    });

    it('setDefaultProvider returns a new config with the new default', () => {
      const cfg: BedcoderConfig = { defaultProvider: 'claude' };
      const next = setDefaultProvider(cfg, 'glm');
      expect(next.defaultProvider).toBe('glm');
      expect(cfg.defaultProvider).toBe('claude'); // immutable
    });

    it('setApiKey adds the key without dropping existing providers', () => {
      const cfg: BedcoderConfig = { providers: { glm: { apiKey: 'a' } } };
      const next = setApiKey(cfg, 'deepseek', 'b');
      expect(next.providers?.glm?.apiKey).toBe('a');
      expect(next.providers?.deepseek?.apiKey).toBe('b');
    });

    it('setApiKey overwrites an existing key for the same provider', () => {
      const cfg: BedcoderConfig = { providers: { glm: { apiKey: 'old' } } };
      const next = setApiKey(cfg, 'glm', 'new');
      expect(next.providers?.glm?.apiKey).toBe('new');
    });
  });
});
