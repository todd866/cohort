import type { RotationProgressBreakdown } from './hooks/useSessionProgress';
import { daysUntilCalendarExam } from '@/lib/study/progress-pool';

export function progressRotationsForObjective({
  objectiveRotation,
  sessionRotations,
  focusRotation,
}: {
  objectiveRotation: string | null;
  sessionRotations: readonly string[];
  focusRotation: string | null;
}): string[] {
  const objective = objectiveRotation ?? sessionRotations[0] ?? null;
  return [...new Set([objective, focusRotation].filter((value): value is string => Boolean(value)))];
}

/**
 * Which rotations the progress drawer should show.
 *
 * The drawer listed every rotation with any content, which on 2026-09-13 meant
 * the exam bar followed by six background decks sitting at or near zero
 * progress, so the exam countdown scrolled out of view behind decks the learner
 * was not studying. The reference learner, 2026-09-13: "this progress bar is
 * getting cluttered up with all the extra rotations, it should just show CAH +
 * whatever one I'm currently looking at if it's not CAH."
 *
 * It only gets worse with content: importing 1,793 neuroanatomy cards adds to
 * surgical-sciences, and every future corpus adds another permanent row.
 *
 * THE EXAM ROTATION IS IDENTIFIED BY `examDate`, NOT BY NAME. Hardcoding `cah`
 * would keep showing a finished countdown when Block 4 rolls to PWH on 12-Oct,
 * and would be wrong for six weeks before anyone noticed — the same
 * silently-stale failure as a hardcoded threshold.
 */
/**
 * A finished sitting is not a countdown. Days of 0 used to mean both "exam
 * today" and "this exam was months ago, clamped up to zero", so Critical Care
 * sorted ahead of CAH for a learner whose CC exam was in March. A positive
 * count is trusted. Zero is exam day only when the date itself is not past.
 */
export function isOpenExam(row: RotationProgressBreakdown, now: Date): boolean {
  if (!row.examDate) return false;
  const days = row.daysToExam ?? null;
  if (days == null || days < 0) return false;
  if (days > 0) return true;
  const exam = new Date(row.examDate);
  if (Number.isNaN(exam.getTime())) return false;
  return daysUntilCalendarExam(exam, now) >= 0;
}

export function visibleProgressRotations(
  rows: readonly RotationProgressBreakdown[],
  currentRotation: string | null,
  now: Date = new Date(),
): RotationProgressBreakdown[] {
  if (rows.length === 0) return [];

  // The booked exam is the headline. Soonest first when more than one is booked.
  const withExam = rows
    .filter((row) => isOpenExam(row, now))
    .sort((a, b) => (a.daysToExam ?? Infinity) - (b.daysToExam ?? Infinity));

  // Self-paced only (no sitting booked): the deck with the most work done today
  // is the honest stand-in for "what this learner is actually studying".
  const headline = withExam[0]
    ?? [...rows].sort((a, b) => b.todayReviewed - a.todayReviewed)[0];

  const current = currentRotation
    ? rows.find((r) => r.rotation === currentRotation)
    : undefined;

  const visible = [headline];
  if (current && current.rotation !== headline.rotation) visible.push(current);
  return visible;
}
