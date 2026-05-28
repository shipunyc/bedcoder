// Multi-provider backend support. Claude Code's CLI accepts any
// Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL` plus an auth env;
// MiniMax / Z.AI (GLM) / DeepSeek all expose such endpoints. We pick a
// provider at startup and inject the right env vars before the SDK spawns
// its CLI subprocess — the child inherits them automatically.
//
// This module is pure: catalog + a function that mutates an env bag. All
// interactive UX lives in provider_select.ts.

export type ProviderId = 'claude' | 'minimax' | 'glm' | 'deepseek' | 'openrouter';

export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'minimax', 'glm', 'deepseek', 'openrouter'] as const;

export interface ProviderSpec {
  id: ProviderId;
  // Display label for the interactive menu.
  label: string;
  // false for `claude` — it reuses the user's existing `claude login` token
  // or pre-set ANTHROPIC_API_KEY, so bedcoder doesn't need to manage it.
  needsKey: boolean;
  // Anthropic uses ANTHROPIC_API_KEY. MiniMax / GLM / DeepSeek all want
  // ANTHROPIC_AUTH_TOKEN (Anthropic-compatible proxies that distinguish their
  // own static keys from a real Anthropic key).
  keyEnvName: 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';
  // Override the upstream API. Undefined for `claude` (default endpoint).
  baseUrl?: string;
  // Per-tier model id. CLI maps opus/sonnet/haiku tier requests to these
  // ids via ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL.
  modelMap?: { opus: string; sonnet: string; haiku: string };
  // Misc required env (API_TIMEOUT_MS, CLAUDE_CODE_EFFORT_LEVEL, etc.).
  extraEnv?: Record<string, string>;
  // Where the user goes to mint a key. Shown in the prompt when needed.
  keyHelpUrl?: string;
}

// NOTE: model ids are pulled from each vendor's claude-code integration doc.
// They change as vendors rev models; revisit on each bedcoder release.
//   MiniMax:  https://platform.minimaxi.com/docs/token-plan/claude-code
//   GLM:      https://docs.z.ai/devpack/tool/claude
//   DeepSeek: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic — uses `claude login` or ANTHROPIC_API_KEY)',
    needsKey: false,
    keyEnvName: 'ANTHROPIC_API_KEY',
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax (MiniMax-M2.7)',
    needsKey: true,
    keyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    modelMap: { opus: 'MiniMax-M2.7', sonnet: 'MiniMax-M2.7', haiku: 'MiniMax-M2.7' },
    extraEnv: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    keyHelpUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  glm: {
    id: 'glm',
    label: 'GLM (Z.AI)',
    needsKey: true,
    keyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'https://api.z.ai/api/anthropic',
    // No modelMap on purpose — Z.AI's docs FAQ explicitly recommends NOT
    // hardcoding ANTHROPIC_DEFAULT_*_MODEL because their server-side mapping
    // auto-updates when they ship a new GLM (e.g. GLM-5 → GLM-5.1 → GLM-6),
    // and it respects the user's GLM Coding Plan tier. Hardcoding would lock
    // bedcoder users to whatever was current when this version shipped.
    // If a user wants a specific model, --model X passes it through.
    extraEnv: { API_TIMEOUT_MS: '3000000' },
    keyHelpUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    needsKey: true,
    keyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'https://api.deepseek.com/anthropic',
    modelMap: { opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' },
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    keyHelpUrl: 'https://platform.deepseek.com/api_keys',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (any model — Claude/GPT/Llama/…)',
    needsKey: true,
    keyEnvName: 'ANTHROPIC_AUTH_TOKEN',
    baseUrl: 'https://openrouter.ai/api',
    // OpenRouter routes hundreds of models, identified by `provider/model`.
    // Default to the Anthropic family so bedcoder behaves like vanilla Claude
    // out of the box; users who want gpt-4o / llama / etc. pass --model.
    modelMap: {
      opus: 'anthropic/claude-opus-4',
      sonnet: 'anthropic/claude-sonnet-4',
      haiku: 'anthropic/claude-haiku-4-5',
    },
    keyHelpUrl: 'https://openrouter.ai/keys',
  },
};

export function isProviderId(x: unknown): x is ProviderId {
  return typeof x === 'string' && (PROVIDER_IDS as readonly string[]).includes(x);
}

// Apply the provider's env vars onto the given bag (defaults to process.env).
// For `claude` this is a no-op when no key is supplied — we leave whatever was
// already set (claude login token, pre-set ANTHROPIC_API_KEY) alone.
//
// When a key IS supplied (any provider), we set keyEnvName to it. For non-
// claude providers we ALSO clear the other auth env (so a leftover real
// ANTHROPIC_API_KEY can't shadow the provider's AUTH_TOKEN, or vice versa).
export function applyProviderEnv(
  spec: ProviderSpec,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (spec.baseUrl !== undefined) {
    env.ANTHROPIC_BASE_URL = spec.baseUrl;
  }

  if (apiKey !== undefined && apiKey !== '') {
    env[spec.keyEnvName] = apiKey;
    // Stop the OTHER auth env from shadowing ours. Both are read by the CLI
    // and behavior on collision is unspecified.
    if (spec.keyEnvName === 'ANTHROPIC_AUTH_TOKEN') delete env.ANTHROPIC_API_KEY;
    else delete env.ANTHROPIC_AUTH_TOKEN;
  }

  if (spec.modelMap) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = spec.modelMap.opus;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = spec.modelMap.sonnet;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = spec.modelMap.haiku;
  }

  if (spec.extraEnv) {
    for (const [k, v] of Object.entries(spec.extraEnv)) env[k] = v;
  }
}

// Resolve a key for the given provider from a fallback env var. Lets headless
// runs supply a key without ever hitting the cache file. Order is documented
// in provider_select.ts:
//   <PROVIDER>_API_KEY  e.g. GLM_API_KEY, MINIMAX_API_KEY, DEEPSEEK_API_KEY
// Returns undefined for `claude` (no key needed) or when the env isn't set.
export function envFallbackKey(
  id: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (id === 'claude') return undefined;
  const name = `${id.toUpperCase()}_API_KEY`;
  const v = env[name];
  return v && v !== '' ? v : undefined;
}
