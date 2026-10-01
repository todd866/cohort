import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildIndex,
  buildIndexForMode,
  resolveImageIndexMode,
} from './build-index';

// Sidecars are stored in md3-local figure-sidecars/ as <slug>.<ext>.json
// (the image extension is encoded in the filename so no image file is needed alongside).
function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'images-fix-'));
  // Simulate figure-sidecars/ layout at md3 repo root
  const sidecarDir = join(root, 'figure-sidecars', 'cah', 'derm');
  mkdirSync(sidecarDir, { recursive: true });
  // Sidecar: hsp.jpg.json (encodes the .jpg extension)
  writeFileSync(join(sidecarDir, 'hsp.jpg.json'), JSON.stringify({
    class: 'diagnostic', usageTier: 'public-attribution',
    source: 'DermNet NZ', sourcePage: 'https://dermnetnz.org/topics/hsp',
    directImageUrl: 'https://dermnetnz.org/i/hsp.jpg',
    license: 'CC BY-NC-ND 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    attributionText: 'Photo: DermNet NZ — CC BY-NC-ND 4.0',
    noOptimize: true, hash: 'sha256-abc',
    dimensions: { w: 800, h: 600 },
    addedBy: 'reviewer', addedAt: '2026-05-02',
    humanReviewedAt: '2026-05-02', humanReviewedBy: 'reviewer',
    sensitivityReviewStatus: 'reviewed-safe',
    sensitivityReviewedAt: '2026-05-02', sensitivityReviewedBy: 'reviewer',
    condition: 'HSP', keyFindings: ['palpable purpura'],
    modality: 'derm', altPolicy: 'generic',
  }));
  // A plain .json with no image-ext prefix — should be ignored
  writeFileSync(join(sidecarDir, 'notes.json'), '{"ignored": true}');
  return root;
}

