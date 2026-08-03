/**
 * Due-backlog lane.
 *
 * The unified scheduler is concept-driven: it serves items attached to
 * concepts that need work before the exam, NOT by per-card `nextDueAt`. For a
 * heavy user on an under-conceptualised rotation, this strands the spaced-
 * repetition backlog — cards can be weeks overdue yet never served, and the
 * session reports "you've reviewed all available cards" while reviews pile up.
 *
 * This lane backfills a session with genuinely-overdue review cards (most
 * overdue first) whenever the concept-driven pool under-fills the requested
 * batch. It is additive: when the concept scheduler already fills the batch,
 * this contributes nothing.
 */

import type { prisma } from '@/lib/prisma';
import type { UnifiedSessionItem } from '@/lib/knowledge/unified-scheduler';

export interface DueBacklogCard {
  id: string;
  nextDueAt: Date;
}

/** The slice of the app Prisma client this module needs — injected for testability. */
export type DueBacklogPrisma = Pick<typeof prisma, 'cardProgress'>;

export interface FetchDueBacklogOptions {
  userId: string;
  rotation: string;
  weekFilter: number | null;
  /** Card ids already selected / recently seen / open-issue — never re-serve. */
  excludeIds: Set<string>;
  limit: number;
  now: Date;
}

/**
 * Fetch the user's genuinely-overdue, servable review cards for a rotation,
 * most overdue first. Mirrors the servable-card predicate used by the bulk
 * candidate loader (suppressed / flagged / retired / leech gates) so the
 * backlog lane can never resurrect a card the scheduler intentionally hides.
 *
 * Requires `lastReview: { not: null }` — rows that exist but were never graded
 * (created on serve, default `nextDueAt` in the past) are *new* content, not a
 * review backlog, and must not masquerade as due reviews here.
 */
export async function fetchDueBacklogCards(
  prisma: DueBacklogPrisma,
  options: FetchDueBacklogOptions,
): Promise<DueBacklogCard[]> {
  const { userId, rotation, weekFilter, excludeIds, limit, now } = options;
  if (limit <= 0) return [];

  const rows = await prisma.cardProgress.findMany({
    where: {
      userId,
      nextDueAt: { lte: now },
      lastReview: { not: null },
      suppressed: false,
      flagged: false,
      status: { notIn: ['retired'] },
      OR: [
        { leechSuppressedUntil: null },
        { leechSuppressedUntil: { lt: now } },
      ],
      card: {
        rotation,
        deletedAt: null,
        shelvedAt: null,
        ...(weekFilter !== null ? { week: weekFilter } : {}),
        ...(excludeIds.size > 0 ? { id: { notIn: [...excludeIds] } } : {}),
      },
    },
    orderBy: { nextDueAt: 'asc' },
    take: limit,
    select: { nextDueAt: true, card: { select: { id: true } } },
  });

  return rows.map((row) => ({ id: row.card.id, nextDueAt: row.nextDueAt }));
}

export interface AppendDueBacklogOptions {
  batchSize: number;
  userId: string;
  rotation: string;
  weekFilter: number | null;
  /** Recent (24h) + client + open-issue card ids already excluded by the scheduler. */
  excludedCardIds: Set<string>;
  now: Date;
}

/**
 * If the concept-driven `items` under-fill `batchSize`, backfill the remaining
 * slots with the user's most-overdue review cards. Returns `items` unchanged
 * (and skips the DB entirely) when the batch is already full.
 *
 * The backlog cards are excluded from anything already chosen this batch and
 * from the scheduler's existing exclusion set, so a card is never duplicated
 * or resurrected after suppression.
 */
export async function appendDueBacklog(
  prisma: DueBacklogPrisma,
  items: UnifiedSessionItem[],
  options: AppendDueBacklogOptions,
): Promise<UnifiedSessionItem[]> {
  const { batchSize, userId, rotation, weekFilter, excludedCardIds, now } = options;
  if (items.length >= batchSize) return items;

  // Anything already chosen this batch, plus the scheduler's recent/client/
  // open-issue excludes — the backlog must avoid all of them.
  const exclude = new Set(excludedCardIds);
  for (const item of items) {
    if (item.type === 'card') exclude.add(item.id);
  }

  const dueCards = await fetchDueBacklogCards(prisma, {
    userId,
    rotation,
    weekFilter,
    excludeIds: exclude,
    limit: batchSize,
    now,
  });

  const fill = selectDueBacklogFill({
    currentCount: items.length,
    targetSize: batchSize,
    dueCards,
    excludeIds: exclude,
  });
  if (fill.length === 0) return items;

  const backlogItems: UnifiedSessionItem[] = fill.map((card) => ({
    type: 'card',
    id: card.id,
    conceptId: '',
    conceptName: '',
    priority: 0.5,
    interventionReason: 'needs_retest',
  }));

  return [...items, ...backlogItems];
}

export interface SelectDueBacklogFillOptions {
  /** Items already chosen by the concept scheduler for this batch. */
  currentCount: number;
  /** Requested batch size. */
  targetSize: number;
  /** Candidate overdue cards (any order — sorted here). */
  dueCards: DueBacklogCard[];
  /** Card ids already selected, recently seen, or otherwise excluded. */
  excludeIds: Set<string>;
}

/**
 * Choose which overdue cards should fill the unused slots of a batch.
 * Returns at most `targetSize - currentCount` cards, most overdue first,
 * skipping anything in `excludeIds`.
 */
export function selectDueBacklogFill(
  options: SelectDueBacklogFillOptions,
): DueBacklogCard[] {
  const { currentCount, targetSize, dueCards, excludeIds } = options;
  const openSlots = targetSize - currentCount;
  if (openSlots <= 0) return [];

  return dueCards
    .filter((c) => !excludeIds.has(c.id))
    .sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime())
    .slice(0, openSlots);
}
