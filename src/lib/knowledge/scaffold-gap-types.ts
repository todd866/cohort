/**
 * The two kinds of scaffold demand stored in ContentGap, and how far back
 * scaffold:needs reads them. Dependency-free so the writers, the reader script
 * and the retention job share one spelling.
 *
 * `candidateCount` means the same thing for both: how many qualifying
 * scaffolds exist for the gap. 0 is authoring demand (write the simpler
 * card); more than 0 on a scheduler gap is a consumption gap (a C1 card exists
 * but was not in that pass's pool).
 *
 * Neither type is one row per gap, so scaffold:needs counts gap-days: rows of
 * one type merge per rotation, concept and UTC day.
 */
export const SCAFFOLD_GAP_TYPES = {
  /**
   * The scheduler found no complexity-1 card to pair after a high-pressure
   * item. candidateCount = topic-matched C1 cards in the rotation, seen or
   * unseen. Repeats within a day are suppressed best-effort per rotation and
   * concept (or topic set), so the table can hold duplicates; see
   * record-scaffold-gap.ts.
   */
  scheduler: 'scaffold_gap',
  /**
   * A learner failed a card and no strictly simpler card on the same ground
   * was found to step down to. Always authoring demand: candidateCount is the
   * number of qualifying scaffolds, which is 0 whenever this row is written.
   * One row per such failure.
   */
  failedCard: 'scaffold_gap_no_simpler',
} as const;

/** scaffold:needs reads this many days of ContentGap rows. */
export const SCAFFOLD_NEEDS_WINDOW_DAYS = 30;
