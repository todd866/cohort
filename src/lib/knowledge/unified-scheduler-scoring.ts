/**
 * Unified scheduler: scoring helpers
 *
 * Exam pressure, the high-recall soft penalty and per-concept teaching caps,
 * the cluster round-robin and the exam-target concept allocation. Moved out of
 * unified-scheduler.ts unchanged; that module re-exports the public names, so
 * importers need no edits.
 */

import { isSyntheticConceptAttribution } from './synthetic-concept';
import { CALIBRATION_ITEM_PENALTY_THRESHOLD } from '@/lib/audit/walk-pathologies';
import { allocateExamTargetSeats } from '@/lib/exam-target/allocator';
import type {
  ExamTargetDefinition,
  ExamTargetInfluencePolicy,
} from '@/lib/exam-target/types';
import type { ConceptState, SessionMode, UnifiedSessionItem } from './unified-scheduler-types';

// =============================================================================
// Exam Pressure
// =============================================================================

/**
 * Compute exam pressure using a sigmoid centered at 21 days.
 * Returns 0–1: low far from exam, ramps through 0.5 at 21 days, near 1 on exam day.
 *
 * Key values: 42d→0.04, 30d→0.20, 21d→0.50, 19d→0.57, 14d→0.74, 7d→0.89, 0d→0.96
 */
/**
 * How many never-seen cards this session may introduce.
 *
 * NO AUTOMATIC TAPER. It used to stop new cards once exam pressure passed 0.8,
 * which is 11 days out — inside every block's revision window. Two things were
 * wrong with it. A topic reads red because it holds items never reviewed, so
 * cutting new cards means opening a red topic serves everything EXCEPT the
 * cards that would turn it green, and it stays red however much work goes in.
 * And it fired on a date rather than on anything about the learner: someone
 * who has covered a rotation and someone who has barely started get the same
 * cutoff on the same day.
 *
 * Owner's call, 2026-09-17: new cards all the way through to the end.
 *
 * Two ways to still get zero, both deliberate rather than automatic. `crunch`
 * is a mode the learner selects and its whole point is review-only. And an
 * explicit budget from a caller outranks everything, including in crunch.
 */
export function resolveMaxNewCards(input: {
  explicit?: number | null;
  mode?: SessionMode;
}): number {
  if (input.explicit !== undefined && input.explicit !== null) return input.explicit;
  if (input.mode === 'crunch') return 0;
  return Infinity;
}

export function computeExamPressure(daysToExam: number): number {
  return 1 / (1 + Math.exp(-0.15 * (21 - daysToExam)));
}

// =============================================================================
// Calibration soft penalty
// =============================================================================

/** Multiplier applied to concept priority when currentRecall > CALIBRATION_ITEM_PENALTY_THRESHOLD
 *  and the concept is not on a fragile-mastery / chronic-failure list. Soft on purpose:
 *  high-recall items still surface for maintenance, just less often. */
export const HIGH_RECALL_PRIORITY_MULTIPLIER = 0.4;

/**
 * Does this item carry a meaningful `predictedRecall` for walk-audit calibration?
 *
 * C1 cards are teaching interventions — preemptive-scaffold pairings or remediation
 * cards served *because* the user just failed an integration question. Their
 * `predictedRecall` (if drawn from the simple prereq concept's recall state) does
 * not reflect the failure that triggered them, so feeding it into the session-
 * average calibration metric produces false-positive "calibration-too-easy" flags
 * on majority-scaffolding sessions. Leave it unset for these items so the audit
 * naturally excludes them.
 *
 * Questions (no complexity tier), C2 standard cards, and C3 stretch cards are
 * the calibrated review items the metric is designed to evaluate.
 */
export function isCalibratedReviewItem(item: {
  type: string;
  complexity?: number | null;
}): boolean {
  if (item.type === 'question') return true;
  if (item.type === 'card') return item.complexity !== 1;
  return false;
}

/**
 * Re-assert per-concept teaching budgets after intervention/scaffold passes.
 *
 * Those passes intentionally run after the main picker and can inject bridge
 * cards. When that grows a concept beyond its budget, preserve the supported
 * anchor + scaffold pair by removing another ordinary item from that concept
 * first. If the cap is too small for the pair (for example mastered=1), keep
 * the anchor and drop the scaffold. Synthetic attribution buckets represent
 * unrelated items and are therefore exempt.
 */
