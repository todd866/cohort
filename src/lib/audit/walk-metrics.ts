import type { TrajectoryEvent, ResponseEvent, Session, SessionMetrics } from './walk-types';

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  return Math.sqrt(sq / (xs.length - 1));
}

/**
 * Collapse same-`variantGroupId` cards into a single audit unit before
 * coherence/diversity math. Siblings are by construction near-identical
 * (same concept, same blank-slot family) so two of them would generate
 * an artificially high pairwise similarity and a falsely-extended
 * same-cluster run. The unified scheduler also suppresses sibling pairs
 * (Task 11 of the 2026-05-08 cloze-variants design) — when one slips
 * through, the `variant-sibling-repeat` pathology fires from the raw
 * trajectory; this function only adjusts the metric numbers.
 *
 * The collapse keeps the FIRST sibling encountered and drops subsequent
 * ones; question/group items always pass through unchanged.
 */
export function collapseSiblingsForMetrics(items: TrajectoryEvent[]): TrajectoryEvent[] {
  const seen = new Set<string>();
  return items.filter((ev) => {
    if (ev.sourceType !== 'card') return true;
    const gid = ev.metadata.variantGroupId ?? null;
    if (!gid) return true;
    if (seen.has(gid)) return false;
    seen.add(gid);
    return true;
  });
}

export interface CoherenceMetrics {
  avgSimilarityConsecutive: number | null;
  similarityStddev: number | null;
}

export function computeCoherence(trajectory: TrajectoryEvent[]): CoherenceMetrics {
  // Sibling pairs would each carry near-1.0 similarityToPrior — keep one
  // per group so the average isn't artificially inflated.
  const collapsed = collapseSiblingsForMetrics(trajectory);
  const sims: number[] = [];
  for (const ev of collapsed) {
    const s = ev.metadata.similarityToPrior;
    if (typeof s === 'number') sims.push(s);
  }
  return {
    avgSimilarityConsecutive: mean(sims),
    similarityStddev: stddev(sims),
  };
}

export interface DiversityMetrics {
  clustersVisited: number;
  clustersToItemsRatio: number;
  maxConsecutiveSameCluster: number;
}

export function computeDiversity(trajectory: TrajectoryEvent[]): DiversityMetrics {
  // Sibling pairs share clusterId by construction — collapse so a sibling
  // duplicate doesn't extend a same-cluster run or shift the items
  // denominator. The denominator (clustersToItemsRatio) uses the post-
  // collapse length so siblings don't deflate the ratio.
  const collapsed = collapseSiblingsForMetrics(trajectory);

  if (collapsed.length === 0) {
    return {
      clustersVisited: 0,
      clustersToItemsRatio: 0,
      maxConsecutiveSameCluster: 0,
    };
  }

  // Null cluster = unknown, not "same as previous null". Treat as a missing
  // observation: don't count toward distinct visits, and never let it extend
  // a same-cluster run. Otherwise a stretch of cluster-less items
  // (missing embeddings, group items, bank cards) falsely trips the
  // stuck-in-cluster pathology.
  const distinct = new Set<string>();
  let maxRun = 0;
  let curRun = 0;
  let prev: string | null = null;
  for (const ev of collapsed) {
    const cid = ev.metadata.clusterId ?? null;
    if (cid === null) {
      curRun = 0;
      prev = null;
      continue;
    }
    distinct.add(cid);
    if (cid === prev) {
      curRun += 1;
    } else {
      curRun = 1;
    }
    if (curRun > maxRun) maxRun = curRun;
    prev = cid;
  }

  return {
    clustersVisited: distinct.size,
    clustersToItemsRatio: distinct.size / collapsed.length,
    maxConsecutiveSameCluster: maxRun,
  };
}

export interface CalibrationMetrics {
  avgPredictedRecall: number | null;
  difficultyMix: Record<'scaffolding' | 'standard' | 'stretch' | 'unknown', number>;
}

