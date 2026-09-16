/**
 * The profile's review calendar — the contribution grid plus its exam markers.
 *
 * BACKGROUND / PAGE-RENDER USE ONLY, for the same reason as topic-heat.server:
 * it aggregates a learner's whole review history. Listed in
 * BACKGROUND_ONLY_MODULES in scripts/ops/check-hot-path-history.ts.
 *
 * The grid deliberately runs PAST today, out to the NEXT exam, so the run-up
 * shows as empty runway rather than being cropped at the present. That is the
 * point of putting exams on it: the question the learner is asking is "how much
 * time have I got, and what have I been doing with it?". It stops at the next
 * exam rather than the last one on the calendar — a date two blocks out adds
 * ten weeks of blank squares and squeezes the history that carries the signal.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { buildHeatmap, isoDay, REVIEW_EVENT_TYPES, type DayCount, type HeatmapCell } from '@/lib/review-stats';
import { getExamDateForUser, isSelfPacedExamDate, getRotation } from '@/lib/rotations';
import type { ExamMarker } from '@/components/profile/ReviewHeatmap';

const TZ = 'Australia/Sydney';

/** How much history the profile grid shows. The full record lives on /profile/stats. */
export const PROFILE_WEEKS = 26;

export interface ReviewCalendar {
  heatmap: HeatmapCell[];
  exams: ExamMarker[];
  today: string;
}

const DAY_MS = 86_400_000;

/**
 * Exam markers for every rotation the learner has a date for, inside the grid
 * window. Self-paced sentinels (2099) are excluded — they are the absence of an
 * exam, not one very far away. A sat exam carries its score when recorded.
 */
async function loadExamMarkers(
  userId: string,
  rotations: readonly string[],
  from: string,
  to: string,
): Promise<ExamMarker[]> {
  const results = await prisma.examResult.findMany({
    where: { userId },
    select: { rotation: true, examDate: true, score: true },
  });
  const scoreByRotation = new Map(results.map((r) => [r.rotation, r.score]));

  const markers: ExamMarker[] = [];
  for (const rotation of rotations) {
    const examDate = await getExamDateForUser(rotation, userId);
    if (!examDate || isSelfPacedExamDate(examDate)) continue;
    const date = isoDay(examDate.getTime());
    if (date < from || date > to) continue;
    markers.push({
      date,
      label: getRotation(rotation)?.shortName ?? rotation,
      score: scoreByRotation.get(rotation) ?? null,
    });
  }
  return markers.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The calendar for one learner. Returns null when they have never answered
 * anything — an empty grid is worse than no grid.
 */
export async function loadReviewCalendar(
  userId: string,
  rotations: readonly string[],
  now: Date = new Date(),
): Promise<ReviewCalendar | null> {
  try {
    const today = isoDay(now.getTime());
    const from = isoDay(now.getTime() - PROFILE_WEEKS * 7 * DAY_MS);

    const rows = await prisma.$queryRaw<{ day: Date; n: bigint }[]>`
      SELECT date_trunc('day', "timestamp" AT TIME ZONE ${TZ})::date AS day,
             COUNT(*)::bigint AS n
      FROM "LearningEvent"
      WHERE "userId" = ${userId}
        AND "eventType" = ANY(${[...REVIEW_EVENT_TYPES]}::text[])
        AND "timestamp" >= ${new Date(now.getTime() - PROFILE_WEEKS * 7 * DAY_MS)}
      GROUP BY 1
      ORDER BY 1
    `;
    if (rows.length === 0) return null;

    const daily: DayCount[] = rows.map((r) => ({ date: isoDay(r.day.getTime()), count: Number(r.n) }));

    // Extend the grid to the NEXT exam, not the furthest one. Running out to a
    // date two blocks away buys ten weeks of blank squares and shrinks the
    // history that actually carries information.
    const candidateExams = await loadExamMarkers(userId, rotations, from, '9999-12-31');
    const nextExam = candidateExams.find((e) => e.date > today)?.date;
    const to = nextExam ?? today;

    return {
      heatmap: buildHeatmap(daily, from, to),
      exams: candidateExams.filter((e) => e.date >= from && e.date <= to),
      today,
    };
  } catch (error) {
    // Losing this costs one profile render's calendar, never the page.
    logger.warn('Failed to load review calendar; hiding the grid', {
      userId,
      error: String(error),
    });
    return null;
  }
}
