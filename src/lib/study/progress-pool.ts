/** Four mutually exclusive bands for the currently servable study pool. */
export interface ProgressPoolBands {
  learned: number;
  learning: number;
  shaky: number;
  unseen: number;
  total: number;
}

export const SELF_PACED_HOLDING_DAYS = 21;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole calendar days from `now` until `examDate`, using UTC dates.
 *
 * Exam dates in this product are calendar days stamped at UTC midnight.
 * A negative result means the sitting has passed. Zero is exam day itself.
 */
export function daysUntilCalendarExam(examDate: Date, now: Date): number {
  const startOfToday = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  );
  const examDay = Date.UTC(
    examDate.getUTCFullYear(), examDate.getUTCMonth(), examDate.getUTCDate(),
  );
  return Math.round((examDay - startOfToday) / MS_PER_DAY);
}

export function progressHorizonDays(daysToExam: number | null): number {
  return daysToExam == null
    ? SELF_PACED_HOLDING_DAYS
    : Math.max(0, Math.ceil(daysToExam));
}

/**
 * A card is learned when the last recall succeeded.
 *
 * "Stability still holds on exam day" pinned this at a handful of cards:
 * observed stability sits near a few days, so almost nothing outlasts a
 * ten-day horizon, and weeks of successful reviews read as learned: 4.
 * Being due again is ordinary spaced repetition, not evidence the card
 * was never learned. Shaky is a failed last recall only.
 *
 * Questions have no last-recall grade, so every seen question is learning.
 * Callers keep learned and shaky disjoint. Clamp defensively so a partial
 * payload cannot produce a negative segment.
 */
export const learnedCardProgressFilter = {
  totalReviews: { gt: 0 },
  lastQuality: { gte: 3 },
} as const;

export const shakyCardProgressFilter = {
  totalReviews: { gt: 0 },
  lastQuality: { lt: 3 },
} as const;

/**
 * Questions have no last-recall grade, so every seen question is learning.
 * Callers keep learned and shaky disjoint. Clamp defensively so a partial
 * payload cannot produce a negative segment.
 */
export function buildProgressPoolBands(input: {
  totalCards: number;
  totalQuestions: number;
  seenCards: number;
  seenQuestions: number;
  learnedCards: number;
  shakyCards: number;
}): ProgressPoolBands {
  const totalCards = Math.max(0, input.totalCards);
  const totalQuestions = Math.max(0, input.totalQuestions);
  const seenCards = Math.min(totalCards, Math.max(0, input.seenCards));
  const seenQuestions = Math.min(totalQuestions, Math.max(0, input.seenQuestions));
  const learned = Math.min(seenCards, Math.max(0, input.learnedCards));
  const shaky = Math.min(seenCards - learned, Math.max(0, input.shakyCards));
  const seen = seenCards + seenQuestions;
  const total = totalCards + totalQuestions;
  return {
    learned,
    learning: seen - learned - shaky,
    shaky,
    unseen: total - seen,
    total,
  };
}
