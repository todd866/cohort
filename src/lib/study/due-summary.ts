/**
 * Due Summary — "cards due today" count + new card trickle budget
 *
 * "Due" = cards the user has seen before whose memory has decayed past threshold.
 * New cards are NOT counted as due — they trickle into sessions silently.
 */

import type { ExtendedPrismaClient } from '@/lib/prisma';
import { getExamDateForUser } from '@/lib/rotations';
import {
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
  scopedCardWhere,
} from '@/lib/cards/read-repository.server';

export interface DueSummary {
  due: number;
  daysToExam: number | null;
  examDate: string | null;
  coverage: { seen: number; total: number };
}

/**
 * Compute how many new cards to introduce per session based on exam proximity
 * AND rolling accuracy. When accuracy is low, throttle new cards so the student
 * consolidates existing material before expanding.
 *
 * Rationale: high-volume, low-accuracy study tends to underperform lower-volume,
 * high-accuracy study, and the algorithm was allowing unlimited new content
 * even at very low card accuracy.
 */
export function computeNewCardBudget(
  daysToExam: number | null,
  rollingAccuracy?: number | null,
): number {
  // Base budget from exam proximity
  let base: number;
  if (daysToExam === null) base = 10;
  else if (daysToExam > 60) base = 10;
  else if (daysToExam > 30) base = 15;
  else if (daysToExam > 14) base = 20;
  else if (daysToExam > 7) base = 10;
  else base = 5;

  // Accuracy gate: throttle new cards when struggling
  // This forces consolidation over expansion
  if (rollingAccuracy !== null && rollingAccuracy !== undefined) {
    if (rollingAccuracy < 0.4) return Math.min(base, 2);  // Severely struggling: near-stop
    if (rollingAccuracy < 0.6) return Math.min(base, 5);  // Struggling: half-pace
    if (rollingAccuracy < 0.75) return Math.min(base, 8); // Below target: gentle brake
  }

  return base;
}

/**
 * Count SRS-due cards for a user/rotation (cards seen before, decayed past threshold).
 */
export async function computeDueSummary(
  userId: string,
  rotation: string,
  prisma: ExtendedPrismaClient,
): Promise<DueSummary> {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const cardScope = ownerPrivateOrSharedCardScope(userId);

  const [dueCount, examDate, seenCount, totalCards] = await Promise.all([
    prisma.cardProgress.count({
      // deletedAt/shelvedAt are REQUIRED here, not optional tidiness. A card's
      // id is regenerated on any content edit, which soft-deletes the old row
      // and leaves its CardProgress pointing at a card that can never be
      // served. Counting those made the due number unclearable, and worst for
      // the longest-lived accounts: a large share of their due count could be
      // phantom work that does not exist.
      //
      // `seenCount` below already filtered these. This one did not, so the two
      // halves of the same summary disagreed about which cards were real.
      where: scopedCardProgressWhere(cardScope, {
        userId,
        nextDueAt: { lte: endOfToday },
        suppressed: false,
        status: { not: 'retired' },
      }, { rotation, deletedAt: null, shelvedAt: null }),
    }),
    getExamDateForUser(rotation, userId),
    prisma.cardProgress.count({
      where: scopedCardProgressWhere(
        cardScope,
        { userId },
        { rotation, deletedAt: null, shelvedAt: null },
      ),
    }),
    prisma.card.count({
      where: scopedCardWhere(cardScope, { rotation, deletedAt: null, shelvedAt: null }),
    }),
  ]);

  const daysToExam = examDate
    ? Math.max(0, Math.ceil((examDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : null;

  return {
    due: dueCount,
    daysToExam,
    examDate: examDate?.toISOString() ?? null,
    coverage: { seen: seenCount, total: totalCards },
  };
}
