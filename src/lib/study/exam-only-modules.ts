/**
 * Modules that test only what their exam tests.
 *
 * GSSE (`surgical-sciences`) and NSx (`neurosurg`) are exam-led rotations.
 * Their default review is mixed, but only native cards explicitly marked as
 * scaffolds may enter alongside exam questions. Explicit question mode remains
 * questions-only. Timed practice owns its own contract.
 */
export const EXAM_ONLY_ROTATIONS: ReadonlySet<string> = new Set(['neurosurg', 'surgical-sciences']);

export const EXAM_SCAFFOLD_TAGS: Readonly<Record<string, string>> = Object.freeze({
  neurosurg: 'nsx-scaffold',
  'surgical-sciences': 'gsse-scaffold',
});

type SessionTypeFilter = 'card' | 'question' | 'group';
const TYPE_FILTERS: ReadonlySet<string> = new Set<SessionTypeFilter>(['card', 'question', 'group']);

export function sessionTypeFilter(rotation: string | null, requested: string | null): SessionTypeFilter | null {
  return requested && TYPE_FILTERS.has(requested) ? requested as SessionTypeFilter : null;
}

export function examScaffoldTag(rotation: string | null | undefined): string | null {
  return rotation ? EXAM_SCAFFOLD_TAGS[rotation] ?? null : null;
}

export function isNativeExamScaffold(
  rotation: string | null | undefined,
  topics: readonly string[] | null | undefined,
): boolean {
  const tag = examScaffoldTag(rotation);
  return Boolean(tag && topics?.includes(tag));
}
