import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { publicCardContentHash } from './cohort-mirror-cards';

import {
  loadCohortOriginalCardsFromDisk,
  mergeOriginalCards,
  originalCardContentHash,
  originalCardManifest,
  parseOriginalCardManifest,
  publishedOriginalCards,
  reconcileOriginalCards,
} from './cohort-original-cards';

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'md3-original-cards-'));
  roots.push(root);
  mkdirSync(path.join(root, 'anatomy'), { recursive: true });
  return root;
};
const item = (over: Record<string, unknown> = {}) => {
  const base = {
    originalId: 'lateral-rectus-cn-vi',
    front: 'The lateral rectus is supplied by [___].',
    back: 'CN VI (abducens)',
    context: 'This nerve moves the eye away from the nose.',
    complexity: 1,
    importance: 2,
    sources: [{ title: 'NCBI Extraocular Muscle Table', url: 'https://www.ncbi.nlm.nih.gov/books/NBK573075/table/article-133080.table1/' }],
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    review: {
      status: 'accepted',
      contentHash: originalCardContentHash(merged as Parameters<typeof originalCardContentHash>[0]),
      reviewer: 'anatomy-reviewer',
      reviewedAt: '2026-10-05',
    },
  };
};
const writeDeck = (root: string, value: unknown = {}, name = 'ocular.json') => writeFileSync(
  path.join(root, 'anatomy', name), JSON.stringify({
    schemaVersion: 1,
    licence: 'CC-BY-4.0',
    attribution: 'MD3 contributors',
    discipline: 'anatomy',
    items: [item(value as Record<string, unknown>)],
  }),
);

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('loadCohortOriginalCardsFromDisk', () => {
  it('fails closed when the configured source root is missing', () => {
    const root = path.join(tmpdir(), 'md3-original-cards-missing');
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.cards).toEqual([]);
    expect(result.errors.join('\n')).toContain('source root is missing');
  });


  it('validates the membership manifest and detects withdrawn ids', () => {
    const ids = new Set(['cohort:anatomy:c-aaaaaaaaaaaa:v1', 'cohort:anatomy:c-bbbbbbbbbbbb:v1']);
    const parsed = parseOriginalCardManifest(originalCardManifest([...ids]), ids);
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest?.ids).toEqual([...ids].sort());
    expect(parseOriginalCardManifest({ schemaVersion: 1, ids: ['cohort:anatomy:c-aaaaaaaaaaaa:v1', 'cohort:anatomy:c-aaaaaaaaaaaa:v1'] }, ids).errors).toContain('manifest: duplicate ids');
    expect(parseOriginalCardManifest({ schemaVersion: 1, ids: ['cohort:anatomy:c-cccccccccccc:v1'] }, ids).errors.join('\n')).toContain('absent from existing release');
    expect(parseOriginalCardManifest({ schemaVersion: 1, ids: [...ids], extra: true }, ids).errors).toContain('manifest: unexpected field extra');
  });

  it('loads a reviewed card with a deterministic public origin and primary source', () => {
    const root = makeRoot();
    writeDeck(root);
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.errors).toEqual([]);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      originalId: 'lateral-rectus-cn-vi',
      sourceFile: 'open-content/modules/original-cards/anatomy/ocular.json',
      card: {
        id: expect.stringMatching(/^cohort:anatomy:c-[0-9a-f]{12}:v1$/),
        origin: expect.stringMatching(/^md3:[0-9a-f]{16}$/),
        reference: { title: 'NCBI Extraocular Muscle Table', publisher: null },
      },
    });
  });


  it('withholds an original matching the existing review deny-list', () => {
    const root = makeRoot();
    writeDeck(root);
    const card = loadCohortOriginalCardsFromDisk({ root }).cards[0].card;
    const reviews = { [card.id]: { verdict: 'needs-fix', contentHash: publicCardContentHash(card), reviewer: 'reviewer', reviewedAt: '2026-10-05' } } as const;
    const cleared = publishedOriginalCards([card], reviews);
    expect(cleared).toEqual([]);
    expect(reconcileOriginalCards([card], [card.id], cleared)).toEqual([]);
  });

  it('keeps origin and public id stable when wording changes', () => {
    const first = makeRoot();
    writeDeck(first);
    const second = makeRoot();
    writeDeck(second, { front: 'The lateral rectus receives motor fibres from [___].' });
    const a = loadCohortOriginalCardsFromDisk({ root: first }).cards[0].card;
    const b = loadCohortOriginalCardsFromDisk({ root: second }).cards[0].card;
    expect(b.origin).toBe(a.origin);
    expect(b.id).toBe(a.id);
  });

  it('fails closed on unknown fields, bad hash and a credential-bearing URL', () => {
    const root = makeRoot();
    writeDeck(root, { imageUrl: 'https://example.invalid/x.png' });
    const raw = JSON.parse(readFileSync(path.join(root, 'anatomy/ocular.json'), 'utf8'));
    raw.items[0].review.contentHash = '0'.repeat(64);
    raw.items[0].sources[0].url = 'https://user:password@example.com/source';
    writeFileSync(path.join(root, 'anatomy/ocular.json'), JSON.stringify(raw));
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.cards).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/unexpected field imageUrl|does not match authored content|credentials/);
  });


  it('merges by public id, lets originals replace stale copies, and is idempotent', () => {
    const root = makeRoot();
    writeDeck(root);
    const original = loadCohortOriginalCardsFromDisk({ root }).cards[0].card;
    const stale = { ...original, back: 'stale copy' };
    const merged = mergeOriginalCards([stale], [original]);
    expect(merged).toEqual([original]);
    expect(mergeOriginalCards(merged, [original])).toEqual(merged);
  });


  it('removes a prior original when the current source set no longer contains it', () => {
    const root = makeRoot();
    writeDeck(root);
    const oldCard = loadCohortOriginalCardsFromDisk({ root }).cards[0].card;
    const retained = { ...oldCard, id: 'cohort:anatomy:c-cccccccccccc:v1' };
    expect(reconcileOriginalCards([oldCard, retained], [oldCard.id], [])).toEqual([retained]);
  });

  it('rejects duplicate original ids and returns no partial cards', () => {
    const root = makeRoot();
    const deck = { schemaVersion: 1, licence: 'CC-BY-4.0', attribution: 'MD3 contributors', discipline: 'anatomy', items: [item(), item({ front: 'A changed wording [___].' })] };
    writeFileSync(path.join(root, 'anatomy/duplicates.json'), JSON.stringify(deck));
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.cards).toEqual([]);
    expect(result.errors.join('\n')).toContain('duplicate original card anatomy:lateral-rectus-cn-vi');
  });

  it('rejects invalid HTTPS URLs and nested directories instead of silently skipping them', () => {
    const root = makeRoot();
    writeDeck(root, { });
    const raw = JSON.parse(readFileSync(path.join(root, 'anatomy/ocular.json'), 'utf8'));
    raw.items[0].sources[0].url = 'https://?';
    writeFileSync(path.join(root, 'anatomy/ocular.json'), JSON.stringify(raw));
    mkdirSync(path.join(root, 'anatomy', 'nested'), { recursive: true });
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.cards).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/https URL|unexpected non-JSON/);
  });

  it('rejects invalid JSON and unknown files instead of silently skipping them', () => {
    const root = makeRoot();
    writeDeck(root);
    writeFileSync(path.join(root, 'anatomy/broken.json'), '{');
    writeFileSync(path.join(root, 'anatomy/notes.txt'), 'draft');
    const result = loadCohortOriginalCardsFromDisk({ root });
    expect(result.cards).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/invalid JSON|unexpected non-JSON/);
  });
});
