import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  LEADERBOARD_WINDOW_DAYS,
  rankLeaderboard,
  type LeaderboardInput,
  type LeaderboardRow,
} from './leaderboard-lib';

/**
 * Loads the board for a joined viewer. One aggregate over LearningEvent for
 * every joined learner, then the pure ranking. Reads history, so it is a
 * page/route read, never a hot-path call: the review loop never touches this.
 *
 * "Reviews" means deliberate answers — card_reviewed and mcq_attempted with a
 * recorded correctness — which excludes skips exactly as the daily usage
 * table does. Days are Australia/Sydney calendar days so a streak matches
 * what the learner sees on the review calendar.
 */
const ANSWER_EVENT_TYPES = ['card_reviewed', 'mcq_attempted'];
const STREAK_LOOKBACK_DAYS = 90;

interface AggregateRow {
  userId: string;
  windowReviews: number;
  allTimeReviews: number;
  activeDays: string[] | null;
}

export async function loadLeaderboard(
  viewerId: string,
  now = new Date(),
): Promise<{ rows: LeaderboardRow[]; me: LeaderboardRow | null; joinedCount: number }> {
  const joined = await prisma.user.findMany({
    where: { leaderboardJoinedAt: { not: null }, leaderboardHandle: { not: null } },
    select: { id: true, leaderboardHandle: true },
  });
  if (joined.length === 0) return { rows: [], me: null, joinedCount: 0 };

  const ids = joined.map((u) => u.id);
  const windowStart = new Date(now.getTime() - LEADERBOARD_WINDOW_DAYS * 86_400_000);
  const streakStart = new Date(now.getTime() - STREAK_LOOKBACK_DAYS * 86_400_000);
  const aggregates = await prisma.$queryRaw<AggregateRow[]>(Prisma.sql`
    SELECT
      e."userId" AS "userId",
      COUNT(*) FILTER (WHERE e."timestamp" >= ${windowStart})::int AS "windowReviews",
      COUNT(*)::int AS "allTimeReviews",
      ARRAY(
        SELECT DISTINCT to_char((d."timestamp" AT TIME ZONE 'Australia/Sydney')::date, 'YYYY-MM-DD')
        FROM "LearningEvent" d
        WHERE d."userId" = e."userId"
          AND d."eventType" = ANY(${ANSWER_EVENT_TYPES}::text[])
          AND d."isCorrect" IS NOT NULL
          AND d."timestamp" >= ${streakStart}
      ) AS "activeDays"
    FROM "LearningEvent" e
    WHERE e."userId" = ANY(${ids}::text[])
      AND e."eventType" = ANY(${ANSWER_EVENT_TYPES}::text[])
      AND e."isCorrect" IS NOT NULL
    GROUP BY e."userId"
  `);
  const byUser = new Map(aggregates.map((row) => [row.userId, row]));
  const inputs: LeaderboardInput[] = joined.map((u) => {
    const agg = byUser.get(u.id);
    return {
      userId: u.id,
      handle: u.leaderboardHandle as string,
      windowReviews: agg?.windowReviews ?? 0,
      allTimeReviews: agg?.allTimeReviews ?? 0,
      activeDays: agg?.activeDays ?? [],
    };
  });
  const todayIso = sydneyDate(now);
  const ranked = rankLeaderboard(inputs, viewerId, todayIso);
  return { ...ranked, joinedCount: joined.length };
}

export function sydneyDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}
