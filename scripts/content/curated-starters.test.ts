import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  curatedStarterSnapshotHash,
  loadCuratedStarterManifest,
  parseCuratedStarterManifest,
  resolveCuratedStarterRows,
  type CuratedStarterCardRow,
  type CuratedStarterEntry,
} from './curated-starters';

function row(id: string, overrides: Partial<CuratedStarterCardRow> = {}): CuratedStarterCardRow {
  return {
    id,
    stableId: `stable-${id}`,
    front: `front ${id}`,
    back: `back ${id}`,
    backs: null,
    context: null,
    imageUrl: null,
    imageRole: null,
    rotation: 'cah',
    ownerUserId: null,
    deletedAt: null,
    shelvedAt: null,
    topics: ['paediatrics'],
    variantGroupId: null,
    ...overrides,
  };
}

function entry(card: CuratedStarterCardRow, overrides: Partial<CuratedStarterEntry> = {}): CuratedStarterEntry {
  if (!card.stableId) throw new Error('A curated starter fixture requires a stable ID');
  return {
    stableId: card.stableId,
    sha256: curatedStarterSnapshotHash(card),
    evidenceUrls: ['https://example.org/evidence'],
    topic: 'Reviewed topic',
    ...overrides,
  };
}

const excludedTopics = ['_needs-image', '_incomplete-data'];

describe('curated starter manifest', () => {
  it('requires the reviewed private manifest and excludes it from exported artifacts', async () => {
    const repoRoot = process.cwd();
    const privateManifestPath = path.resolve(repoRoot, 'content/curated-starters.json');
    const exportMarkerPath = path.resolve(repoRoot, 'FOSS-DISTRIBUTION-MANIFEST.json');

    if (fs.existsSync(exportMarkerPath)) {
      const exportMarker = JSON.parse(fs.readFileSync(exportMarkerPath, 'utf8')) as {
        schemaVersion?: number;
        files?: Array<{ path?: string }>;
      };
      expect(exportMarker.schemaVersion).toBe(1);
      expect(exportMarker.files?.some(file => file.path === 'content/curated-starters.json')).toBe(false);
      expect(fs.existsSync(privateManifestPath)).toBe(false);
      return;
    }

    expect(fs.existsSync(privateManifestPath)).toBe(true);
    const manifest = await loadCuratedStarterManifest(privateManifestPath);
    expect(manifest).not.toBeNull();
    expect(manifest?.schemaVersion).toBe(1);
    expect(manifest?.rotations.cah).toHaveLength(13);
    expect(manifest?.rotations.cah[0].stableId).toBe('mdx:ed08973beae939f9ad1d08516ffe05d3');
  });

  it('treats an absent manifest as the normal public/offline fallback', async () => {
    await expect(loadCuratedStarterManifest('/tmp/md3-curated-starters-absent.json')).resolves.toBeNull();
  });

  it('rejects duplicate stable IDs, invalid evidence URLs, and more than 32 entries', () => {
    const one = { stableId: 's1', sha256: 'a'.repeat(64), evidenceUrls: ['https://e.test'], topic: 'Topic' };
    expect(() => parseCuratedStarterManifest({
      schemaVersion: 1, reviewedAt: '2026-09-19', rotations: { cah: [one, one] },
    })).toThrow(/Duplicate stableId/);
    expect(() => parseCuratedStarterManifest({
      schemaVersion: 1, reviewedAt: '2026-09-19', rotations: { cah: [{ ...one, evidenceUrls: ['http://e.test'] }] },
    })).toThrow(/Invalid entry/);
    expect(() => parseCuratedStarterManifest({
      schemaVersion: 1, reviewedAt: '2026-09-19',
      rotations: { cah: Array.from({ length: 33 }, (_, index) => ({ ...one, stableId: `s${index}` })) },
    })).toThrow(/exceeds 32/);
  });
});

describe('curated starter card resolution', () => {
  it('preserves reviewed order while validating exact content snapshots', () => {
    const second = row('second', { imageUrl: '/figures/cah/example.jpg', imageRole: 'prompt', context: 'Look closely' });
    const first = row('first');
    const result = resolveCuratedStarterRows({
      rotation: 'cah',
      entries: [entry(second), entry(first)],
      rows: [first, second],
      deliverableIds: new Set(['first', 'second']),
      excludedTopics,
    });
    expect(result.map(({ row: selected }) => selected.id)).toEqual(['second', 'first']);
    expect(result[0].row.imageUrl).toBe('/figures/cah/example.jpg');
  });

  it.each([
    ['content drift', () => ({ sha256: 'f'.repeat(64) })],
    ['excluded topic', () => ({})],
  ])('fails closed for %s', (label, override) => {
    const card = row('one', label === 'excluded topic' ? { topics: ['_needs-image'] } : {});
    expect(() => resolveCuratedStarterRows({
      rotation: 'cah', entries: [entry(card, override())], rows: [card],
      deliverableIds: new Set(['one']), excludedTopics,
    })).toThrow();
  });

  it('fails for missing, private, deleted, shelved, or undeliverable rows', () => {
    const base = row('one');
    const cases = [
      { rows: [], deliverableIds: new Set(['one']) },
      { rows: [row('one', { ownerUserId: 'private-user' })], deliverableIds: new Set(['one']) },
      { rows: [row('one', { deletedAt: new Date() })], deliverableIds: new Set(['one']) },
      { rows: [row('one', { shelvedAt: new Date() })], deliverableIds: new Set(['one']) },
      { rows: [base], deliverableIds: new Set<string>() },
    ];
    for (const testCase of cases) {
      expect(() => resolveCuratedStarterRows({
        rotation: 'cah', entries: [entry(base)], ...testCase, excludedTopics,
      })).toThrow();
    }
  });

  it('rejects changes to the reviewed image caption', () => {
    const reviewed = row('image', {
      imageUrl: '/figures/cah/example.jpg', imageRole: 'prompt',
      imageCaption: 'Reviewed radiograph findings',
    });
    expect(() => resolveCuratedStarterRows({
      rotation: 'cah', entries: [entry(reviewed)],
      rows: [{ ...reviewed, imageCaption: 'Different interpretation' }],
      deliverableIds: new Set(['image']), excludedTopics,
    })).toThrow(/drift/i);
  });

  it('rejects two selected cards from one cloze variant group', () => {
    const first = row('first', { variantGroupId: 'group-1' });
    const second = row('second', { variantGroupId: 'group-1' });
    expect(() => resolveCuratedStarterRows({
      rotation: 'cah', entries: [entry(first), entry(second)], rows: [first, second],
      deliverableIds: new Set(['first', 'second']), excludedTopics,
    })).toThrow(/Duplicate variant group/);
  });
});
