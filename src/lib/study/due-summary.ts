/**
 * Due Summary — "cards due today" count + new card trickle budget
 *
 * "Due" = cards the user has seen before whose memory has decayed past threshold.
 * New cards are NOT counted as due — they trickle into sessions silently.
 */

import type { ExtendedPrismaClient } from '@/lib/prisma';
import { getExamDateForUser } from '@/lib/rotations';

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
 * Rationale: exam correlation (CC KAT 2026) showed that high-volume low-accuracy
 * study (3x hours, 17x MCQs) scored lower than low-volume high-accuracy study.
 * The algorithm was allowing unlimited new content even at 9% card accuracy.
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

  const [dueCount, examDate, seenCount, totalCards] = await Promise.all([
    prisma.cardProgress.count({
      where: {
        userId,
        nextDueAt: { lte: endOfToday },
        suppressed: false,
        status: { not: 'retired' },
        card: { rotation },
      },
    }),
    getExamDateForUser(rotation, userId),
    prisma.cardProgress.count({
      where: {
        userId,
        card: { rotation, deletedAt: null, shelvedAt: null },
      },
    }),
    prisma.card.count({
      where: { rotation, deletedAt: null, shelvedAt: null },
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
