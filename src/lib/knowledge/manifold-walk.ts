/**
 * Manifold Walk Ordering Algorithm
 *
 * Pure function module -- no database imports, no side effects.
 *
 * Reorders a set of review items (cards + questions) by walking through
 * embedding space. The walk favours items in a "sweet spot" of similarity
 * (not too similar, not too different) to the current position, encourages
 * type alternation, and expands a running centroid for coverage.
 *
 * Unembedded items are distributed evenly through the walk rather than
 * being appended at the end.
 */

// =============================================================================
// Interfaces
// =============================================================================

export interface WalkItem {
  type: 'card' | 'question' | 'video';
  id: string;
  priority: number;
  conceptId?: string;
}

export interface WalkOptions {
  /** Lower bound of the similarity sweet spot (default 0.4) */
  sweetSpotMin?: number;
  /** Upper bound of the similarity sweet spot (default 0.7) */
  sweetSpotMax?: number;
  /** After this many consecutive same-type items, apply a penalty (default 2) */
  maxConsecutiveSameType?: number;
  /** Hard ceiling on same-type runs. Once reached, other-type candidates are picked even if they score lower — only fallback to same-type if the pool is exhausted of the other type. Default 4. */
  hardMaxConsecutiveSameType?: number;
  /** Minimum embedded items required to perform a walk (default 3) */
  minItemsForWalk?: number;
  /** Flow axis for upstream->downstream bias. If provided, walk prefers increasing depth. */
  flowAxis?: number[];
  /** Weight of the flow bias (default 0.15). */
  flowWeight?: number;
  /** Weight of concept-pairing bonus (same concept nearby). Default 0.35. */
  conceptPairWeight?: number;
}

// =============================================================================
// Cosine Similarity — re-exported from shared math module
// =============================================================================

import { cosineSimilarity } from '@/lib/math/vector-math';
export { cosineSimilarity };

// =============================================================================
// Manifold Walk
// =============================================================================

const DEFAULTS: Required<WalkOptions> = {
  sweetSpotMin: 0.4,
  sweetSpotMax: 0.7,
  maxConsecutiveSameType: 2,
  hardMaxConsecutiveSameType: 4,
  minItemsForWalk: 3,
  flowAxis: [],
  flowWeight: 0.15,
  conceptPairWeight: 0.35,
};

/**
 * Order items by walking through embedding space.
 *
 * Algorithm:
 *   1. Partition into embedded / unembedded items
 *   2. If fewer than `minItemsForWalk` embedded items, return original order
 *   3. Seed the walk with the highest-priority embedded item
 *   4. Greedy walk: at each step score every unvisited embedded item
 *      - Sweet-spot bonus for similarity in [sweetSpotMin, sweetSpotMax]
 *      - Penalty for too-similar (>max) or too-different (<min)
 *      - Coverage bonus for items far from the running centroid
 *      - Type alternation penalty after N consecutive same-type
 *   5. Pick highest-scoring item, update centroid, repeat
 *   6. Distribute unembedded items evenly through the result
 */
