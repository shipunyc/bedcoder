import type { ModelOption } from './engine';

// The model catalog: which models the /model picker offers and which is the
// default. Served from www.bedcoder.org/models.json so new models are a JSON
// edit (no agent re-release); a baked-in copy is the offline/failure fallback.
export interface ModelCatalog {
  default: string;
  models: ModelOption[];
}

export const DEFAULT_MODELS_URL = 'https://www.bedcoder.org/models.json';

// Kept in sync with homepage/models.json; used when the fetch fails/times out.
export const FALLBACK_CATALOG: ModelCatalog = {
  default: 'claude-opus-4-7',
  models: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', detail: 'Most capable' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', detail: 'Balanced' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', detail: 'Fastest' },
  ],
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

// Parse a catalog JSON string, falling back to the baked-in catalog if it is
// missing fields or malformed (tolerant: skips bad model entries).
export function parseCatalog(json: string): ModelCatalog {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return FALLBACK_CATALOG;
  }
  const rec = asRecord(obj);
  const rawModels = Array.isArray(rec?.models) ? rec.models : [];
  const models: ModelOption[] = [];
  for (const m of rawModels) {
    const r = asRecord(m);
    if (typeof r?.id !== 'string' || typeof r?.label !== 'string') continue;
    models.push({ id: r.id, label: r.label, ...(typeof r.detail === 'string' ? { detail: r.detail } : {}) });
  }
  if (models.length === 0) return FALLBACK_CATALOG;
  const def = typeof rec?.default === 'string' ? rec.default : models[0]!.id;
  return { default: def, models };
}

// Fetch the catalog (short timeout); any failure → the baked-in fallback, so a
// slow/down homepage never blocks or breaks startup.
export async function fetchModelCatalog(url: string = DEFAULT_MODELS_URL, timeoutMs = 2000): Promise<ModelCatalog> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return FALLBACK_CATALOG;
    return parseCatalog(await res.text());
  } catch {
    return FALLBACK_CATALOG;
  } finally {
    clearTimeout(timer);
  }
}
