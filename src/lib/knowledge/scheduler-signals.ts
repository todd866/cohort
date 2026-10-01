/**
 * Scheduler Signals: D_eff and Hub Readiness
 *
 * Pure functions that modulate scheduling behavior based on the user's
 * knowledge dimensionality and prerequisite readiness.
 *
 * See docs/MATH_MODEL.md §6 (Concept Hubs) and §8 (Dimensional Collapse).
 */

// =============================================================================
// Hub Readiness Gating
// =============================================================================

export interface HubReadinessResult {
  /** Whether all prerequisites meet the recall threshold */
  ready: boolean;
  /** Minimum recall across all prerequisites (1 if no prereqs) */
  minPrereqRecall: number;
  /** Priority dampening factor (0-1). 1 = fully ready, <1 = suppress hub priority */
  dampening: number;
}

/**
 * Check whether a concept's prerequisites are sufficiently mastered.
 *
 * A hub concept connects multiple subspaces. Probing it before the
 * subspaces are ready wastes a learning opportunity — the user can't
 * make the connections if the pieces aren't in place.
 *
 *   ready = min(R_prereq) ≥ threshold
 *   dampening = min(1, minPrereqRecall / threshold)
 *
 * @param prerequisiteIds - IDs of this concept's prerequisite concepts
 * @param prereqRecalls - Map of conceptId → recallOnExamDay for prerequisites
 * @param threshold - Minimum recall required (default 0.5)
 */
export function computeHubReadiness(
  prerequisiteIds: string[],
  prereqRecalls: Map<string, number>,
  threshold: number = 0.5,
): HubReadinessResult {
  if (prerequisiteIds.length === 0) {
    return { ready: true, minPrereqRecall: 1, dampening: 1 };
  }

  let minRecall = Infinity;
  for (const prereqId of prerequisiteIds) {
    const recall = prereqRecalls.get(prereqId) ?? 0;
    if (recall < minRecall) minRecall = recall;
  }

  if (minRecall === Infinity) minRecall = 0;

  const ready = minRecall >= threshold;
  const dampening = ready ? 1 : Math.min(1, minRecall / threshold);

  return { ready, minPrereqRecall: minRecall, dampening };
}

// =============================================================================
// Knowledge Breadth (D_eff for scheduler)
// =============================================================================

export interface KnowledgeBreadthResult {
  /** Effective dimensionality (participation ratio of recall distribution) */
  dEff: number;
  /** Ratio of D_eff to total concepts (0-1). < 0.3 = dangerously narrow */
  breadthRatio: number;
}

/**
 * Compute the effective breadth of a user's knowledge from concept recalls.
 *
 * Uses the participation ratio of the recall distribution:
 *   D_eff = (Σ R_i)² / Σ R_i²
 *
 * This is the cheap proxy from MATH_MODEL.md §8 — no eigendecomposition needed.
 * When one concept dominates: D_eff → 1.
 * When N concepts have equal recall: D_eff → N.
 *
 * @param recalls - Array of recallOnExamDay for each concept
 */
export function computeKnowledgeBreadth(recalls: number[]): KnowledgeBreadthResult {
  if (recalls.length === 0) {
    return { dEff: 0, breadthRatio: 0 };
  }

  let sum = 0;
  let sumSq = 0;

  for (const r of recalls) {
    const clamped = Math.max(0, r);
    sum += clamped;
    sumSq += clamped * clamped;
  }

  if (sumSq === 0) {
    return { dEff: 0, breadthRatio: 0 };
  }

  const dEff = (sum * sum) / sumSq;
  const breadthRatio = dEff / recalls.length;

  return { dEff, breadthRatio };
}

// =============================================================================
// Maintenance Shift
// =============================================================================

/**
 * Compute how much to shift the session toward maintenance (broader review).
 *
 * When breadthRatio is low, the user's knowledge is narrowing — they're
 * losing concepts faster than they're reviewing them. The scheduler should
 * shift toward broad maintenance reviews over deep-dives into weak spots.
 *
 * Returns a value 0–0.3 that gets added to cardRatio (more cards = broader review).
 *
 * @param breadthRatio - D_eff / totalConcepts (from computeKnowledgeBreadth)
 * @param totalConcepts - Number of concepts in the rotation
 */
export function computeMaintenanceShift(
  breadthRatio: number,
  totalConcepts: number,
): number {
  // Too few concepts for D_eff to be meaningful
  if (totalConcepts < 5) return 0;

  // Above 0.5 breadth ratio = healthy, no shift needed
  if (breadthRatio >= 0.5) return 0;

  // Linear ramp: 0.5 → 0 shift, 0.0 → 0.3 shift
  const shift = 0.3 * (1 - breadthRatio / 0.5);

  return Math.min(0.3, Math.max(0, shift));
}
