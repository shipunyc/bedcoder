import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseCatalog, fetchModelCatalog, FALLBACK_CATALOG } from './models';

describe('parseCatalog', () => {
  it('parses a valid catalog', () => {
    const c = parseCatalog(
      JSON.stringify({ default: 'm2', models: [{ id: 'm1', label: 'One' }, { id: 'm2', label: 'Two', detail: 'd' }] }),
    );
    expect(c.default).toBe('m2');
    expect(c.models).toEqual([{ id: 'm1', label: 'One' }, { id: 'm2', label: 'Two', detail: 'd' }]);
  });

  it('defaults to the first model id when default is missing', () => {
    expect(parseCatalog(JSON.stringify({ models: [{ id: 'm1', label: 'One' }] })).default).toBe('m1');
  });

  it('falls back on garbage / empty / malformed', () => {
    expect(parseCatalog('not json')).toBe(FALLBACK_CATALOG);
    expect(parseCatalog(JSON.stringify({ models: [] }))).toBe(FALLBACK_CATALOG);
    expect(parseCatalog(JSON.stringify({ models: [{ id: 'x' }] }))).toBe(FALLBACK_CATALOG); // no label → skipped → empty
  });
});

describe('fetchModelCatalog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ default: 'm1', models: [{ id: 'm1', label: 'One' }] }) })),
    );
    expect((await fetchModelCatalog('http://x')).default).toBe('m1');
  });

  it('falls back on a non-ok response or a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })));
    expect(await fetchModelCatalog('http://x')).toBe(FALLBACK_CATALOG);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchModelCatalog('http://x')).toBe(FALLBACK_CATALOG);
  });
});
