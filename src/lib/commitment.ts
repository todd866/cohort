/**
 * Commitment profile — measures how invested a user is based on study behaviour.
 *
 * Levels:
 *   visitor   — no activity (anonymous, just landed)
 *   browser   — minimal activity (clicked around, tried a few cards)
 *   student   — real engagement (50+ reviews, multi-day, returning)
 *   committed — deep investment (200+ reviews, 7+ days, proven retention)
 *   superfan  — prestige rank (1000+ reviews, 90+ days, sustained over months)
 *
 * This is pure computation from aggregated stats. The DB query that
 * produces CommitmentProfile lives in getCommitmentProfile().
 */

import { prisma } from '@/lib/prisma';
import {
  computeCommitmentLevel,
  DEFAULT_COMMITMENT_WINDOW_DAYS,
  type CommitmentProfile,
  type CommitmentResult,
} from '@/lib/commitment-level';

export {
  computeCommitmentLevel,
  DEFAULT_COMMITMENT_WINDOW_DAYS,
  type CommitmentLevel,
  type CommitmentProfile,
  type CommitmentResult,
} from '@/lib/commitment-level';

/**
 * Fetch commitment profile from the database for a given user.
 */
export async function getCommitmentProfile(
  userId: string,
  windowDays: number = DEFAULT_COMMITMENT_WINDOW_DAYS,
): Promise<CommitmentResult> {
  const [stats] = await prisma.$queryRaw<Array<{
    total_reviews: number;
    total_mcqs: number;
    correct_mcqs: number;
    distinct_days: number;
    max_gap_days: number;
  }>>`
    WITH grading_events AS (
      SELECT "eventType", "isCorrect", DATE("timestamp") as d
      FROM "LearningEvent"
      WHERE "userId" = ${userId}
        AND "eventType" IN ('card_reviewed', 'mcq_attempted')
        AND "timestamp" > NOW() - ${windowDays} * INTERVAL '1 day'
    ),
    all_days AS (
      SELECT DISTINCT d FROM grading_events
    ),
    day_gaps AS (
      SELECT d, d - LAG(d) OVER (ORDER BY d) as gap
      FROM all_days
    )
    SELECT
      (SELECT COUNT(*) FILTER (WHERE "eventType" = 'card_reviewed')::int
       FROM grading_events) as total_reviews,
      (SELECT COUNT(*) FILTER (WHERE "eventType" = 'mcq_attempted')::int
       FROM grading_events) as total_mcqs,
      (SELECT COUNT(*) FILTER (
         WHERE "eventType" = 'mcq_attempted' AND "isCorrect" IS TRUE
       )::int FROM grading_events) as correct_mcqs,
      (SELECT COUNT(*)::int FROM all_days) as distinct_days,
      COALESCE((SELECT MAX(gap)::int FROM day_gaps), 0) as max_gap_days
  `;

  const profile: CommitmentProfile = {
    totalReviews: stats.total_reviews,
    totalMcqs: stats.total_mcqs,
    distinctDays: stats.distinct_days,
    returnedAfterGap: stats.max_gap_days >= 2,
    accuracy: stats.total_mcqs > 0
      ? stats.correct_mcqs / stats.total_mcqs
      : null,
  };

  return {
    ...profile,
    level: computeCommitmentLevel(profile),
    totalActivity: profile.totalReviews + profile.totalMcqs,
  };
}
