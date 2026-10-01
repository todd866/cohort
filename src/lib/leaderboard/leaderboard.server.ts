import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  LEADERBOARD_LIMIT,
  LEADERBOARD_WINDOW_DAYS,
  rankLeaderboard,
  type LeaderboardInput,
  type LeaderboardRow,
} from './leaderboard-lib';

/**
 * Loads the board for a joined viewer, or — for an admin — for everyone. One aggregate over LearningEvent for
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

export interface LoadLeaderboardOptions {
  /**
   * Admin viewers only. Ranks every REGISTERED learner, opted in or not, so the
   * owner can see the whole cohort rather than the self-selected slice. A
   * learner who has not joined is labelled by their own `name`; where that is
   * null — which is the common case — by the local part of their email, the
   * same `displayName` fallback the daily usage table uses. Never the whole
   * address, and never a human name inferred from one.
   *
   * Guests (email null) stay out: an anonymous identity is an acquisition
   * record, not a person to rank.
   */
  includeEveryone?: boolean;
}

export async function loadLeaderboard(
  viewerId: string,
  now = new Date(),
  { includeEveryone = false }: LoadLeaderboardOptions = {},
): Promise<{
  rows: LeaderboardRow[];
  me: LeaderboardRow | null;
  joinedCount: number;
  viewAll: boolean;
}> {
  const candidates = await prisma.user.findMany({
    where: includeEveryone
      ? { email: { not: null } }
      : { leaderboardJoinedAt: { not: null }, leaderboardHandle: { not: null } },
    select: {
      id: true,
      name: true,
      email: true,
      leaderboardHandle: true,
      leaderboardJoinedAt: true,
    },
  });
  const people = candidates.map((u) => ({
    id: u.id,
    isJoined: u.leaderboardJoinedAt !== null && u.leaderboardHandle !== null,
    label: displayLabel(u),
  }));
  const joinedCount = people.filter((u) => u.isJoined).length;
  if (people.length === 0) return { rows: [], me: null, joinedCount: 0, viewAll: includeEveryone };

  const ids = people.map((u) => u.id);
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
  const inputs: LeaderboardInput[] = people.map((u) => {
    const agg = byUser.get(u.id);
    return {
      userId: u.id,
      handle: u.label,
      windowReviews: agg?.windowReviews ?? 0,
      allTimeReviews: agg?.allTimeReviews ?? 0,
      activeDays: agg?.activeDays ?? [],
      isJoined: u.isJoined,
    };
  });
  const todayIso = sydneyDate(now);
  // The everyone view is the whole cohort by definition, so it is not cut at
  // the public board's top 20.
  const ranked = rankLeaderboard(
    inputs, viewerId, todayIso, includeEveryone ? inputs.length : LEADERBOARD_LIMIT,
  );
  return { ...ranked, joinedCount, viewAll: includeEveryone };
}

/**
 * What to print in the Name column. A joined learner gets the handle they
 * typed. Anyone else — only ever visible to an admin — gets their own `name`,
 * or the local part of their email when it is null. A name is never inferred
 * from an address (an opaque local part stays opaque), and the domain is dropped
 * because it identifies nothing the owner needs here.
 */
function displayLabel(
  user: { name: string | null; email: string | null; leaderboardHandle: string | null; leaderboardJoinedAt: Date | null },
): string {
  if (user.leaderboardJoinedAt !== null && user.leaderboardHandle) return user.leaderboardHandle;
  const name = user.name?.trim();
  if (name) return name;
  const local = user.email?.split('@')[0]?.trim();
  return local || 'Unknown';
}

export function sydneyDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}
