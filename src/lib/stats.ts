/**
 * Daily stats utilities
 */

import { prisma } from '@/lib/prisma';

export interface DailyStreakRow {
  date: Date;
  cardsReviewed: number;
  quizzesTaken: number;
}

/**
 * Pure streak calculation shared by ordinary activity writes and identity
 * claims. Keeping the calculation pure lets a claim update the denormalized
 * User fields inside its serializable transaction instead of racing a
 * post-commit enrichment write.
 */
export function calculateStreakFromDailyStats(
  stats: DailyStreakRow[],
  now = new Date(),
) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const activeDayKeys = new Set(
    stats
      .filter((row) => row.cardsReviewed > 0 || row.quizzesTaken > 0)
      .map((row) => {
        const date = new Date(row.date);
        date.setHours(0, 0, 0, 0);
        return date.getTime();
      }),
  );

  let current = 0;
  const currentDay = new Date(today);
  while (activeDayKeys.has(currentDay.getTime())) {
    current += 1;
    currentDay.setDate(currentDay.getDate() - 1);
  }

  let longest = 0;
  for (const dayKey of activeDayKeys) {
    const previousDay = new Date(dayKey);
    previousDay.setDate(previousDay.getDate() - 1);
    if (activeDayKeys.has(previousDay.getTime())) {
      continue;
    }

    let run = 1;
    const nextDay = new Date(dayKey);
    nextDay.setDate(nextDay.getDate() + 1);
    while (activeDayKeys.has(nextDay.getTime())) {
      run += 1;
      nextDay.setDate(nextDay.getDate() + 1);
    }
    longest = Math.max(longest, run);
  }

  return { current, longest };
}

/**
 * Calculate streak from DailyStats records.
 * A day counts if user did ANY study activity (cards OR quizzes).
 * Returns { current, longest } streak counts.
 */
export async function calculateStreak(userId: string) {
  const stats = await prisma.dailyStats.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
    take: 365,
    select: { date: true, cardsReviewed: true, quizzesTaken: true },
  });

  return calculateStreakFromDailyStats(stats);
}

/**
 * Update the denormalized streak fields on the User model.
 * Should be called after any activity that contributes to DailyStats.
 */
export async function updateUserStreak(userId: string) {
  return prisma.$transaction(async (tx) => {
    // Identity claims lock the same row before moving DailyStats. Acquiring the
    // lock before this read ensures a grade enrichment that started earlier
    // cannot later overwrite the claim with a stale streak snapshot.
    await tx.$queryRaw`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `;

    const stats = await tx.dailyStats.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 365,
      select: { date: true, cardsReviewed: true, quizzesTaken: true },
    });
    const { current, longest } = calculateStreakFromDailyStats(stats);
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { longestStreak: true },
    });
    const preservedLongest = Math.max(
      longest,
      user?.longestStreak ?? 0,
    );

    await tx.user.update({
      where: { id: userId },
      data: {
        currentStreak: current,
        longestStreak: preservedLongest,
        lastActiveAt: new Date(),
      },
    });

    return { current, longest: preservedLongest };
  });
}

export async function updateDailyStats(
  userId: string,
  updates: Partial<{
    cardsReviewed: number;
    cardsCorrect: number;
    newCardsSeen: number;
    studyTimeMin: number;
    pagesViewed: number;
    quizzesTaken: number;
  }>
) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.dailyStats.upsert({
    where: {
      userId_date: {
        userId,
        date: today,
      },
    },
    create: {
      userId,
      date: today,
      ...updates,
    },
    update: {
      cardsReviewed: updates.cardsReviewed
        ? { increment: updates.cardsReviewed }
        : undefined,
      cardsCorrect: updates.cardsCorrect
        ? { increment: updates.cardsCorrect }
        : undefined,
      newCardsSeen: updates.newCardsSeen
        ? { increment: updates.newCardsSeen }
        : undefined,
      studyTimeMin: updates.studyTimeMin
        ? { increment: updates.studyTimeMin }
        : undefined,
      pagesViewed: updates.pagesViewed
        ? { increment: updates.pagesViewed }
        : undefined,
      quizzesTaken: updates.quizzesTaken
        ? { increment: updates.quizzesTaken }
        : undefined,
    },
  });

  // Update streak whenever we record study activity (cards reviewed)
  if (updates.cardsReviewed && updates.cardsReviewed > 0) {
    await updateUserStreak(userId);
  }
}

/**
 * Ensure CardProgress exists for a set of cards.
 * Called when cards are shown in a session to track "cards seen" even before review.
 * Uses createMany with skipDuplicates for efficiency.
 */
export async function ensureCardProgressExists(
  userId: string,
  cardIds: string[]
): Promise<{ created: number }> {
  if (cardIds.length === 0) return { created: 0 };

  const result = await prisma.cardProgress.createMany({
    data: cardIds.map((cardId) => ({
      userId,
      cardId,
      status: 'learning',
      // Default values - will be updated on first review
      stabilityDays: 3,
      nextDueAt: new Date(),
      totalReviews: 0,
      retrievalStrength: 0,
    })),
    skipDuplicates: true, // Don't error if progress already exists
  });

  // Track new cards seen in daily stats
  if (result.count > 0) {
    await updateDailyStats(userId, { newCardsSeen: result.count });
  }

  return { created: result.count };
}
