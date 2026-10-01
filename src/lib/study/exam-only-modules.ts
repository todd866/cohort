/**
 * Modules that test only what their exam tests.
 *
 * GSSE (`surgical-sciences`) and NSx (`neurosurg`) serve exam-format questions
 * only — Type X / NSA statement sets and exam-style single best answers. Cards
 * in these modules exist to teach after a miss, not to be reviewed on their own,
 * so a session focused on one of them is a questions-only session (the same
 * lane as the "MCQs only" mode). See
 * docs/superpowers/specs/2026-10-01-surgical-exam-realism-design.md.
 */
export const EXAM_ONLY_ROTATIONS: ReadonlySet<string> = new Set(['neurosurg', 'surgical-sciences']);

type SessionTypeFilter = 'card' | 'question' | 'group';
const TYPE_FILTERS: ReadonlySet<string> = new Set<SessionTypeFilter>(['card', 'question', 'group']);

export function sessionTypeFilter(rotation: string | null, requested: string | null): SessionTypeFilter | null {
  if (rotation && EXAM_ONLY_ROTATIONS.has(rotation)) return 'question';
  return requested && TYPE_FILTERS.has(requested) ? requested as SessionTypeFilter : null;
}
