// On-disk cache for provider selection at `~/.bedcoder/config.json`. Stores the
// last-used provider (so the menu can pre-select it on Enter) and the API key
// for each non-Anthropic provider (so the user only enters it once).
//
// File contains secrets, so on POSIX systems we chmod 0600 on every write.
// Windows relies on the per-user profile directory ACLs (already restricted to
// the owner).
//
// Writes are atomic (tmp file + rename) so a crash mid-write can't leave a
// partial JSON behind — readConfig would then fail to parse and clobber the
// user's saved keys.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isProviderId, type ProviderId } from './providers';
import { log } from './log';

export interface BedcoderConfig {
  defaultProvider?: ProviderId;
  providers?: Partial<Record<ProviderId, { apiKey?: string }>>;
}

const CONFIG_DIR = join(homedir(), '.bedcoder');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// Read + validate. Any failure (missing file, bad JSON, wrong shape) returns
// an empty config — callers treat it as "no saved state" and prompt the user.
// We never want a corrupt config to prevent bedcoder from starting.
export function readConfig(path: string = CONFIG_PATH): BedcoderConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log('config.read.parse_failed', { err: String(err) });
    return {};
  }

  return sanitizeConfig(parsed);
}

// Defensive validator: any unrecognised provider key is dropped, any non-string
// apiKey is dropped. We never throw — the worst we do is downgrade to {}.
function sanitizeConfig(input: unknown): BedcoderConfig {
  if (!input || typeof input !== 'object') return {};
  const obj = input as Record<string, unknown>;
  const out: BedcoderConfig = {};

  if (isProviderId(obj.defaultProvider)) out.defaultProvider = obj.defaultProvider;

  if (obj.providers && typeof obj.providers === 'object') {
    const providers: BedcoderConfig['providers'] = {};
    for (const [k, v] of Object.entries(obj.providers as Record<string, unknown>)) {
      if (!isProviderId(k)) continue;
      if (!v || typeof v !== 'object') continue;
      const entry = v as Record<string, unknown>;
      const key = typeof entry.apiKey === 'string' ? entry.apiKey : undefined;
      providers[k] = key !== undefined ? { apiKey: key } : {};
    }
    if (Object.keys(providers).length > 0) out.providers = providers;
  }

  return out;
}

// Atomic write: tmp + rename in the same dir (rename is atomic when both paths
// are on the same filesystem). chmod 0600 on POSIX so other local users can't
// read the saved keys; no-op on Windows.
export function writeConfig(cfg: BedcoderConfig, path: string = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
  if (process.platform !== 'win32') {
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      log('config.write.chmod_failed', { err: String(err) });
    }
  }
  renameSync(tmp, path);
}

// Convenience helpers used by provider_select.ts.

export function savedApiKey(cfg: BedcoderConfig, id: ProviderId): string | undefined {
  return cfg.providers?.[id]?.apiKey;
}

export function setDefaultProvider(cfg: BedcoderConfig, id: ProviderId): BedcoderConfig {
  return { ...cfg, defaultProvider: id };
}

export function setApiKey(cfg: BedcoderConfig, id: ProviderId, apiKey: string): BedcoderConfig {
  const providers = { ...(cfg.providers ?? {}) };
  providers[id] = { apiKey };
  return { ...cfg, providers };
}
