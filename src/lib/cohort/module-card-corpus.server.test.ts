import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  buildCohortModuleCardCorpus,
  cohortCardContentHash,
  loadCohortModuleCardCorpus,
  selectCohortModuleCard,
  type CohortCardRow,
  type CohortServableCard,
} from './module-card-corpus.server';
import { cohortCardServingFingerprint, cohortCardServingRow } from '@/lib/content/cohort-mirror-cards';
import { loadCohortModuleCardsFromDisk, cohortCardSeedRow } from '@/lib/content/cohort-card-corpus';

const row = (n: number, over: Partial<CohortCardRow> = {}): CohortCardRow => ({
  id: `row${n}`,
  stableId: `cohort:paeds:c-${String(n).padStart(12, '0')}:v1`,
  rotation: 'cohort-open',
  cardType: 'cloze',
  front: `Fact ${n} is [___].`,
  back: `a${n}`,
  context: 'Why.',
  imageUrl: null,
  imageCaption: null,
  moduleNodes: ['cohort/paeds'],
  variantGroupId: null,
  variantIndex: null,
  ...over,
});
const releaseOf = (rows: CohortCardRow[]) => ({
  schemaVersion: 1 as const,
  cardIds: rows.map((r) => r.stableId),
  cardFingerprints: Object.fromEntries(rows.map((r) => [r.stableId, cohortCardServingFingerprint(r)])),
});

describe('buildCohortModuleCardCorpus', () => {
  it('attaches C1 from the real released shard using the seeded stable id', () => {
    const loaded = loadCohortModuleCardsFromDisk();
    expect(loaded.errors).toEqual([]);
    const released = loaded.cards.find(({ card }) => card.complexity === 1 && !card.imageUrl)!;
    expect(released).toBeDefined();
    const seeded = cohortCardSeedRow(released.card, released.sourceFile);
    expect(seeded.stableId).toBe(released.card.id);
    const stored = { ...cohortCardServingRow(released.card), id: 'fixture-row' };
    const { cards } = buildCohortModuleCardCorpus([stored], releaseOf([stored]));
    expect(cards[0].complexity).toBe(1);
    expect(selectCohortModuleCard({ cards, challengeLevel: -2, progress: [],
      recentCardIds: [], recentGroups: new Set(), now: new Date() })?.card.id).toBe(stored.id);
  });

  it('serves released rows whose fingerprint matches, and refuses every other row with a reason', () => {
    const good = row(1);
    const drifted = row(2);
    const release = releaseOf([good, drifted]);
    const corpus = buildCohortModuleCardCorpus([
      good,
      { ...drifted, back: 'edited after release' },
      row(3),
      row(4, { rotation: 'cah' }),
      row(5, { imageUrl: '/figures/x.png' }),
    ], { ...release, cardFingerprints: { ...release.cardFingerprints, [row(4).stableId]: cohortCardServingFingerprint(row(4, { rotation: 'cah' })), [row(5).stableId]: cohortCardServingFingerprint(row(5, { imageUrl: '/figures/x.png' })) }, cardIds: [...release.cardIds, row(4).stableId, row(5).stableId] });
    expect(corpus.cards.map((c) => c.id)).toEqual(['row1']);
    expect(Object.fromEntries(corpus.refused.map((r) => [r.stableId.slice(-6, -3), r.reason]))).toEqual({
      '002': 'release-content-drift',
      '003': 'not-release-manifest-member',
      '004': 'not-cohort-module-row',
      '005': 'image-not-served',
    });
    expect(corpus.cards[0]).toMatchObject({ discipline: 'paeds', releaseFingerprint: release.cardFingerprints[good.stableId] });
    expect(corpus.cards[0].contentHash).toBe(cohortCardContentHash(good));
  });

  it('loads one discipline, in the cohort: namespace, live rows only', async () => {
    const findMany = vi.fn(async () => [row(1)]);
    await loadCohortModuleCardCorpus({ card: { findMany } } as never, 'paeds', releaseOf([row(1)]));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rotation: 'cohort-open', deletedAt: null, shelvedAt: null, stableId: { startsWith: 'cohort:paeds:c-' } },
    }));
  });
});

