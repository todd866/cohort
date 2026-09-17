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
import { sessionCandidateItemWhere } from '@/lib/knowledge/session-candidate-scope';
import { MAX_CROSS_SOURCE_ITEMS_PER_SESSION } from '@/lib/knowledge/cross-source-cap';
import type { prisma } from '@/lib/prisma';
import { getStudyDayStart } from '@/lib/study-day';
import { DAILY_FEED_RELEARN, type RelearnProfile } from './relearn-profile';
import {
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';

/** A failed card may not resurface until this long after the failure. */
export const RELEARN_COOLDOWN_MS = 10 * 60 * 1000;
/**
 * Max times a card may be re-served by this lane per day (anti-loop).
 *
 * Counts GRADES: `CardProgress.viewsToday` is only advanced by
 * `record-card-review.ts`. It is therefore blind to a delivery the user never
 * answered — see `RELEARN_DELIVERY_CAP` for the guard that closes that hole.
 */
export const RELEARN_VIEW_CAP = 2;
/**
 * A relearn card may not be re-DELIVERED until this long after its last
 * delivery, whether or not the user graded it.
 */
export const RELEARN_SERVE_COOLDOWN_MS = 10 * 60 * 1000;
/** Max times this lane may DELIVER a card per study day, graded or not. */
export const RELEARN_DELIVERY_CAP = 2;

export interface RelearnDelivery {
  cardId: string;
  deliveredAt: Date;
}

/**
 * Drop relearn candidates the user has already been shown, whether or not they
 * answered.
 *
 * WHY THIS EXISTS. The lane's only anti-loop guards were `RELEARN_COOLDOWN_MS`
 * (measured from `lastReview`) and `RELEARN_VIEW_CAP` (`viewsToday`) — and BOTH
 * of those advance only when a card is graded. A relearn card that is delivered
 * at the head of the batch and then skipped therefore leaves no trace the lane
 * can see, so the next request re-picks the same card, at rank 0, forever.
 * Observed on 2026-08-17: one card led six consecutive manifold batches over 46
 * minutes with zero grades against it.
 *
 * Deliveries come from the `ServeDecision` rows the manifold lane already loads
 * for its exclusion state, so this costs no extra query on the request path.
 */
export function capRelearnCardsByDelivery(
  relearnCardIds: string[],
  deliveries: readonly RelearnDelivery[],
  options: { now: Date; studyDayStart: Date; profile?: RelearnProfile },
): string[] {
  if (relearnCardIds.length === 0) return relearnCardIds;

  const { now, studyDayStart, profile = DAILY_FEED_RELEARN } = options;
  const cooldownCutoffMs = now.getTime() - profile.serveCooldownMs;
  const dayStartMs = studyDayStart.getTime();

  const deliveredToday = new Map<string, { count: number; lastMs: number }>();
  for (const delivery of deliveries) {
    const deliveredMs = delivery.deliveredAt.getTime();
    if (deliveredMs < dayStartMs) continue;
    const existing = deliveredToday.get(delivery.cardId);
    if (existing) {
      existing.count += 1;
      if (deliveredMs > existing.lastMs) existing.lastMs = deliveredMs;
    } else {
      deliveredToday.set(delivery.cardId, { count: 1, lastMs: deliveredMs });
    }
  }

  return relearnCardIds.filter((cardId) => {
    const seen = deliveredToday.get(cardId);
    if (!seen) return true;
    if (seen.count >= profile.deliveryCap) return false;
    return seen.lastMs <= cooldownCutoffMs;
  });
}
/** Fraction of a batch reserved for relearn cards when any are eligible. */
export const RELEARN_RESERVE_RATIO = 0.25;

export type RelearnPrisma = Pick<typeof prisma, 'cardProgress'>;

export interface FetchRelearnOptions {
  userId: string;
  rotation: string;
  /** Server-authorized external source partitions eligible for this objective. */
  allowedCrossSourceRotations?: readonly string[];
  weekFilter: number | null;
  limit: number;
  now: Date;
  /**
   * How hard this session drills. Defaults to the daily feed; a topic-scoped
   * session passes the hammer profile. See relearn-profile.ts.
   */
  profile?: RelearnProfile;
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
  const {
    userId,
    rotation,
    allowedCrossSourceRotations = [],
    weekFilter,
    limit,
    now,
    profile = DAILY_FEED_RELEARN,
  } = options;
  if (limit <= 0) return [];

  const startOfDay = getStudyDayStart(now);
  const cooldownCutoff = new Date(now.getTime() - profile.cooldownMs);
  const sourceRotations = [...new Set(
    allowedCrossSourceRotations.filter(
      (sourceRotation) => sourceRotation !== rotation,
    ),
  )];

  const loadPartition = async (
    cardScope: ReturnType<typeof sessionCandidateItemWhere> & {
      rotation?: { in: string[] };
    },
    take: number,
  ) => prisma.cardProgress.findMany({
    where: scopedCardProgressWhere(
      ownerPrivateOrSharedCardScope(userId),
      {
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
              { viewsToday: { lt: profile.viewCap } },
            ],
          },
        ],
      },
      {
        ...cardScope,
        deletedAt: null,
        shelvedAt: null,
        ...(weekFilter !== null ? { week: weekFilter } : {}),
      },
    ),
    orderBy: { lastReview: 'asc' },
    take,
    select: { card: { select: { id: true } } },
  });

  // Native lapses get first claim on the lane. Source rows are a bounded fill,
  // not a shared pre-limit prefix: otherwise a source-heavy imported history
  // can consume the reserve and then be dropped by the aggregate egress cap.
  const nativeRows = await loadPartition(
    sessionCandidateItemWhere(rotation),
    limit,
  );
  const boundedNativeRows = nativeRows.slice(0, limit);
  const sourceLimit = Math.min(
    MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
    Math.max(0, limit - boundedNativeRows.length),
  );
  const sourceRows = sourceRotations.length > 0 && sourceLimit > 0
    ? await loadPartition(
      {
        ...sessionCandidateItemWhere(rotation, sourceRotations),
        rotation: { in: sourceRotations },
      },
      sourceLimit,
    )
    : [];

  return [
    ...boundedNativeRows,
    ...sourceRows.slice(0, sourceLimit),
  ].map((row) => row.card.id);
}

