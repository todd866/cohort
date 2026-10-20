/**
 * The denominator shown beside a practice score: answered questions when some
 * were left blank, otherwise the paper length. Shared by the results screen and
 * the statistics page so one sitting never shows two percentages.
 */
export function displayedPracticeTotal(score: { total: number; answered: number }): number {
  return score.answered > 0 && score.answered < score.total ? score.answered : score.total;
}
