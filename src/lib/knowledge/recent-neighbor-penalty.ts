/**
 * Cross-session semantic-repeat signal for cards.
 *
 * Exact recent cards are already excluded. This catches a different failure:
 * a candidate whose precomputed nearest-neighbour list contains a card the
 * learner saw recently. The output is a soft rank penalty, never an exclusion.
 */

export const RECENT_NEIGHBOR_POLICY_VERSION = 'recent-card-neighbor-v1';
export const RECENT_NEIGHBOR_SIMILARITY_THRESHOLD = 0.85;
export const MAX_RECENT_NEIGHBOR_PENALTY = 0.95;
/** A near-duplicate may move only this many ordinal places within its stratum. */
export const RECENT_NEIGHBOR_MAX_RANK_SINK = 3;

export interface RecentNeighborSignal {
  maxSimilarity: number | null;
  penalty: number;
}

export function recentNeighborSignal(
  similarCards: unknown,
  recentCardIds: ReadonlySet<string> | undefined,
): RecentNeighborSignal {
  if (!recentCardIds || recentCardIds.size === 0 || !Array.isArray(similarCards)) {
    return { maxSimilarity: null, penalty: 0 };
  }

  let maxSimilarity: number | null = null;
  for (const entry of similarCards) {
    if (!entry || typeof entry !== 'object') continue;
    const cardId = (entry as { cardId?: unknown }).cardId;
    const similarity = (entry as { similarity?: unknown }).similarity;
    if (
      typeof cardId !== 'string'
      || !recentCardIds.has(cardId)
      || typeof similarity !== 'number'
      || !Number.isFinite(similarity)
    ) {
      continue;
    }
    maxSimilarity = Math.max(maxSimilarity ?? -Infinity, similarity);
  }

  if (maxSimilarity === null || maxSimilarity <= RECENT_NEIGHBOR_SIMILARITY_THRESHOLD) {
    return { maxSimilarity, penalty: 0 };
  }

  const normalized = (
    maxSimilarity - RECENT_NEIGHBOR_SIMILARITY_THRESHOLD
  ) / (1 - RECENT_NEIGHBOR_SIMILARITY_THRESHOLD);
  return {
    maxSimilarity,
    penalty: Math.min(MAX_RECENT_NEIGHBOR_PENALTY, Math.max(0, normalized)),
  };
}
