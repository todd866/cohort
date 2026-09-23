import type { RotationDailyTarget } from './rotation-daily-target';
import { DAILY_FEED_RELEARN } from './relearn-profile';

export interface NoveltyBudget {
  minFirstSightItems: number;
  remainingFirstSight: number;
  remainingTotal: number;
}

export interface NoveltyProgressSnapshot {
  totalTarget: number | null;
  todayTotal: number;
  firstSightTarget: number | null;
  todayFirstSight: number;
  /**
   * Servable cards and questions in this rotation the learner has not yet
   * answered. While this is above zero, a met daily first-sight quota must
   * not hand the rest of the day to the repeat queue.
   */
  unseenRemaining?: number;
}

/**
 * Translate today's hybrid goals into a minimum for this batch.
 *
 * Protected relearn and due seats are removed first. While the rotation still
 * has unseen items, every remaining seat is a first sight. Once that pool is
 * empty, the discretionary remainder catches first-sight pace up relative to
 * total pace, and a met quota leaves the seats for review.
 */
export function computeNoveltyBudget(input: {
  batchSize: number;
  protectedSeats: number;
  totalTarget: number | null;
  todayTotal: number;
  firstSightTarget: number | null;
  todayFirstSight: number;
  newOnly: boolean;
  /**
   * Unseen servable items still in this rotation. When set above zero, every
   * discretionary seat is reserved for a first sight. Protected relearn and
   * due seats are already removed from `available`.
   */
  unseenRemaining?: number;
}): NoveltyBudget {
  const available = Math.max(
    0,
    Math.floor(input.batchSize) - Math.max(0, Math.floor(input.protectedSeats)),
  );
  const remainingTotal = Math.max(
    0,
    Math.floor((input.totalTarget ?? 0) - input.todayTotal),
  );
  const remainingFirstSight = Math.max(
    0,
    Math.floor((input.firstSightTarget ?? 0) - input.todayFirstSight),
  );

  if (input.newOnly) {
    return { minFirstSightItems: available, remainingFirstSight, remainingTotal };
  }
  if (available === 0) {
    return { minFirstSightItems: 0, remainingFirstSight, remainingTotal };
  }
  // A met daily quota used to zero this reservation, and the cached repeat
  // queue then spent the rest of the day on the same weak clusters. Unseen
  // supply still in the rotation takes those seats instead.
  if ((input.unseenRemaining ?? 0) > 0) {
    return {
      minFirstSightItems: available,
      remainingFirstSight,
      remainingTotal,
    };
  }
  if (remainingFirstSight === 0) {
    return { minFirstSightItems: 0, remainingFirstSight, remainingTotal };
  }

  const outstanding = Math.max(remainingTotal, remainingFirstSight, 1);
  const share = Math.min(1, remainingFirstSight / outstanding);
  return {
    minFirstSightItems: Math.min(
      available,
      remainingFirstSight,
      Math.ceil(available * share),
    ),
    remainingFirstSight,
    remainingTotal,
  };
}

/**
 * The daily-target fields that decide first-sight seats, mapped once so the
 * live request and the background queue build cannot read them differently.
 */
export function noveltyProgressFromDailyTarget(
  target: Pick<RotationDailyTarget, 'dailyTarget' | 'todayReviewed' | 'firstSightTarget' | 'todayFirstSight'> & {
    coverage?: Pick<RotationDailyTarget['coverage'], 'total' | 'seen'> | null;
  },
): NoveltyProgressSnapshot {
  return {
    totalTarget: target.dailyTarget,
    todayTotal: target.todayReviewed,
    firstSightTarget: target.firstSightTarget,
    todayFirstSight: target.todayFirstSight,
    unseenRemaining: Math.max(
      0,
      (target.coverage?.total ?? 0) - (target.coverage?.seen ?? 0),
    ),
  };
}

/**
 * The most seats the live manifold build can pin ahead of its scheduler in one
 * batch: the relearn reserve (`reserveRatio` of the batch, at least one) plus
 * one due-backlog seat. It pins fewer when either lane has nothing waiting.
 * Mirrors `protectedRelearnSeats` and `protectedDueSeats` in
 * unified-session-manifold.ts.
 */
export function protectedReviewSeatCeiling(batchSize: number, reserveRatio: number): number {
  const size = Math.max(0, Math.floor(batchSize));
  if (size === 0) return 0;
  const relearnSeats = Math.min(size, Math.max(1, Math.floor(size * reserveRatio)));
  const dueSeats = relearnSeats < size ? 1 : 0;
  return relearnSeats + dueSeats;
}

/**
 * First-sight seats for a queue served in several client batches.
 *
 * The live build pins relearn and due cards before it asks the scheduler for
 * first sights, so its reservation never displaces them. A background-built
 * queue has no pinned prefix, so it leaves that same room in every batch it
 * will be served as and lets the scheduler fill it. Where nothing is due, the
 * scheduler's only candidates for those seats are unseen cards and questions,
 * so the room goes to novelty anyway.
 */
export function queueNoveltyBudget(input: {
  queueSize: number;
  servedBatchSize: number;
  progress: NoveltyProgressSnapshot;
  reserveRatio?: number;
}): NoveltyBudget {
  const queueSize = Math.max(0, Math.floor(input.queueSize));
  const servedBatchSize = Math.max(1, Math.floor(input.servedBatchSize));
  const batches = Math.ceil(queueSize / servedBatchSize);
  const protectedSeats = Math.min(
    queueSize,
    batches * protectedReviewSeatCeiling(
      servedBatchSize,
      input.reserveRatio ?? DAILY_FEED_RELEARN.reserveRatio,
    ),
  );
  return computeNoveltyBudget({
    batchSize: queueSize,
    protectedSeats,
    totalTarget: input.progress.totalTarget,
    todayTotal: input.progress.todayTotal,
    firstSightTarget: input.progress.firstSightTarget,
    todayFirstSight: input.progress.todayFirstSight,
    unseenRemaining: input.progress.unseenRemaining,
    newOnly: false,
  });
}
