/**
 * The transactional core of `db:seed:cohort-module-cards`: upsert the released
 * Cohort module cards and soft-delete the stale ones, all or nothing.
 *
 * Scoped by construction: the stale sweep reads only `cohort-open` rows in the
 * `cohort:` stableId namespace, so it can never touch an md3 card, and the full
 * `db:seed` (which sweeps only `mdx:` cards) can never touch these.
 */
import { bulkUpsertCards } from '../../src/lib/db/bulk-upsert';
import {
  cohortCardSeedRow,
  COHORT_CARD_STABLE_ID_PREFIX,
  type LoadedCohortCards,
} from '../../src/lib/content/cohort-card-corpus';
import { COHORT_MODULE_ROTATION } from '../../src/lib/content/cohort-mirror-cards';

export interface CohortCardSeedClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  card: {
    findMany(args: {
      where: { rotation: string; stableId: { startsWith: string }; deletedAt: null };
      select: { id: true; stableId: true };
    }): Promise<Array<{ id: string; stableId: string | null }>>;
    updateMany(args: {
      where: { id: { in: string[] } };
      data: { deletedAt: Date };
    }): Promise<{ count: number }>;
  };
}

export interface CohortCardSeedHost {
  $transaction<T>(operation: (tx: CohortCardSeedClient) => Promise<T>, options: { timeout: number }): Promise<T>;
}

export async function seedCohortCardsAtomically(
  host: CohortCardSeedHost,
  corpus: LoadedCohortCards,
  options: { upsert?: typeof bulkUpsertCards; now?: Date; label?: string } = {},
): Promise<{ upserted: number; retired: number }> {
  if (corpus.errors.length > 0) throw new Error(`refusing to seed a corpus with ${corpus.errors.length} error(s)`);
  if (corpus.cards.length === 0) throw new Error('Cohort card corpus is empty; refusing to seed.');
  const upsert = options.upsert ?? bulkUpsertCards;
  const label = options.label ?? 'cohort:seed-module-cards';
  const current = new Set(corpus.cards.map(({ card }) => card.id));
  const rows = corpus.cards.map(({ card, sourceFile }) => cohortCardSeedRow(card, sourceFile));

  return host.$transaction(async (tx) => {
    const live = await tx.card.findMany({
      where: { rotation: COHORT_MODULE_ROTATION, stableId: { startsWith: COHORT_CARD_STABLE_ID_PREFIX }, deletedAt: null },
      select: { id: true, stableId: true },
    });
    const stale = live.filter((row) => !row.stableId || !current.has(row.stableId)).map((row) => row.id);
    if (live.length > 0 && stale.length / live.length > 0.5) {
      throw new Error(`[${label}] Refusing to retire ${stale.length}/${live.length} module cards in one run.`);
    }
    const upserted = await upsert(tx as never, rows, { batchSize: 500 });
    if (stale.length > 0) {
      await tx.card.updateMany({ where: { id: { in: stale } }, data: { deletedAt: options.now ?? new Date() } });
    }
    return { upserted, retired: stale.length };
  }, { timeout: 120_000 });
}