describe('selectCohortModuleCard', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const cards: CohortServableCard[] = [1, 2, 3, 4].map((n) => ({
    id: `row${n}`, stableId: `cohort:paeds:c-${String(n).padStart(12, '0')}:v1`, discipline: 'paeds',
    front: `F${n} [___]`, back: `b${n}`, context: null, variantGroupId: n >= 3 ? 'g' : null,
    releaseFingerprint: 'f', contentHash: 'h',
  }));

  it('serves the most overdue card first, then the first unseen one', () => {
    const progress = [
      { cardId: 'row1', nextDueAt: new Date('2026-10-01T00:00:00Z') },
      { cardId: 'row2', nextDueAt: new Date('2026-09-30T00:00:00Z') },
    ];
    expect(selectCohortModuleCard({ cards, progress, recentCardIds: [], recentGroups: new Set(), now })).toEqual({ card: cards[1], reason: 'due' });
    const notDue = progress.map((p) => ({ ...p, nextDueAt: new Date('2026-10-05T00:00:00Z') }));
    expect(selectCohortModuleCard({ cards, progress: notDue, recentCardIds: [], recentGroups: new Set(), now })).toEqual({ card: cards[2], reason: 'new' });
  });

  it('in a module smaller than the hold-back window, holds back only the card just served', () => {
    const two = cards.slice(0, 2);
    const seen = two.map((c) => ({ cardId: c.id, nextDueAt: new Date('2026-09-01T00:00:00Z') }));
    // Both were served recently; the most recent (row2) is held back, row1 comes round.
    expect(selectCohortModuleCard({ cards: two, progress: seen, recentCardIds: ['row2', 'row1'], recentGroups: new Set(), now })?.card.id).toBe('row1');
    expect(selectCohortModuleCard({ cards: [two[0]], progress: seen.slice(0, 1), recentCardIds: ['row1'], recentGroups: new Set(), now })).toBeNull();
  });

  it('never repeats a card just served or a sibling of one', () => {
    const notDue = cards.slice(0, 2).map((c) => ({ cardId: c.id, nextDueAt: new Date('2026-10-05T00:00:00Z') }));
    expect(selectCohortModuleCard({ cards, progress: notDue, recentCardIds: ['row3'], recentGroups: new Set(['g']), now })).toBeNull();
    expect(selectCohortModuleCard({ cards, progress: [{ cardId: 'row1', nextDueAt: new Date(0) }], recentCardIds: ['row1'], recentGroups: new Set(), now })?.card.id).toBe('row2');
  });
});

describe('selectCohortModuleCard media-family safety', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const familyCards: CohortServableCard[] = [1, 2, 3, 4].map((n) => ({
    id: `row${n}`, stableId: `cohort:paeds:c-${String(n).padStart(12, '0')}:v1`, discipline: 'paeds',
    front: `F${n} [___]`, back: `b${n}`, context: null, variantGroupId: null, releaseFingerprint: 'f', contentHash: 'h',
  }));

  it('holds back a reviewed media family from a prior journey while preserving text alternatives', () => {
    const mediaCards = familyCards.slice(0, 3);
    const textCard = familyCards[3];
    const result = selectCohortModuleCard({
      cards: [...mediaCards, textCard], progress: [], recentCardIds: [], recentGroups: new Set(), now,
      recentMediaFamilies: new Set(['ocular-diagram']),
      mediaFamilyForCard: (card) => card.id === textCard.id ? null : 'ocular-diagram',
    });
    expect(result).toEqual({ card: textCard, reason: 'new' });
  });

  it('does not loop when every remaining card belongs to the recently served figure family', () => {
    const result = selectCohortModuleCard({
      cards: familyCards.slice(0, 3), progress: [], recentCardIds: ['row2'], recentGroups: new Set(), now,
      recentMediaFamilies: new Set(['ocular-diagram']),
      mediaFamilyForCard: () => 'ocular-diagram',
    });
    expect(result).toBeNull();
  });

  it('keeps due-before-new ordering among media families that are still eligible', () => {
    const result = selectCohortModuleCard({
      cards: familyCards, progress: [{ cardId: 'row1', nextDueAt: new Date('2026-09-01T00:00:00Z') }], recentCardIds: [], recentGroups: new Set(), now,
      recentMediaFamilies: new Set(['ocular-diagram']),
      mediaFamilyForCard: (card) => card.id === 'row1' || card.id === 'row2' ? 'ocular-diagram' : null,
    });
    expect(result).toEqual({ card: familyCards[2], reason: 'new' });
  });

});
