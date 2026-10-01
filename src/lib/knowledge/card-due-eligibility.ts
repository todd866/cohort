/**
 * SRS due-gate for card selection.
 *
 * Exact card wording stays parked until CardProgress.nextDueAt. Selection
 * paths must not resurrect not-due cards as weak_recall / stuck / reinforcement
 * fillers. Different card ids (variants) remain independently eligible.
 *
 * Spec: docs/superpowers/specs/2026-08-10-not-due-card-hard-block-design.md
 */

export function isCardDueForSelection(
  nextDueAt: Date | null | undefined,
  now: Date,
): boolean {
  // Production CardProgress always has nextDueAt; incomplete mocks/legacy
  // rows defer to the Prisma due filter rather than crashing selection.
  if (!nextDueAt) return true;
  return nextDueAt.getTime() <= now.getTime();
}

/** Prisma progress-row filter: only cards whose due clock has arrived. */
export function cardDueForSelectionWhere(now: Date): { nextDueAt: { lte: Date } } {
  return { nextDueAt: { lte: now } };
}