describe('buildIndex', () => {
  it('resolves explicit offline/release modes and rejects misspellings', () => {
    expect(resolveImageIndexMode({})).toEqual({ name: 'database', requireSidecars: true });
    expect(resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'offline' }))
      .toEqual({ name: 'offline', requireSidecars: false });
    expect(resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'release' }))
      .toEqual({ name: 'release', requireSidecars: true });
    expect(() => resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'relese' }))
      .toThrow(/MD3_GENERATED_CONTENT_MODE/i);
  });

  it('writes the same empty index offline whether private sidecars exist or not', () => {
    const withSidecars = setupFixture();
    const withoutSidecars = mkdtempSync(join(tmpdir(), 'images-offline-'));
    const firstOut = join(withSidecars, 'offline.json');
    const secondOut = join(withoutSidecars, 'offline.json');
    const mode = resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'offline' });

    const first = buildIndexForMode({
      sidecarRoot: join(withSidecars, 'figure-sidecars'),
      outFile: firstOut,
    }, mode);
    const second = buildIndexForMode({
      sidecarRoot: join(withoutSidecars, 'figure-sidecars'),
      outFile: secondOut,
    }, mode);

    expect(first).toEqual({ entries: 0, sensitivityDefaults: 0, warnings: [] });
    expect(second).toEqual({ entries: 0, sensitivityDefaults: 0, warnings: [] });
    expect(readFileSync(firstOut, 'utf8')).toBe('{}\n');
    expect(readFileSync(secondOut, 'utf8')).toBe('{}\n');
  });

  it('keeps release mode strict when the sidecar source is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'images-release-'));
    const mode = resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'release' });
    expect(() => buildIndexForMode({
      sidecarRoot: join(root, 'figure-sidecars'),
      outFile: join(root, 'index.json'),
    }, mode)).toThrow(/sidecar source not found/i);
  });

  it('wires ordinary/test builds offline and every release path strict', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const isolatedBuild = readFileSync('scripts/ops/build-isolated.sh', 'utf8');
    const testPreparation = packageJson.scripts.pretest
      ?? packageJson.scripts['prefoss:test'];

    expect(packageJson.scripts.prebuild).toContain('MD3_GENERATED_CONTENT_MODE=offline');
    expect(testPreparation).toContain('MD3_GENERATED_CONTENT_MODE=offline');
    expect(packageJson.scripts.build).toContain(
      'MD3_GENERATED_CONTENT_MODE=offline node --import tsx scripts/images/build-index.ts',
    );
    expect(packageJson.scripts['build:release']).toContain(
      'MD3_GENERATED_CONTENT_MODE=release node --import tsx scripts/images/build-index.ts',
    );
    expect(isolatedBuild).toContain(
      'MD3_GENERATED_CONTENT_MODE=${MD3_GENERATED_CONTENT_MODE:-offline} '
      + 'node --import tsx scripts/images/build-index.ts',
    );
  });

  it('emits a generated module with one entry per sidecar', () => {
    const root = setupFixture();
    const out = join(root, 'out.ts');
    const stats = buildIndex({ sidecarRoot: join(root, 'figure-sidecars'), outFile: out });
    expect(stats.entries).toBe(1);
    expect(stats.warnings).toHaveLength(0);
    const contents = readFileSync(out, 'utf-8');
    expect(contents).toContain('"/figures/cah/derm/hsp.jpg"');
    expect(contents).toContain('DermNet NZ');
  });

  // The serving projection is what the session function imports at module
  // scope; the full catalog stays off the request path (2026-08-21 deepdive:
  // it was 25.9 MB of the route's synchronous cold-start weight).
  it('writes a slim serving projection alongside the full catalog', () => {
    const root = setupFixture();
    const out = join(root, 'out.json');
    const servingOut = join(root, 'serving.json');
    const stats = buildIndex({
      sidecarRoot: join(root, 'figure-sidecars'),
      outFile: out,
      servingOutFile: servingOut,
    });
    expect(stats.entries).toBe(1);

    const full = JSON.parse(readFileSync(out, 'utf8')) as Record<string, Record<string, unknown>>;
    const slim = JSON.parse(readFileSync(servingOut, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(Object.keys(slim)).toEqual(Object.keys(full));
    const entry = slim['/figures/cah/derm/hsp.jpg'];
    expect(entry.class).toBe('diagnostic');
    expect(entry.attributionText).toContain('DermNet');
    expect(entry).not.toHaveProperty('hash');
    expect(entry).not.toHaveProperty('directImageUrl');
    expect(entry).not.toHaveProperty('source');
    expect(entry).not.toHaveProperty('dimensions');
  });

  it('writes empty maps to BOTH artifacts in offline mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'images-offline-both-'));
    const out = join(root, 'offline.json');
    const servingOut = join(root, 'offline-serving.json');
    const mode = resolveImageIndexMode({ MD3_GENERATED_CONTENT_MODE: 'offline' });

    buildIndexForMode({
      sidecarRoot: join(root, 'figure-sidecars'),
      outFile: out,
      servingOutFile: servingOut,
    }, mode);

    expect(readFileSync(out, 'utf8')).toBe('{}\n');
    expect(readFileSync(servingOut, 'utf8')).toBe('{}\n');
  });

  it('keys entries by served public path, not filesystem path', () => {
    const root = setupFixture();
    const out = join(root, 'out.ts');
    buildIndex({ sidecarRoot: join(root, 'figure-sidecars'), outFile: out });
    const contents = readFileSync(out, 'utf-8');
    expect(contents).toMatch(/"\/figures\/cah\/derm\/hsp\.jpg"/);
    expect(contents).not.toContain(root);
  });

  it('ignores files without an image-extension prefix (e.g. bare notes.json)', () => {
    const root = setupFixture();
    const out = join(root, 'out.ts');
    const stats = buildIndex({ sidecarRoot: join(root, 'figure-sidecars'), outFile: out });
    const contents = readFileSync(out, 'utf-8');
    expect(contents).not.toContain('notes');
    expect(stats.entries).toBe(1);
  });

  it('throws when sidecarRoot does not exist (hard-fail — no empty stub)', () => {
    const root = mkdtempSync(join(tmpdir(), 'images-fix-'));
    const out = join(root, 'out.ts');
    // Note: root exists but figure-sidecars/ subdir does NOT
    expect(() => buildIndex({ sidecarRoot: join(root, 'figure-sidecars'), outFile: out }))
      .toThrow(/sidecar source not found/);
  });

  it('does not invent sensitivity for unmarked clinical photography', () => {
    const root = mkdtempSync(join(tmpdir(), 'images-sensitive-'));
    const sidecarRoot = join(root, 'figure-sidecars');
    mkdirSync(join(sidecarRoot, 'clinical'), { recursive: true });
    writeFileSync(join(sidecarRoot, 'clinical', 'photo.jpg.json'), JSON.stringify({
      class: 'diagnostic', modality: 'photo', sensitive: false,
      attributionText: 'clinical photo',
    }));
    writeFileSync(join(sidecarRoot, 'library.bulk.json'), JSON.stringify({
      '/figures/restricted/lake.jpg': {
        class: 'lake-reference', topic: 'unreviewed media',
        attributionText: 'restricted',
      },
      '/figures/radiology/scan.jpg': {
        class: 'diagnostic', modality: 'ct', attributionText: 'CT',
      },
      '/figures/clinical/genital.jpg': {
        class: 'diagnostic', modality: 'photo', attributionText: 'genital photo',
        sensitive: true,
      },
    }));
    const out = join(root, 'index.json');

    const stats = buildIndex({ sidecarRoot, outFile: out });
    const index = JSON.parse(readFileSync(out, 'utf8')) as Record<
      string,
      { sensitive?: boolean }
    >;

    expect(index['/figures/clinical/photo.jpg'].sensitive).toBe(false);
    expect(index['/figures/restricted/lake.jpg'].sensitive).toBeUndefined();
    expect(index['/figures/radiology/scan.jpg'].sensitive).toBeUndefined();
    expect(index['/figures/clinical/genital.jpg'].sensitive).toBe(true);
    expect(stats).toMatchObject({ entries: 4, sensitivityDefaults: 0 });
    expect(stats.warnings).toEqual([]);
  });

  it.each([
    {
      sensitivityReviewStatus: 'reviewed-safe',
      sensitivityReviewedAt: '2026-08-08',
    },
    {
      sensitive: true,
      sensitivityReviewStatus: 'reviewed-safe',
      sensitivityReviewedAt: '2026-08-08',
      sensitivityReviewedBy: 'reviewer-a',
    },
    {
      sensitivityReviewStatus: 'reviewed-safe',
      sensitivityReviewedAt: 'pending',
      sensitivityReviewedBy: 'reviewer-a',
    },
  ])('rejects malformed or contradictory explicit sensitivity metadata %#', (extra) => {
    const root = mkdtempSync(join(tmpdir(), 'images-invalid-sensitive-'));
    const sidecarRoot = join(root, 'figure-sidecars');
    mkdirSync(sidecarRoot, { recursive: true });
    writeFileSync(join(sidecarRoot, 'photo.jpg.json'), JSON.stringify({
      class: 'diagnostic', modality: 'photo', attributionText: 'photo', ...extra,
    }));

    expect(() => buildIndex({ sidecarRoot, outFile: join(root, 'index.json') }))
      .toThrow(/invalid sensitivity metadata.*photo\.jpg/is);
  });
});
