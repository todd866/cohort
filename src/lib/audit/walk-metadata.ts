/**
 * Pure helpers for Phase 1 of the scheduler-walk-audit system.
 * See docs/designs/2026-04-17-scheduler-walk-audit.md.
 */

/**
 * Cosine similarity of two equal-length vectors.
 * Returns null if lengths mismatch or either vector is zero-length (similarity undefined).
 *
 * Kept for callers that still need ad-hoc cosine in JS (e.g., concept-level
 * boosts on tiny vector counts). Hot-path item ranking goes through SQL via
 * @/lib/manifold/scoring instead.
 */
export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Map an item's complexity (1–3+) to its scheduler difficulty tier.
 *   complexity 1   → 'scaffolding' (teaching content; serves as a step-down on miss)
 *   complexity 2   → 'standard'    (testing content at expected level)
 *   complexity ≥ 3 → 'stretch'     (above-level / synthesis content)
 *   null/undefined → null          (untagged content; tier unknown)
 */
export function tierFromComplexity(
  complexity: number | null | undefined,
): 'scaffolding' | 'standard' | 'stretch' | null {
  if (complexity == null) return null;
  if (complexity <= 1) return 'scaffolding';
  if (complexity === 2) return 'standard';
  return 'stretch';
}

export interface WalkEnrichable {
  id: string;
}

export interface WalkEnriched {
  positionInSession: number;
  similarityToPrior: number | null;
}

/**
 * Enrich an ordered item list with per-position walk metadata.
 * - positionInSession is the 0-based index.
 * - similarityToPrior is supplied by `similarityToPriorMap` (keyed by item id);
 *   null at position 0 or when the map omits an item.
 *
 * Idempotent: re-running on already-enriched items produces the same output.
 *
 * Note on the API change: previously this function expected each item to carry
 * a 3072-dim embedding and computed cosine in JS. That forced ~25 KB/item
 * embedding loads from Postgres on the request path. The new contract is
 * "scores in, scores out" — callers compute similarities in SQL via
 * `scoreOrderedPairwiseDistances` and pass the resulting Map.
 */
export function enrichItemsWithWalkMetadata<T extends WalkEnrichable>(
  items: readonly T[],
  similarityToPriorMap?: Map<string, number>,
): Array<T & WalkEnriched> {
  return items.map((item, index) => {
    const similarityToPrior =
      index === 0 ? null : similarityToPriorMap?.get(item.id) ?? null;
    return { ...item, positionInSession: index, similarityToPrior };
  });
}
