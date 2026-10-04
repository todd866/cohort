import { describe, expect, it, vi } from 'vitest';

import { seedCohortCardsAtomically, type CohortCardSeedClient } from './cohort-card-seed';
import { toPublicCard } from '../../src/lib/content/cohort-mirror-cards';
import type { LoadedCohortCards } from '../../src/lib/content/cohort-card-corpus';
import type { GeneratedCard } from '../../src/lib/card-generator';

const card = (n: number) => toPublicCard(
  {
    cardType: 'cloze', rotation: 'cah', week: null, sourceComponent: 'KeyPoint', topics: [], complexity: 2,
    front: `Fact ${n} is [___].`, back: `a${n}`, context: 'Why.', stableId: `mdx:${String(n).padStart(32, '0')}`,
  } as GeneratedCard & { stableId: string },
  'paeds',
  { isOpenFigure: () => false },
);
const corpus = (ns: number[]): LoadedCohortCards => ({
  files: [], errors: [], cards: ns.map((n) => ({ card: card(n), sourceFile: 'open-content/modules/cards/paeds/0.json' })),
});

function host(live: Array<{ id: string; stableId: string }>) {
  const tx = {
    $executeRawUnsafe: vi.fn(),
    card: { findMany: vi.fn(async () => live), updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { tx, host: { $transaction: async <T>(op: (t: CohortCardSeedClient) => Promise<T>) => op(tx as unknown as CohortCardSeedClient) } };
}

describe('seedCohortCardsAtomically', () => {
  it('upserts every card and sweeps only the cohort-open, cohort: namespace', async () => {
    const { tx, host: h } = host([
      { id: 'row1', stableId: card(1).id },
      { id: 'row2', stableId: card(2).id },
      { id: 'gone', stableId: 'cohort:paeds:c-ffffffffffff:v1' },
    ]);
    const upsert = vi.fn(async (_p: unknown, rows: unknown[]) => rows.length);
    const result = await seedCohortCardsAtomically(h, corpus([1, 2, 3]), { upsert: upsert as never, now: new Date(0) });
    expect(result).toEqual({ upserted: 3, retired: 1 });
    expect(tx.card.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { rotation: 'cohort-open', stableId: { startsWith: 'cohort:' }, deletedAt: null },
    }));
    expect(tx.card.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['gone'] } }, data: { deletedAt: new Date(0) } });
    const rows = upsert.mock.calls[0][1] as Array<{ rotation: string; stableId: string }>;
    expect(rows.every((r) => r.rotation === 'cohort-open' && r.stableId.startsWith('cohort:paeds:'))).toBe(true);
  });

  it('refuses to retire more than half the live module cards', async () => {
    const live = [4, 5, 6].map((n) => ({ id: `r${n}`, stableId: card(n).id }));
    const { host: h } = host(live);
    await expect(seedCohortCardsAtomically(h, corpus([1]), { upsert: (async () => 1) as never })).rejects.toThrow(/Refusing to retire 3\/3/);
  });

  it('refuses an empty or failing corpus before touching the database', async () => {
    const { tx, host: h } = host([]);
    await expect(seedCohortCardsAtomically(h, corpus([]))).rejects.toThrow(/empty/);
    await expect(seedCohortCardsAtomically(h, { ...corpus([1]), errors: ['bad'] })).rejects.toThrow(/error/);
    expect(tx.card.findMany).not.toHaveBeenCalled();
  });
});
