import { prisma } from '@/lib/prisma';
import {
  REVIEW_EVENT_TYPES,
  buildHeatmap,
  summarise,
  maturityBuckets,
  isoDay,
  type DayCount,
} from '@/lib/review-stats';

/**
 * Server-side aggregation for the review-statistics screen.
 *
 * Day bucketing happens in Postgres (`date_trunc` at a fixed timezone) rather
 * than in Node, so a user in Sydney sees their own days rather than UTC days,
 * and we never pull ~100k event rows across the wire to count them.
 */

const TZ = 'Australia/Sydney';

export interface ReviewStatsPayload {
  summary: ReturnType<typeof summarise>;
  heatmap: ReturnType<typeof buildHeatmap>;
  daily: DayCount[];
  maturity: ReturnType<typeof maturityBuckets>;
  accuracyPct: number | null;
  /** card_reviewed events with no surviving CardProgress row behind them. */
  reviewsDetached: number;
  periodLabel: string;
  firstDay: string;
  lastDay: string;
}

export async function loadReviewStats(userId: string): Promise<ReviewStatsPayload | null> {
  // One grouped query, counted in the database.
  const rows = await prisma.$queryRaw<{ day: Date; n: bigint }[]>`
    SELECT date_trunc('day', "timestamp" AT TIME ZONE ${TZ})::date AS day,
           COUNT(*)::bigint AS n
    FROM "LearningEvent"
    WHERE "userId" = ${userId}
      AND "eventType" = ANY(${[...REVIEW_EVENT_TYPES]}::text[])
    GROUP BY 1
    ORDER BY 1
  `;

  if (rows.length === 0) return null;

  const daily: DayCount[] = rows.map((r) => ({
    date: isoDay(r.day.getTime()),
    count: Number(r.n),
  }));

  const firstDay = daily[0].date;
  const lastDay = isoDay(Date.now());

  const [total, correct, cardTotal, never, under1, oneToThree, threeToSeven, sevenPlus] =
    await Promise.all([
    prisma.learningEvent.count({
      where: { userId, eventType: { in: [...REVIEW_EVENT_TYPES] } },
    }),
    prisma.learningEvent.count({
      where: { userId, eventType: { in: [...REVIEW_EVENT_TYPES] }, isCorrect: true },
    }),
    prisma.cardProgress.count({ where: { userId } }),
    prisma.cardProgress.count({ where: { userId, totalReviews: 0 } }),
    prisma.cardProgress.count({
      where: { userId, totalReviews: { gt: 0 }, stabilityDays: { lt: 1 } },
    }),
    prisma.cardProgress.count({
      where: { userId, totalReviews: { gt: 0 }, stabilityDays: { gte: 1, lt: 3 } },
    }),
    prisma.cardProgress.count({
      where: { userId, totalReviews: { gt: 0 }, stabilityDays: { gte: 3, lt: 7 } },
    }),
    prisma.cardProgress.count({
      where: { userId, totalReviews: { gt: 0 }, stabilityDays: { gte: 7 } },
    }),
  ]);

  // isCorrect is only populated for MCQs, so accuracy is reported over the rows
  // that actually carry an outcome rather than over every review.
  // How much review history is detached from any surviving CardProgress row.
  // Card ids are regenerated on content edits, so progress is orphaned and
  // stability restarts — this is why no card reaches a long interval.
  const [cardReviewEvents, progressReviewSum] = await Promise.all([
    prisma.learningEvent.count({ where: { userId, eventType: 'card_reviewed' } }),
    prisma.cardProgress.aggregate({ where: { userId }, _sum: { totalReviews: true } }),
  ]);

  const scored = await prisma.learningEvent.count({
    where: { userId, eventType: { in: [...REVIEW_EVENT_TYPES] }, isCorrect: { not: null } },
  });

  return {
    summary: summarise(daily, firstDay, lastDay),
    heatmap: buildHeatmap(daily, firstDay, lastDay),
    daily,
    maturity: maturityBuckets({
      total: cardTotal,
      neverReviewed: never,
      stabilityUnder1: under1,
      stability1to3: oneToThree,
      stability3to7: threeToSeven,
      stability7plus: sevenPlus,
    }),
    reviewsDetached: Math.max(0, cardReviewEvents - (progressReviewSum._sum.totalReviews ?? 0)),
    accuracyPct: scored > 0 ? (correct / scored) * 100 : null,
    periodLabel: `All history — ${firstDay} to ${lastDay}. ${total.toLocaleString()} answered items.`,
    firstDay,
    lastDay,
  };
}