export interface SelectRelearnReserveOptions {
  conceptItems: UnifiedSessionItem[];
  /** Ids of cards eligible for relearn, most-urgent first. */
  relearnCardIds: string[];
  batchSize: number;
  rotation?: string;
}

function relearnItem(id: string, rotation?: string): UnifiedSessionItem {
  return {
    type: 'card',
    id,
    rotation,
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
  const { conceptItems, relearnCardIds, batchSize, rotation } = options;
  if (relearnCardIds.length === 0) return conceptItems;

  const conceptCardIds = new Set(
    conceptItems.filter((i) => i.type === 'card').map((i) => i.id),
  );
  const fresh = relearnCardIds.filter((id) => !conceptCardIds.has(id));
  if (fresh.length === 0) return conceptItems;

  const reserve = Math.min(fresh.length, Math.max(1, Math.floor(batchSize * RELEARN_RESERVE_RATIO)));
  const relearnItems = fresh.slice(0, reserve).map((id) => relearnItem(id, rotation));
  const keptConcept = conceptItems.slice(0, Math.max(0, batchSize - relearnItems.length));

  return [...relearnItems, ...keptConcept];
}

export interface AppendRelearnOptions {
  batchSize: number;
  userId: string;
  rotation: string;
  /** Server-authorized external source partitions eligible for this objective. */
  allowedCrossSourceRotations?: readonly string[];
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
  const {
    batchSize,
    userId,
    rotation,
    allowedCrossSourceRotations = [],
    weekFilter,
    now,
  } = options;

  const relearnCardIds = await fetchRelearnCards(prisma, {
    userId,
    rotation,
    allowedCrossSourceRotations,
    weekFilter,
    // Over-fetch past the reserve so concept-pick overlap can't starve the lane.
    limit: batchSize,
    now,
  });

  return selectRelearnReserve({ conceptItems, relearnCardIds, batchSize, rotation });
}
