// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as owner from '../../src/lib/offline/owner';
import * as promptPolicy from '../../src/lib/figures/prompt-policy';
import * as deadline from '../../src/lib/fetch-with-deadline';

const policy = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'foss/distribution-policy.json'), 'utf8')) as {
  generatedTextFiles: Array<{ path: string; text: string }>;
  excludeFiles: string[];
};
function generatedSource(file: string): string {
  const source = policy.generatedTextFiles.find(entry => entry.path === file)?.text;
  if (source === undefined) throw new Error(`Missing public rewrite: ${file}`);
  return source;
}
function evaluate<T>(file: string, imports: Record<string, unknown> = {}): T {
  const output = ts.transpileModule(generatedSource(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)((name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected generated-runtime import: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports as T;
}

let figures: typeof import('../../src/lib/offline/figures');
let store: Map<string, Response>;
beforeEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.clear(); owner.clearOfflineOwner(); owner.bindVerifiedOfflineOwner('public-owner');
  store = new Map();
  vi.stubGlobal('caches', {
    open: vi.fn(async () => ({
      match: async (key: string) => store.get(key)?.clone(),
      put: async (key: string, response: Response) => { store.set(key, response.clone()); },
      keys: async () => [...store.keys()].map(key => ({ url: new URL(key, 'https://md3.info').href })),
    })),
    delete: vi.fn(async () => { store.clear(); return true; }),
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('open image bytes', { headers: { 'content-type': 'image/png' } })));
  figures = evaluate('src/lib/offline/figures.ts', {
    '@/lib/fetch-with-deadline': deadline, './owner': owner, '@/lib/figures/prompt-policy': promptPolicy,
    './image-key': evaluate('src/lib/offline/image-key.ts'),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the generated public offline-media runtime', () => {
  it('collects primary, alternative and reveal open-media keys without admitting private or remote URLs', () => {
    expect(figures.figureKeysForItems([{ imageUrl: '/open-media/primary.png',
      imageMeta: { revealImageKey: '/open-media/reveal.png' }, imageAlternatives: [
        { imageKey: '/open-media/alternate.png' }, { imageKey: '/figures/private.png' },
        { imageKey: 'https://third-party.invalid/a.png' }, { imageKey: '/open-media/../secret.png' },
      ] }])).toEqual(['/open-media/primary.png', '/open-media/reveal.png', '/open-media/alternate.png']);
    expect(figures.hasRequiredFigures({ type: 'card', imageRole: null, imageKey: '/open-media/optional.png' }, new Set())).toBe(true);
    expect(figures.hasRequiredFigures({ type: 'question', imageRole: 'prompt', imageKey: '/open-media/prompt.png',
      imageMeta: { revealImageKey: '/open-media/reveal.png' } }, new Set(['/open-media/prompt.png']))).toBe(false);
  });

  it('stores open bytes directly for the current owner and reuses them without a delivery route', async () => {
    const keys = ['/open-media/primary.png', '/open-media/alternate.png'];
    const first = await figures.ensureFiguresCached([...keys, keys[0], '/figures/private.png'], 'public-owner');
    expect(first.newlyCached).toBe(2); expect([...first.availableKeys]).toEqual(keys);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(keys);
    expect((await figures.ensureFiguresCached(keys, 'public-owner')).newlyCached).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await figures.countCachedFigures('public-owner')).toBe(2);
    await expect(figures.readFigureReadiness([{ type: 'card', imageKey: keys[0], imageAlternatives: [{ imageKey: keys[1] }] }], 'public-owner'))
      .resolves.toMatchObject({ available: true, total: 2, cached: 2, missing: 0, requiredMissingItems: 0 });
    await expect(figures.readCachedFigure('/figures/private.png')).resolves.toBeNull();
    expect(generatedSource('src/lib/offline/figures.ts')).not.toContain('/api/figures/delivery');
  });

  it('keeps unsupported URLs missing and never reports an uncached supplementary alternative as ready', async () => {
    await figures.ensureFiguresCached(['/open-media/primary.png'], 'public-owner');
    const readiness = await figures.readFigureReadiness([{ type: 'card', imageKey: '/open-media/primary.png', imageAlternatives: [
      { imageKey: '/open-media/missing.png' }, { imageKey: 'https://third-party.invalid/a.png' },
    ] }], 'public-owner');
    expect(readiness).toMatchObject({ total: 3, cached: 1, missing: 2, requiredMissingItems: 0, unsupported: 1 });
  });

  it('does not retain late bytes after the device owner changes', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = figures.ensureFiguresCached(['/open-media/late.png'], 'public-owner');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    owner.bindVerifiedOfflineOwner('other-owner');
    finish(new Response('late', { headers: { 'content-type': 'image/png' } }));
    expect((await pending).availableKeys.size).toBe(0);
    expect(store.size).toBe(0);
  });

  it('rejects non-image responses and keeps bulk refill and private associations omitted', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>Not an image</html>', { headers: { 'content-type': 'text/html' } }));
    expect((await figures.ensureFiguresCached(['/open-media/bad.png'], 'public-owner')).availableKeys.size).toBe(0);
    expect(store.size).toBe(0);
    const fill = evaluate<typeof import('../../src/lib/offline/fill')>('src/lib/offline/fill.ts');
    expect(fill.needsRefill(null, Date.now())).toBe(false);
    await expect(fill.fillOfflinePack('public-owner')).resolves.toMatchObject({ filled: false, figuresCached: 0 });
    const registry = evaluate<typeof import('../../src/lib/figures/original-image-alternatives')>('src/lib/figures/original-image-alternatives.ts');
    expect(registry.getOriginalImageAlternatives({ type: 'card', id: 'not-exported' })).toEqual([]);
    expect(policy.excludeFiles).toContain('src/lib/figures/original-image-alternatives.ts');
  });
});
