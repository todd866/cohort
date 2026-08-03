/**
 * Synthetic concept attributions.
 *
 * The scheduler needs every served item to carry SOME concept key so that
 * per-concept budgets, diversity and teaching caps have something to group by.
 * Items with no real concept get a synthesised stand-in instead:
 *
 *   - `_unattached`      — the catch-all bucket (unified-scheduler.ts:1820)
 *   - `rotation:<id>`    — rotation-level attribution (unified-scheduler.ts:1731)
 *   - `question:<id>`    — question-level attribution (unified-scheduler.ts:2207)
 *
 * These are grouping keys, NOT `Concept` primary keys — no such row exists. That
 * distinction matters at any database boundary: writing one into a column with a
 * `Concept` foreign key throws
 * `Foreign key constraint violated on the constraint: ContentGap_conceptId_fkey`.
 *
 * Extracted here (rather than exported from unified-scheduler) because
 * unified-scheduler already imports record-scaffold-gap, so importing back the
 * other way would close a cycle.
 */

/**
 * True when `conceptId` is a scheduler-internal grouping key rather than a real
 * `Concept.id`. Callers persisting to a concept foreign key must map these to
 * null.
 */
export function isSyntheticConceptAttribution(conceptId: string): boolean {
  const normalized = conceptId.trim().toLowerCase();
  return normalized === ''
    || normalized === '_unattached'
    || normalized === 'unattached'
    || normalized.startsWith('rotation:')
    || normalized.startsWith('question:');
}

/**
 * A concept id safe to store in a `Concept` foreign key: the id itself when it
 * is a real attribution, otherwise null.
 */
export function persistableConceptId(conceptId: string | null | undefined): string | null {
  if (!conceptId) return null;
  return isSyntheticConceptAttribution(conceptId) ? null : conceptId;
}
