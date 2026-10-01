import type { UnifiedItem } from '@/lib/study/unified-session-types';

export type InterventionReason = NonNullable<UnifiedItem['interventionReason']>;

export interface ResolveInterventionReasonArgs {
  conceptId: string;
  recallOnExamDay: number;
  /** Whatever interventionReason the picking layer already chose based on
   *  teaching-state / weakness signals (e.g. 'weak_recall', 'reinforcement',
   *  'needs_retest', 'pre_teach_naive'). */
  baseReason: InterventionReason;
  /** Concepts the user failed (q<3 on a card OR isCorrect=false on an MCQ)
   *  within the last 2h. Populated by the D failure-escalation query in
   *  constructUnifiedSession. */
  recentFailureConceptIds: Set<string>;
  /** Concepts that still have at least one unseen card in bulk. Used by the
   *  E strong-pristine un-starve extension to weakConcepts. */
  conceptHasPristine: Set<string>;
  /** Recall threshold above which a concept is considered "strong" — same
   *  value the scheduler uses when partitioning weakConcepts. */
  targetRecall: number;
}

/**
 * Resolve the analytics-facing interventionReason for an item, applying the
 * D (failure-escalation) and E (strong-pristine un-starve) overrides on top
 * of whatever base reason the picking layer chose.
 *
 * Why this exists
 *   The scheduler boosts concept priority via D (+0.25 on recent-failure) and
 *   includes strong-but-pristine concepts in the weakConcepts set via E.
 *   Both run silently at the concept-priority layer — when items are then
 *   picked from those concepts, the picker only knows the teaching-state
 *   labels ('weak_recall' / 'reinforcement'). Without this resolver, the
 *   morning check sees 100% generic labels and can't tell whether D or E
 *   ever drove a serve.
 *
 * Precedence (most-actionable first)
 *   1. failure_escalation — the user JUST failed this concept; the boost
 *      that surfaced this item is the most important signal to log.
 *   2. strong_pristine — concept is strong (recall ≥ targetRecall) but still
 *      has unseen cards; E un-starve is the reason this concept appeared at
 *      all in the weak set.
 *   3. baseReason — the picker's original label, unchanged.
 *
 * Why failure_escalation outranks pre_teach_naive
 *   In practice pre_teach_naive only fires for zero-exposure concepts, which
 *   by definition can't have a recent failure. But if both ever line up,
 *   failure is the more actionable signal for what to teach next.
 */
export function resolveInterventionReason(args: ResolveInterventionReasonArgs): InterventionReason {
  const { conceptId, recallOnExamDay, baseReason, recentFailureConceptIds, conceptHasPristine, targetRecall } = args;

  if (recentFailureConceptIds.has(conceptId)) return 'failure_escalation';

  if (recallOnExamDay >= targetRecall && conceptHasPristine.has(conceptId)) {
    return 'strong_pristine';
  }

  return baseReason;
}
