import { isSelfPacedExamDate } from '@/lib/rotations';

/**
 * The exam the learner is actually counting down to, independent of what they
 * are currently studying.
 *
 * The progress drawer exists for this one number: the countdown is what it is
 * FOR, and per-deck readiness detail belongs on the profile page instead.
 *
 * It cannot come from the session's own rotations. `daily-target` is asked only
 * about the rotations in scope, so focusing any self-paced deck — GSSE, NSx,
 * anatomy — returned a payload with no exam in it at all, and the countdown
 * silently disappeared exactly when the learner had wandered away from the
 * thing they are revising for. That is the moment it is most worth showing.
 *
 * Self-paced rotations carry a sentinel date rather than null, so they must be
 * excluded explicitly or the sentinel wins the "soonest" comparison forever.
 */
export interface BookedExam {
  rotation: string;
  examDate: string;
  daysToExam: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function pickBookedExam(
  candidates: ReadonlyArray<{ rotation: string; examDate: Date | null }>,
  now: Date,
): BookedExam | null {
  const startOfToday = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  );

  const booked = candidates
    .filter((c): c is { rotation: string; examDate: Date } =>
      c.examDate != null && !isSelfPacedExamDate(c.examDate))
    .map((c) => ({
      rotation: c.rotation,
      examDate: c.examDate,
      daysToExam: Math.round(
        (Date.UTC(
          c.examDate.getUTCFullYear(), c.examDate.getUTCMonth(), c.examDate.getUTCDate(),
        ) - startOfToday) / MS_PER_DAY,
      ),
    }))
    // A sitting that has passed is not a countdown. Exam day itself (0) still is.
    .filter((c) => c.daysToExam >= 0)
    .sort((a, b) => a.daysToExam - b.daysToExam);

  const soonest = booked[0];
  if (!soonest) return null;
  return {
    rotation: soonest.rotation,
    examDate: soonest.examDate.toISOString(),
    daysToExam: soonest.daysToExam,
  };
}
