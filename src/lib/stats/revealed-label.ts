/**
 * Learner-facing name for an MCQ revealed with Show answer before an option
 * was chosen. The event stays `metadata.skipped` / `isCorrect` null — this
 * module only names it.
 */
export const REVEALED_TOOLTIP = 'Show answer pressed before choosing — not counted as right or wrong';

export const REVEALED_LABELS = {
  /** Column header on the full usage table. */
  header: 'Revealed',
  /** Compact stats:today column, beside flagged. */
  compact: 'R/F',
  legend: 'R = revealed without answering',
  tooltip: REVEALED_TOOLTIP,
} as const;

/** "12 revealed". */
export function revealedCountLabel(count: number): string {
  return `${count} revealed`;
}
