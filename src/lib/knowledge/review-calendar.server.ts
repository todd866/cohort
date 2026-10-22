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
import { isSelfPacedExamDate, defaultExamDateFor } from '@/lib/rotations';
import { USYD_MD3_2026 } from '@/lib/curriculum/usyd-md3-2026';
import {
  assembleExamMarkers,
  blocksFromPeriods,
  calendarHistoryStart,
  labelBlocks,
  type LabeledBlock,
} from '@/lib/stats/calendar-grid';
import { HEATMAP_MAX_DAYS } from '@/lib/stats/stats-page.server';
import type { ExamMarker } from '@/components/profile/ReviewHeatmap';

const TZ = 'Australia/Sydney';

/** Earlier profile grids used 26 weeks. The calendar now uses HEATMAP_MAX_DAYS. */
export const PROFILE_WEEKS = 26;

export interface ReviewCalendar {
  heatmap: HeatmapCell[];
  exams: ExamMarker[];
  blocks: LabeledBlock[];
  today: string;
}

const DAY_MS = 86_400_000;

/**
 * Exam markers for every rotation the learner has a date for, inside the grid
 * window. Self-paced sentinels (2099) are excluded — they are the absence of an
 * exam, not one very far away. A sat exam carries its score when recorded.
 *
 * ONE query for every override. This used to call `getExamDateForUser` per
 * rotation in a loop: one sequential round trip per deck, tens of milliseconds
 * each, so on an account with a dozen decks the calendar spent most of a
 * second on lookups and a quarter of it on the event aggregate. Both reads
 * now run together.
 */
async function loadExamMarkers(
  userId: string,
  rotations: readonly string[],
  today: string,
  track: number | null,
): Promise<ExamMarker[]> {
  const [results, overrides] = await Promise.all([
    prisma.examResult.findMany({
      where: { userId },
      select: { id: true, rotation: true, examDate: true, score: true },
    }),
    prisma.userRotation.findMany({
      where: { userId, rotation: { in: [...rotations] } },
      select: { rotation: true, examDate: true },
    }),
  ]);
  const overrideByRotation = new Map(overrides.map((r) => [r.rotation, r.examDate]));
  const scheduled = [];
  for (const rotation of rotations) {
    const examDate = overrideByRotation.get(rotation) ?? defaultExamDateFor(rotation, track);
    if (!examDate || isSelfPacedExamDate(examDate)) continue;
    scheduled.push({ date: isoDay(examDate.getTime()), rotation });
  }
  return assembleExamMarkers({
    today,
    results: results.map((result) => ({
      date: isoDay(result.examDate.getTime()),
      rotation: result.rotation,
      score: result.score,
      resultId: result.id,
    })),
    scheduled,
  }).map((exam) => ({
    date: exam.date,
    label: exam.label,
    score: exam.score,
    resultId: exam.resultId,
    rotation: exam.rotation,
  }));
}

/**
 * The calendar for one learner. Returns null when they have never answered
 * anything — an empty grid is worse than no grid.
 */
export async function loadReviewCalendar(
  userId: string,
  rotations: readonly string[],
  now: Date = new Date(),
  /** The learner's stream, so block defaults are their exams, not Track 3's. */
  { track = null }: { track?: number | null } = {},
): Promise<ReviewCalendar | null> {
  try {
    const today = isoDay(now.getTime());
    const windowStart = new Date(now.getTime() - HEATMAP_MAX_DAYS * DAY_MS);

    const [rows, exams] = await Promise.all([
      prisma.$queryRaw<{ day: Date; rotation: string | null; n: bigint }[]>`
      SELECT date_trunc('day', "timestamp" AT TIME ZONE ${TZ})::date AS day,
             COALESCE(rotation, '') AS rotation,
             COUNT(*)::bigint AS n
      FROM "LearningEvent"
      WHERE "userId" = ${userId}
        AND "eventType" = ANY(${[...REVIEW_EVENT_TYPES]}::text[])
        AND "timestamp" >= ${windowStart}
      GROUP BY 1, 2
      ORDER BY 1
    `,
      loadExamMarkers(userId, rotations, today, track),
    ]);
    if (rows.length === 0) return null;

    const activity = rows.map((row) => ({
      day: isoDay(row.day.getTime()),
      rotation: row.rotation ?? '',
      n: Number(row.n),
    }));
    const byDay = new Map<string, number>();
    for (const row of activity) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.n);
    const daily: DayCount[] = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
    const first = daily[0]?.date ?? today;
    const from = calendarHistoryStart(first, today, HEATMAP_MAX_DAYS);
    const lastExam = exams.filter((exam) => exam.date > today).at(-1)?.date;
    const to = lastExam && lastExam > today ? lastExam : today;
    const blocks = labelBlocks(
      blocksFromPeriods(USYD_MD3_2026.assessmentPeriods),
      activity,
      exams.map((exam) => ({ rotation: exam.rotation ?? '', examDate: exam.date })),
    );

    return {
      heatmap: buildHeatmap(daily.filter((day) => day.date >= from), from, to),
      exams,
      blocks,
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
