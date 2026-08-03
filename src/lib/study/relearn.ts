/**
 * In-session relearn lane.
 *
 * When a user fails a card, the scheduler pushes its `nextDueAt` ~a day out and
 * the card is excluded from every other serving path (concept pool, due-backlog)
 * by the 24h recent-exposure cutoff — so it vanishes for the rest of the day.
 * That is the opposite of spaced-repetition relearning, where a lapsed card
 * should resurface within minutes until it sticks.
 *
 * This lane re-serves cards failed *today*, once a short cooldown has elapsed,
 * deliberately bypassing the recent-exposure/client excludes (the whole point is
 * to re-show a card already seen this session). It is bounded by a per-day view
 * cap so a chronically-failed card cannot loop, and reserves only a small
 * fraction of each batch so it never crowds out new/weak work.
 */

import type { UnifiedSessionItem } from '@/lib/knowledge/unified-scheduler';
import type { prisma } from '@/lib/prisma';
import { getStudyDayStart } from '@/lib/study-day';

/** A failed card may not resurface until this long after the failure. */
export const RELEARN_COOLDOWN_MS = 10 * 60 * 1000;
/** Max times a card may be re-served by this lane per day (anti-loop). */
export const RELEARN_VIEW_CAP = 2;
/** Fraction of a batch reserved for relearn cards when any are eligible. */
export const RELEARN_RESERVE_RATIO = 0.25;

export type RelearnPrisma = Pick<typeof prisma, 'cardProgress'>;

export interface FetchRelearnOptions {
  userId: string;
  rotation: string;
  weekFilter: number | null;
  limit: number;
  now: Date;
}

/**
 * Fetch cards the user failed today (lastQuality ≤ 2) that have cooled down and
 * are still under the daily view cap, oldest failure first. Mirrors the
 * servable gates but — unlike every other lane — does NOT exclude recently-seen
 * or client-listed cards: re-serving an already-seen failed card is the point.
 */
export async function fetchRelearnCards(
  prisma: RelearnPrisma,
  options: FetchRelearnOptions,
): Promise<string[]> {
  const { userId, rotation, weekFilter, limit, now } = options;
  if (limit <= 0) return [];

  const startOfDay = getStudyDayStart(now);
  const cooldownCutoff = new Date(now.getTime() - RELEARN_COOLDOWN_MS);

  const rows = await prisma.cardProgress.findMany({
    where: {
      userId,
      lastReview: { gte: startOfDay, lte: cooldownCutoff },
      lastQuality: { lte: 2 },
      suppressed: false,
      flagged: false,
      status: { notIn: ['retired'] },
      AND: [
        { OR: [{ leechSuppressedUntil: null }, { leechSuppressedUntil: { lt: now } }] },
        {
          OR: [
            { viewsTodayDate: null },
            { viewsTodayDate: { lt: startOfDay } },
            { viewsToday: { lt: RELEARN_VIEW_CAP } },
          ],
        },
      ],
      card: {
        rotation,
        deletedAt: null,
        shelvedAt: null,
        ...(weekFilter !== null ? { week: weekFilter } : {}),
      },
    },
    orderBy: { lastReview: 'asc' },
    take: limit,
    select: { card: { select: { id: true } } },
  });

  return rows.map((row) => row.card.id);
}

export interface SelectRelearnReserveOptions {
  conceptItems: UnifiedSessionItem[];
  /** Ids of cards eligible for relearn, most-urgent first. */
  relearnCardIds: string[];
  batchSize: number;
}

function relearnItem(id: string): UnifiedSessionItem {
  return {
    type: 'card',
    id,
    conceptId: '',
    conceptName: '',
    priority: 0.95,
    interventionReason: 'failure_escalation',
  };
}

/**
 * Merge relearn cards into the concept-scheduler's batch, reserving up to
 * `RELEARN_RESERVE_RATIO` of the batch (at least one slot when any are
 * eligible). Relearn cards lead the batch and never duplicate a concept pick;
 * concept items are trimmed only to make room within `batchSize`.
 */
export function selectRelearnReserve(
  options: SelectRelearnReserveOptions,
): UnifiedSessionItem[] {
  const { conceptItems, relearnCardIds, batchSize } = options;
  if (relearnCardIds.length === 0) return conceptItems;

  const conceptCardIds = new Set(
    conceptItems.filter((i) => i.type === 'card').map((i) => i.id),
  );
  const fresh = relearnCardIds.filter((id) => !conceptCardIds.has(id));
  if (fresh.length === 0) return conceptItems;

  const reserve = Math.min(fresh.length, Math.max(1, Math.floor(batchSize * RELEARN_RESERVE_RATIO)));
  const relearnItems = fresh.slice(0, reserve).map(relearnItem);
  const keptConcept = conceptItems.slice(0, Math.max(0, batchSize - relearnItems.length));

  return [...relearnItems, ...keptConcept];
}

export interface AppendRelearnOptions {
  batchSize: number;
  userId: string;
  rotation: string;
  weekFilter: number | null;
  now: Date;
}

/**
 * Fetch today's cooled-down failed cards and merge them into the concept batch.
 * Always runs (failed cards must resurface even when the batch is full); a no-op
 * when nothing is eligible.
 */
export async function appendRelearnLane(
  prisma: RelearnPrisma,
  conceptItems: UnifiedSessionItem[],
  options: AppendRelearnOptions,
): Promise<UnifiedSessionItem[]> {
  const { batchSize, userId, rotation, weekFilter, now } = options;

  const relearnCardIds = await fetchRelearnCards(prisma, {
    userId,
    rotation,
    weekFilter,
    // Over-fetch past the reserve so concept-pick overlap can't starve the lane.
    limit: batchSize,
    now,
  });

  return selectRelearnReserve({ conceptItems, relearnCardIds, batchSize });
}
