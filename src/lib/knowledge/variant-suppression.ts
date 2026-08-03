/**
 * variant-suppression — what a shared `variantGroupId` actually MEANS, per variantType.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * `Question.variantGroupId` conflates three unrelated things, and code that gates on the
 * raw column treats them identically:
 *
 *   near-duplicate  — machine-clustered near-identical questions (sim >= 0.93). Serving
 *                     two in one session is genuinely redundant. SUPPRESS.
 *   contrast-set    — a probe family: one shared choice pool, N stems, each with a
 *                     DIFFERENT correct answer (see question-bank/contrast-set.ts).
 *                     Suppression here means "space related probes across encounters",
 *                     NOT "these rows are equivalent". SUPPRESS.
 *   anchor /        — hand-authored groups. Measured 2026-07-16: of 200 such families,
 *   different-      ZERO share a correct answer. They are TOPIC BUCKETS —
 *   scenario /      `vg:critical-care:electrolyte-emergencies` spans four unrelated
 *   rephrased       answers (ECG sequence / membrane stabilisation / calcium gluconate /
 *                   hypocalcaemia). Suppressing them collapses ~660 legitimate questions
 *                   to ~443 session slots for no pedagogical reason. DO NOT SUPPRESS.
 *
 * `rephrased` sounds eligible and is not: the measured data says the hand-authored labels
 * do not reliably encode equivalent siblings. Audit and relabel before trusting one.
 *
 * WHY AN ALLOWLIST, NOT A DENYLIST
 * --------------------------------
 * A new variantType must default to NOT suppressing. Over-suppression silently starves
 * content and is invisible in testing (the session just looks a bit thin); under-
 * suppression at worst shows two related questions in one sitting. Fail toward serving.
 *
 * USE THIS EVERYWHERE. Question suppression previously lived as a raw
 * `selectedGroups.has(q.variantGroupId)` in five places and was MISSING from the instant
 * fast path entirely — so contrast siblings could double-serve on the hottest lane
 * (instant runs on every cache miss; the cache is invalidated on every grade). One
 * predicate, every lane.
 *
 * Cards are NOT covered here — cloze variant groups (variantType 'cloze-blank') have
 * their own semantics and their own suppression in the card lanes.
 */
import { CONTRAST_SET_VARIANT_TYPE } from '@/lib/question-bank/contrast-set';
import type { QuestionFamiliarity } from './question-retirement';

/**
 * The ONLY variantTypes where two siblings in one session is actually redundant.
 * Widening this is a behaviour change: read the module header first.
 */
export const SUPPRESSIBLE_VARIANT_TYPES: ReadonlySet<string> = new Set([
  'near-duplicate',
  CONTRAST_SET_VARIANT_TYPE,
]);

export interface VariantIdentity {
  /** Optional: callers range from DB rows to session items, which omit it entirely. */
  variantGroupId?: string | null;
  variantType?: string | null;
}

/**
 * The session-suppression key for a question, or null when it must NOT be suppressed.
 *
 * Null means "serve freely" — a question with no family, no type, an unknown type, or a
 * type whose groups are topic buckets rather than equivalent siblings.
 */
export function questionSuppressionKey(q: VariantIdentity): string | null {
  if (!q.variantGroupId || !q.variantType) return null;
  return SUPPRESSIBLE_VARIANT_TYPES.has(q.variantType) ? q.variantGroupId : null;
}

/**
 * Make the first ranked slot for each contrast family belong to its
 * least-recently delivered eligible sibling.
 *
 * This deliberately swaps siblings only within the positions the family already
 * occupies. Vector similarity, difficulty, source preference, and every non-family
 * candidate keep their upstream positions; the function decides only WHICH sibling
 * wins when the existing one-per-family suppression gate encounters that family.
 * Never-served siblings have no familiarity row and therefore sort first. Ties are
 * stable, so adding content cannot reshuffle a family through attempt-count modulo.
 */
export function prioritizeLeastRecentlyServedContrastSiblings<T extends VariantIdentity>(
  candidates: T[],
  getId: (candidate: T) => string,
  familiarity: Map<string, QuestionFamiliarity>,
): T[] {
  if (candidates.length <= 1) return candidates;

  const positionsByFamily = new Map<string, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (
      candidate.variantType !== CONTRAST_SET_VARIANT_TYPE
      || !candidate.variantGroupId
    ) continue;
    const positions = positionsByFamily.get(candidate.variantGroupId) ?? [];
    positions.push(index);
    positionsByFamily.set(candidate.variantGroupId, positions);
  }

  const result = [...candidates];
  for (const positions of positionsByFamily.values()) {
    if (positions.length <= 1) continue;
    const siblings = positions
      .map((position, originalOrder) => ({
        candidate: candidates[position],
        originalOrder,
        lastServedAtMs: familiarity.get(getId(candidates[position]))?.lastSeenAtMs
          ?? Number.NEGATIVE_INFINITY,
      }))
      .sort((a, b) => a.lastServedAtMs - b.lastServedAtMs || a.originalOrder - b.originalOrder)
      .map(({ candidate }) => candidate);
    for (let index = 0; index < positions.length; index++) {
      result[positions[index]] = siblings[index];
    }
  }

  return result;
}