export function computeCalibration(trajectory: TrajectoryEvent[]): CalibrationMetrics {
  const recalls: number[] = [];
  const mix = { scaffolding: 0, standard: 0, stretch: 0, unknown: 0 };
  for (const ev of trajectory) {
    const r = ev.metadata.predictedRecall;
    if (typeof r === 'number') recalls.push(r);
    const tier = ev.metadata.difficultyTier;
    if (tier === 'scaffolding' || tier === 'standard' || tier === 'stretch') {
      mix[tier] += 1;
    } else {
      mix.unknown += 1;
    }
  }
  return {
    avgPredictedRecall: mean(recalls),
    difficultyMix: mix,
  };
}

export interface RecoveryMetrics {
  scaffoldingRateAfterMiss: number | null;
  postMissDifficultyDelta: number | null;
  timeToFirstCorrectMs: number | null;
}

const TIER_RANK: Record<'scaffolding' | 'standard' | 'stretch', number> = {
  scaffolding: 0,
  standard: 1,
  stretch: 2,
};

function isMiss(r: ResponseEvent): boolean {
  if (r.eventType === 'card_reviewed') {
    return r.quality != null && r.quality <= 2;
  }
  return r.isCorrect === false;
}

function isCorrectResponse(r: ResponseEvent): boolean {
  if (r.eventType === 'card_reviewed') {
    return r.quality != null && r.quality >= 3;
  }
  return r.isCorrect === true;
}

export function computeRecovery(
  trajectory: TrajectoryEvent[],
  responses: ResponseEvent[],
): RecoveryMetrics {
  if (responses.length === 0) {
    return {
      scaffoldingRateAfterMiss: null,
      postMissDifficultyDelta: null,
      timeToFirstCorrectMs: null,
    };
  }

  const position = new Map<string, number>();
  trajectory.forEach((t, i) => position.set(t.sourceId, i));

  let misses = 0;
  let scaffoldingFollowed = 0;
  const deltas: number[] = [];

  for (const r of responses) {
    if (!isMiss(r)) continue;
    const pos = position.get(r.sourceId);
    if (pos === undefined) continue;
    const missTier = trajectory[pos].metadata.difficultyTier;
    const next = trajectory[pos + 1];
    if (!next) continue;
    misses += 1;
    const nextTier = next.metadata.difficultyTier;
    if (nextTier === 'scaffolding') scaffoldingFollowed += 1;
    if (
      (missTier === 'scaffolding' || missTier === 'standard' || missTier === 'stretch') &&
      (nextTier === 'scaffolding' || nextTier === 'standard' || nextTier === 'stretch')
    ) {
      deltas.push(TIER_RANK[nextTier] - TIER_RANK[missTier]);
    }
  }

  const scaffoldingRateAfterMiss = misses === 0 ? null : scaffoldingFollowed / misses;
  const postMissDifficultyDelta = deltas.length === 0 ? null : mean(deltas);

  const firstCorrect = responses.find(isCorrectResponse);
  const sessionStart = trajectory[0]?.createdAt ?? null;
  const timeToFirstCorrectMs =
    firstCorrect && sessionStart
      ? firstCorrect.createdAt.getTime() - sessionStart.getTime()
      : null;

  return {
    scaffoldingRateAfterMiss,
    postMissDifficultyDelta,
    timeToFirstCorrectMs,
  };
}

export function computeSessionMetrics(session: Session): SessionMetrics {
  const coherence = computeCoherence(session.trajectory);
  const diversity = computeDiversity(session.trajectory);
  const calibration = computeCalibration(session.trajectory);
  const recovery = computeRecovery(session.trajectory, session.responses);

  const totalResponses = session.responses.length;
  const correctResponses = session.responses.filter(isCorrectResponse).length;
  const accuracy = totalResponses === 0 ? null : correctResponses / totalResponses;

  return {
    itemCount: session.trajectory.length,
    accuracy,
    ...coherence,
    ...diversity,
    ...calibration,
    ...recovery,
  };
}