export function enforceConceptTeachingCaps(
  items: UnifiedSessionItem[],
  capFor: (conceptId: string) => number,
): UnifiedSessionItem[] {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const conceptId = items[index].conceptId;
    if (isSyntheticConceptAttribution(conceptId)) continue;
    const indexes = groups.get(conceptId) ?? [];
    indexes.push(index);
    groups.set(conceptId, indexes);
  }

  const removed = new Set<number>();
  for (const [conceptId, indexes] of groups) {
    const cap = Math.max(0, Math.floor(capFor(conceptId)));
    let excess = indexes.length - cap;
    if (excess <= 0) continue;

    const scaffoldIndexes = new Set(
      indexes.filter((index) => items[index].struggleIntervention?.isScaffold === true),
    );
    const masteryCoreIndexes = new Set(
      indexes.filter(
        (index) => items[index].examTargetMasteryStage === 'scheduled-atomic-core',
      ),
    );
    const protectedTargetIds = new Set(
      [...scaffoldIndexes]
        .map((index) => items[index].struggleIntervention?.targetCardId)
        .filter((id): id is string => Boolean(id)),
    );

    const removeWhere = (predicate: (index: number) => boolean) => {
      for (let cursor = indexes.length - 1; cursor >= 0 && excess > 0; cursor -= 1) {
        const index = indexes[cursor];
        if (removed.has(index) || !predicate(index)) continue;
        removed.add(index);
        excess -= 1;
      }
    };

    // Preserve scaffold + supported anchor by sacrificing an ordinary sibling
    // first. This keeps the immediate teaching pair intact when the cap allows.
    removeWhere((index) =>
      !scaffoldIndexes.has(index)
      && !masteryCoreIndexes.has(index)
      && !protectedTargetIds.has(items[index].id),
    );
    // If every item is part of a pair, discard the latest scaffold before its
    // anchor. A mastered=1 concept should retain the tested item, not only help.
    removeWhere((index) => scaffoldIndexes.has(index));
    // Defensive fallback for malformed pairing metadata. Mastery-core facts
    // remain the final sacrifice: ordinary maintenance and scaffolds cannot
    // silently evict today's required fact.
    removeWhere((index) => !masteryCoreIndexes.has(index));
    removeWhere(() => true);
  }

  return items.filter((_, index) => !removed.has(index));
}

/**
 * Soft-deprioritise concepts whose current recall is already very high (>0.9)
 * to push session-average predicted recall toward the desirable difficulty band
 * (0.6-0.8). Hard cutoffs would starve maintenance probing of mastered material;
 * the multiplier lets these items still appear, just at a reduced rate.
 *
 * Two opt-outs:
 *  - Concept is in the chronic-failure list (we know the user has missed it
 *    repeatedly — recall estimate is suspect, keep priority intact).
 *  - Concept is fragile (low confidence at high recall — also keep it surfaced).
 */
export function computeRecallSoftPenalty(
  currentRecall: number,
  confidence: number,
  options: { isChronicFailure?: boolean } = {},
): number {
  if (options.isChronicFailure) return 1;
  if (currentRecall <= CALIBRATION_ITEM_PENALTY_THRESHOLD) return 1;
  // Fragile mastery exception: high recall + low confidence is unstable. Keep
  // priority intact so we re-test the wobbly concept rather than skipping it.
  if (confidence < 0.4) return 1;
  return HIGH_RECALL_PRIORITY_MULTIPLIER;
}

// =============================================================================
// Cluster Round-Robin
// =============================================================================

/**
 * Build a round-robin ordering over concepts grouped by cluster.
 * Each round visits every cluster once (highest-priority concept first)
 * before any cluster contributes again.
 *
 * @param concepts - Concepts sorted by priority (desc)
 * @param getCluster - Function that returns the cluster ID for a concept
 */
/**
 * How far yesterday's cluster can crowd out the rest of the rotation.
 *
 * The first few exposures are free: a cluster the learner just opened still
 * deserves its seats. Past that, each extra card in the last day multiplies
 * priority down to a floor. Share-of-session dampening never did this — on a
 * 200-card day, 10 cards in one cluster is only 5% and the old 0.3 slope
 * moved priority by about one percent, so dermatology could take the week.
 */
export const CLUSTER_FREE_EXPOSURES = 4;
export const CLUSTER_DAMPEN_FLOOR = 0.25;

export function clusterExposureDampening(clusterCount: number): number {
  const excess = Math.max(0, clusterCount - CLUSTER_FREE_EXPOSURES);
  return Math.max(CLUSTER_DAMPEN_FLOOR, 0.82 ** excess);
}

export function buildClusterRoundRobin(
  concepts: ConceptState[],
  getCluster: (concept: ConceptState) => string,
  targetOrderRank?: (concept: ConceptState) => number | null,
): ConceptState[] {
  // Group by cluster
  const clusterGroups = new Map<string, ConceptState[]>();
  for (const concept of concepts) {
    const clusterId = getCluster(concept);
    if (!clusterGroups.has(clusterId)) {
      clusterGroups.set(clusterId, []);
    }
    clusterGroups.get(clusterId)!.push(concept);
  }

  // Within each group, concepts are already sorted by priority (from input)
  // Sort groups by their top concept's priority (desc)
  const sortedGroups = [...clusterGroups.values()]
    .filter(g => g.length > 0)
    .sort((a, b) => {
      if (targetOrderRank) {
        const leftRank = targetOrderRank(a[0]);
        const rightRank = targetOrderRank(b[0]);
        if (leftRank !== null && rightRank !== null && leftRank !== rightRank) {
          return leftRank - rightRank;
        }
      }
      return b[0].priority - a[0].priority;
    });

  // Round-robin: take one from each group per round (O(n) via per-group counters)
  const result: ConceptState[] = [];
  const groupCounters = new Map<typeof sortedGroups[number], number>();
  for (const group of sortedGroups) groupCounters.set(group, 0);

  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const group of sortedGroups) {
      const nextIdx = groupCounters.get(group)!;
      if (nextIdx < group.length) {
        result.push(group[nextIdx]);
        groupCounters.set(group, nextIdx + 1);
        if (nextIdx + 1 < group.length) hasMore = true;
      }
    }
  }

  return result;
}