export function orderByManifoldWalk<T extends WalkItem>(
  items: T[],
  embeddings: Map<string, number[]>,
  options?: WalkOptions
): T[] {
  const opts = { ...DEFAULTS, ...options };

  // -- Partition ---------------------------------------------------------------
  const embedded: T[] = [];
  const unembedded: T[] = [];

  for (const item of items) {
    if (embeddings.has(item.id)) {
      embedded.push(item);
    } else {
      unembedded.push(item);
    }
  }

  // -- Short-circuit -----------------------------------------------------------
  if (embedded.length < opts.minItemsForWalk) {
    return [...items]; // original order, new array
  }

  // -- Seed: highest priority embedded item ------------------------------------
  const seed = embedded.reduce((best, item) =>
    item.priority > best.priority ? item : best
  );

  const visited = new Set<string>([seed.id]);
  const walk: T[] = [seed];

  // Running centroid (incremental mean of visited embeddings)
  const dim = embeddings.get(seed.id)!.length;
  const centroid = [...embeddings.get(seed.id)!];

  // Track consecutive same-type count
  let consecutiveSameType = 1;

  // -- Greedy walk -------------------------------------------------------------
  while (walk.length < embedded.length) {
    const currentEmb = embeddings.get(walk[walk.length - 1].id)!;
    const currentType = walk[walk.length - 1].type;

    // Hard cap: once the run reaches the ceiling, require a type switch if any
    // different-type candidate is unvisited. This overrides all scoring.
    const hardCapReached =
      consecutiveSameType >= opts.hardMaxConsecutiveSameType;
    const hasOtherTypeAvailable =
      hardCapReached &&
      embedded.some((c) => !visited.has(c.id) && c.type !== currentType);
    const requireTypeSwitch = hardCapReached && hasOtherTypeAvailable;

    let bestScore = -Infinity;
    let bestItem: T | null = null;

    for (const candidate of embedded) {
      if (visited.has(candidate.id)) continue;
      if (requireTypeSwitch && candidate.type === currentType) continue;

      const candidateEmb = embeddings.get(candidate.id)!;
      const sim = cosineSimilarity(currentEmb, candidateEmb);

      // -- Similarity score (sweet-spot model) ---------------------------------
      let simScore: number;
      const midpoint = (opts.sweetSpotMin + opts.sweetSpotMax) / 2;

      if (sim >= opts.sweetSpotMin && sim <= opts.sweetSpotMax) {
        // In the sweet spot: peak score at midpoint, tapering toward edges
        const distFromMid = Math.abs(sim - midpoint);
        const halfRange = (opts.sweetSpotMax - opts.sweetSpotMin) / 2;
        simScore = 1.0 - (distFromMid / halfRange) * 0.3; // 1.0 at mid, 0.7 at edges
      } else if (sim > opts.sweetSpotMax) {
        // Too similar: penalize proportionally
        const excess = sim - opts.sweetSpotMax;
        simScore = 0.7 - excess * 2.0; // drops fast
      } else {
        // Too different: mild penalty
        const deficit = opts.sweetSpotMin - sim;
        simScore = 0.7 - deficit * 0.5; // drops slowly
      }

      // -- Coverage bonus (prefer items far from centroid) ---------------------
      const centroidSim = cosineSimilarity(candidateEmb, centroid);
      const coverageScore = (1.0 - centroidSim) * 0.3;

      // -- Type alternation penalty -------------------------------------------
      let typePenalty = 0;
      if (
        candidate.type === currentType &&
        consecutiveSameType >= opts.maxConsecutiveSameType
      ) {
        typePenalty = -0.5;
      }

      // -- Flow direction bonus (prefer downstream of current position) --
      let flowScore = 0;
      if (opts.flowAxis && opts.flowAxis.length > 0) {
        let currentDot = 0;
        let candidateDot = 0;
        for (let d = 0; d < Math.min(currentEmb.length, opts.flowAxis.length); d++) {
          currentDot += currentEmb[d] * opts.flowAxis[d];
          candidateDot += candidateEmb[d] * opts.flowAxis[d];
        }
        const depthDelta = candidateDot - currentDot;
        flowScore = Math.tanh(depthDelta * 3) * opts.flowWeight;
      }

      // -- Concept pairing bonus (same concept nearby) -----------------------
      let conceptPairScore = 0;
      if (opts.conceptPairWeight > 0 && candidate.conceptId) {
        const lookback = Math.min(3, walk.length);
        for (let k = 1; k <= lookback; k++) {
          const recent = walk[walk.length - k];
          if (recent.conceptId === candidate.conceptId) {
            conceptPairScore = opts.conceptPairWeight / k;
            break;
          }
        }
      }

      const totalScore = simScore + coverageScore + typePenalty + flowScore + conceptPairScore;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestItem = candidate;
      }
    }

    if (!bestItem) break; // safety (should not happen)

    // -- Update state ----------------------------------------------------------
    visited.add(bestItem.id);
    walk.push(bestItem);

    // Update consecutive type tracking
    if (bestItem.type === currentType) {
      consecutiveSameType++;
    } else {
      consecutiveSameType = 1;
    }

    // Update centroid incrementally: new_centroid = old * (n-1)/n + new_vec / n
    const n = walk.length;
    const newEmb = embeddings.get(bestItem.id)!;
    for (let d = 0; d < dim; d++) {
      centroid[d] = centroid[d] * ((n - 1) / n) + newEmb[d] / n;
    }
  }

  // -- Distribute unembedded items evenly --------------------------------------
  if (unembedded.length === 0) {
    return walk;
  }

  return distributeEvenly(walk, unembedded);
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Distribute `extras` evenly through `base` array.
 *
 * If base has N items and extras has M items, an extra is inserted
 * every floor(N / M) positions (after each slot). Remaining extras
 * fill subsequent slots.
 */
function distributeEvenly<T>(base: T[], extras: T[]): T[] {
  if (extras.length === 0) return [...base];
  if (base.length === 0) return [...extras];

  const result: T[] = [];
  // Calculate the interval at which to insert unembedded items
  // +1 because we are inserting into gaps (including end), so
  // total slots = base.length + extras.length
  const totalSlots = base.length + extras.length;
  const interval = totalSlots / extras.length;

  let extraIdx = 0;
  let nextInsertAt = Math.floor(interval / 2); // start roughly midway through first interval

  for (let i = 0; i < base.length; i++) {
    result.push(base[i]);

    // Check if we should insert an unembedded item after this position
    if (extraIdx < extras.length && result.length > nextInsertAt) {
      result.push(extras[extraIdx]);
      extraIdx++;
      nextInsertAt = Math.floor(interval / 2 + interval * extraIdx);
    }
  }

  // Append any remaining extras (shouldn't happen often with good math)
  while (extraIdx < extras.length) {
    result.push(extras[extraIdx]);
    extraIdx++;
  }

  return result;
}

// =============================================================================
// Observability
// =============================================================================

/**
 * Compute the fraction of multi-item concepts where at least one pair of
 * items on the same concept appears within 3 positions of each other.
 *
 * Returns null if no concept has 2+ items (nothing to measure).
 */
export function computeConceptPairingRate(items: WalkItem[]): number | null {
  // Group positions by conceptId
  const positionsByConceptId = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const cid = items[i].conceptId;
    if (!cid) continue;
    const positions = positionsByConceptId.get(cid);
    if (positions) {
      positions.push(i);
    } else {
      positionsByConceptId.set(cid, [i]);
    }
  }

  // Filter to concepts with 2+ items
  const multiItemConcepts = [...positionsByConceptId.values()].filter(
    (positions) => positions.length >= 2
  );

  if (multiItemConcepts.length === 0) return null;

  // A concept is "paired" if any two of its items are within 3 positions
  let pairedCount = 0;
  for (const positions of multiItemConcepts) {
    let paired = false;
    for (let i = 0; i < positions.length - 1 && !paired; i++) {
      for (let j = i + 1; j < positions.length && !paired; j++) {
        if (positions[j] - positions[i] <= 3) {
          paired = true;
        }
      }
    }
    if (paired) pairedCount++;
  }

  return pairedCount / multiItemConcepts.length;
}
