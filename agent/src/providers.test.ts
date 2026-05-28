import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_IDS,
  applyProviderEnv,
  envFallbackKey,
  isProviderId,
} from './providers';

describe('PROVIDERS catalog', () => {
  it('has the expected ids in stable menu order', () => {
    expect(PROVIDER_IDS).toEqual(['claude', 'minimax', 'glm', 'deepseek', 'openrouter']);
    for (const id of PROVIDER_IDS) expect(PROVIDERS[id]?.id).toBe(id);
  });

  it('claude has no baseUrl and no key requirement', () => {
    const c = PROVIDERS.claude;
    expect(c.baseUrl).toBeUndefined();
    expect(c.needsKey).toBe(false);
    expect(c.modelMap).toBeUndefined();
  });

  it('non-claude providers all use ANTHROPIC_AUTH_TOKEN and have a baseUrl', () => {
    for (const id of PROVIDER_IDS) {
      if (id === 'claude') continue;
      const p = PROVIDERS[id];
      expect(p.needsKey).toBe(true);
      expect(p.keyEnvName).toBe('ANTHROPIC_AUTH_TOKEN');
      expect(p.baseUrl).toMatch(/^https:\/\//);
    }
  });

  // GLM intentionally omits modelMap (server-side mapping); MiniMax/DeepSeek set it.
  it('minimax and deepseek have a modelMap; glm does not', () => {
    expect(PROVIDERS.minimax.modelMap).toBeDefined();
    expect(PROVIDERS.deepseek.modelMap).toBeDefined();
    expect(PROVIDERS.glm.modelMap).toBeUndefined();
  });
});

describe('isProviderId', () => {
  it('accepts known ids', () => {
    for (const id of PROVIDER_IDS) expect(isProviderId(id)).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isProviderId('anthropic')).toBe(false);
    expect(isProviderId('')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId(123)).toBe(false);
    expect(isProviderId({})).toBe(false);
  });
});

describe('applyProviderEnv', () => {
  it('claude with no key is a no-op (preserves existing auth env)', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'pre-existing' };
    applyProviderEnv(PROVIDERS.claude, undefined, env);
    expect(env.ANTHROPIC_API_KEY).toBe('pre-existing');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('claude with explicit key sets ANTHROPIC_API_KEY and clears AUTH_TOKEN', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: 'stale-glm-key' };
    applyProviderEnv(PROVIDERS.claude, 'sk-anthropic', env);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('glm sets base URL, AUTH_TOKEN, and timeout — and clears API_KEY, but no model env (Z.AI auto-maps)', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'stale-anthropic-key' };
    applyProviderEnv(PROVIDERS.glm, 'glm-test-key', env);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-test-key');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Intentionally NOT set — Z.AI's server-side mapping picks the right model
    // for the user's Coding Plan tier and auto-updates with new GLM releases.
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    expect(env.API_TIMEOUT_MS).toBe('3000000');
  });

  it('minimax sets the disable-nonessential-traffic env', () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderEnv(PROVIDERS.minimax, 'mm-key', env);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.minimaxi.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('mm-key');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.API_TIMEOUT_MS).toBe('3000000');
  });

  it('deepseek sets CLAUDE_CODE_EFFORT_LEVEL=max', () => {
    const env: NodeJS.ProcessEnv = {};
    applyProviderEnv(PROVIDERS.deepseek, 'ds-key', env);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('openrouter sets base + AUTH_TOKEN + anthropic/* model defaults and clears API_KEY', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'real-anthropic-key' };
    applyProviderEnv(PROVIDERS.openrouter, 'sk-or-v1-test', env);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://openrouter.ai/api');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or-v1-test');
    // Must NOT leave a real Anthropic key around — OpenRouter docs explicitly
    // warn it'll shadow the AUTH_TOKEN and the CLI will try to call Anthropic.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('anthropic/claude-opus-4');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('anthropic/claude-sonnet-4');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('anthropic/claude-haiku-4-5');
  });

  it('does not write the key when apiKey is empty string or undefined', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'pre' };
    // Empty string: still apply other env (base, extra), don't touch key envs.
    applyProviderEnv(PROVIDERS.glm, '', env);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('pre'); // not cleared since we didn't set anything
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });
});

describe('envFallbackKey', () => {
  it('returns the <PROVIDER>_API_KEY env when set', () => {
    expect(envFallbackKey('glm', { GLM_API_KEY: 'env-glm' })).toBe('env-glm');
    expect(envFallbackKey('minimax', { MINIMAX_API_KEY: 'env-mm' })).toBe('env-mm');
    expect(envFallbackKey('deepseek', { DEEPSEEK_API_KEY: 'env-ds' })).toBe('env-ds');
  });

  it('returns undefined when env not set or empty', () => {
    expect(envFallbackKey('glm', {})).toBeUndefined();
    expect(envFallbackKey('glm', { GLM_API_KEY: '' })).toBeUndefined();
  });

  it('returns undefined for claude (no key managed by us)', () => {
    expect(envFallbackKey('claude', { CLAUDE_API_KEY: 'irrelevant' })).toBeUndefined();
  });
});