export interface ExamTargetConceptAllocationMapping {
  primaryDomainCode: string;
  targetIndex: number;
}

/**
 * A shadow registry entry has zero serving authority, but paired evaluation
 * still needs a prospective policy to measure. Proxy/hybrid evidence remains
 * bounded and soft; only an official target may evaluate the full allocator.
 * The caller must explicitly mark the branch evaluation-only and must never
 * use that branch as the serving disposition.
 */
export function resolveExamTargetEvaluationInfluence(
  definition: ExamTargetDefinition,
  evaluationOnly: boolean,
): ExamTargetInfluencePolicy {
  if (!evaluationOnly || definition.influence.allocator !== 'shadow') {
    return definition.influence;
  }
  if (definition.targetBasis === 'proxy') {
    return {
      allocator: 'soft',
      maxItemRankMove: 1,
      conceptMultiplierMin: 0.9,
      conceptMultiplierMax: 1.1,
    };
  }
  if (definition.targetBasis === 'hybrid') {
    return {
      allocator: 'soft',
      maxItemRankMove: 2,
      conceptMultiplierMin: 0.9,
      conceptMultiplierMax: 1.1,
    };
  }
  return {
    allocator: 'full',
    maxItemRankMove: 5,
    conceptMultiplierMin: 0.67,
    conceptMultiplierMax: 1.75,
  };
}

export interface AllocateExamTargetConceptOrderInput {
  concepts: readonly ConceptState[];
  /** Failure/remediation concepts keep their exact control positions. */
  protectedConceptIds: ReadonlySet<string>;
  requestedDiscretionarySize: number;
  conceptMappings: ReadonlyMap<string, ExamTargetConceptAllocationMapping>;
  desiredShares: ReadonlyMap<string, number>;
  observedDomainCounts: ReadonlyMap<string, number>;
  influence: ExamTargetInfluencePolicy;
}

export interface ExamTargetConceptAllocationOrder {
  concepts: ConceptState[];
  changedMembershipCount: number;
  coverageDebtDomainCodes: string[];
}

/**
 * Applies the target allocator only to discretionary concept positions.
 * Protected failure/remediation positions are copied byte-for-byte from the
 * control order, while the same already-authorized concept set supplies the
 * target ordering for every downstream teaching/source constraint.
 */
export function allocateExamTargetConceptOrder(
  input: AllocateExamTargetConceptOrderInput,
): ExamTargetConceptAllocationOrder {
  const discretionaryCandidates = input.concepts
    .map((concept, baseRank) => ({ concept, baseRank }))
    .filter(({ concept }) => !input.protectedConceptIds.has(concept.conceptId))
    .map(({ concept, baseRank }) => {
      const mapping = input.conceptMappings.get(concept.conceptId);
      return {
        itemKey: `concept:${concept.conceptId}`,
        slotClass: 'discretionary' as const,
        domainCode: mapping?.primaryDomainCode ?? null,
        baseRank,
        itemTargetIndex: mapping?.targetIndex ?? null,
        concept,
      };
    });
  const allocated = allocateExamTargetSeats({
    requestedSize: Math.min(
      discretionaryCandidates.length,
      Math.max(0, Math.floor(input.requestedDiscretionarySize)),
    ),
    candidates: discretionaryCandidates,
    desiredShares: input.desiredShares,
    observedDomainCounts: input.observedDomainCounts,
    influence: input.influence,
  });
  const selectedKeys = new Set(allocated.selected.map(candidate => candidate.itemKey));
  const targetDiscretionaryOrder = [
    ...allocated.selected,
    ...discretionaryCandidates.filter(candidate => !selectedKeys.has(candidate.itemKey)),
  ];
  let discretionaryIndex = 0;
  const concepts = input.concepts.map((concept) => {
    if (input.protectedConceptIds.has(concept.conceptId)) return concept;
    return targetDiscretionaryOrder[discretionaryIndex++]?.concept ?? concept;
  });
  const feasibleDomainCodes = new Set(
    discretionaryCandidates
      .map(candidate => candidate.domainCode)
      .filter((domainCode): domainCode is string => domainCode !== null),
  );
  const coverageDebtDomainCodes = new Set(allocated.coverageDebtDomainCodes);
  for (const domainCode of input.desiredShares.keys()) {
    if (!feasibleDomainCodes.has(domainCode)) coverageDebtDomainCodes.add(domainCode);
  }

  return {
    concepts,
    changedMembershipCount: allocated.changedMembershipCount,
    coverageDebtDomainCodes: [...coverageDebtDomainCodes].sort(),
  };
}
