import type { RotationProgressBreakdown } from './hooks/useSessionProgress';

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
export function visibleProgressRotations(
  rows: readonly RotationProgressBreakdown[],
  currentRotation: string | null,
): RotationProgressBreakdown[] {
  if (rows.length === 0) return [];

  // The booked exam is the headline. Soonest first when more than one is booked.
  const withExam = rows
    .filter((r) => r.examDate)
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
