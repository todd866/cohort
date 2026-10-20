import {
  freshnessTier,
  type QuestionFamiliarity,
  type RetirementPolicy,
} from '@/lib/knowledge/question-retirement';

/**
 * Last line of defence for MCQ retirement on the instant lane: whatever path
 * put a question in the batch, a question this learner has already answered
 * correctly never leaves. Uses only the familiarity the lane already loaded,
 * so it adds no query to the request path.
 *
 * Two delivered re-serves on 2026-10-14 got past every upstream filter and the
 * path was not found; `dropped` and `outOfScope` are logged so the next one
 * names itself. A question outside the familiarity scope has no history here,
 * so it is reported, not guessed at.
 */
export function guardRetiredAtEgress<T extends { type: string; id: string }>(
  items: T[],
  familiarity: ReadonlyMap<string, QuestionFamiliarity>,
  familiarityScope: ReadonlySet<string>,
  policy: RetirementPolicy,
): { items: T[]; dropped: string[]; outOfScope: string[] } {
  if (!policy.permanentRetirementEnabled) return { items, dropped: [], outOfScope: [] };
  const dropped: string[] = [];
  const outOfScope: string[] = [];
  const kept = items.filter((item) => {
    if (item.type !== 'question') return true;
    if (!familiarityScope.has(item.id)) {
      outOfScope.push(item.id);
      return true;
    }
    if (freshnessTier(familiarity.get(item.id)) === 2) {
      dropped.push(item.id);
      return false;
    }
    return true;
  });
  return { items: kept, dropped, outOfScope };
}
