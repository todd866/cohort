import type {
  ConceptThreadWalkMetrics,
  ContentRatingEvent,
  TrajectoryEvent,
  ResponseEvent,
  Session,
  SessionMetrics,
} from './walk-types';
import { computeConceptThreadTelemetry } from './concept-thread-telemetry';
import { RECENT_NEIGHBOR_SIMILARITY_THRESHOLD } from '@/lib/knowledge/recent-neighbor-penalty';
import { trustedServeDecisionIdFromMetadata } from '@/lib/study/serve-decision-provenance';

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

function sourceKey(event: Pick<TrajectoryEvent | ResponseEvent, 'sourceType' | 'sourceId'>): string {
  return `${event.sourceType}:${event.sourceId}`;
}

/**
 * Match answer events back to the exact exposure they grade. New telemetry has
 * a server-authored serveDecisionId on both rows, which disambiguates repeated
 * source IDs in one batch. Older rows fall back to their typed source ID.
 */
function matchedMissPositions(
  trajectory: TrajectoryEvent[],
  responses: ResponseEvent[],
): number[] {
  const positionByDecision = new Map<string, number>();
  const positionBySource = new Map<string, number>();
  trajectory.forEach((event, index) => {
    if (event.metadata.serveDecisionId) {
      positionByDecision.set(event.metadata.serveDecisionId, index);
    }
    positionBySource.set(sourceKey(event), index);
  });

  const positions: number[] = [];
  for (const response of responses) {
    if (!isMiss(response)) continue;
    const serveDecisionId = trustedServeDecisionIdFromMetadata(response.metadata);
    const decisionPosition = serveDecisionId == null
      ? undefined
      : positionByDecision.get(serveDecisionId);
    const position = decisionPosition ?? positionBySource.get(sourceKey(response));
    if (position === undefined || position + 1 >= trajectory.length) continue;
    positions.push(position);
  }
  return positions;
}

function isImmediateScaffoldPairable(event: TrajectoryEvent): boolean {
  // Questions are test items and remain eligible regardless of their reported
  // tier. A C1 card is already the bottom scaffold rung, so another immediate
  // C1 is intentionally not planned after it.
  return event.sourceType === 'question'
    || (event.sourceType === 'card' && event.metadata.difficultyTier !== 'scaffolding');
}

/** Denominator shared by the recovery metric and its pathology threshold. */
export function countImmediateScaffoldEvaluableMisses(
  trajectory: TrajectoryEvent[],
  responses: ResponseEvent[],
): number {
  return matchedMissPositions(trajectory, responses).filter(
    (position) => isImmediateScaffoldPairable(trajectory[position]),
  ).length;
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

  const missPositions = matchedMissPositions(trajectory, responses);
  let scaffoldEvaluableMisses = 0;
  let scaffoldingFollowed = 0;
  const deltas: number[] = [];

  for (const position of missPositions) {
    const missed = trajectory[position];
    const missTier = missed.metadata.difficultyTier;
    const next = trajectory[position + 1];
    const nextTier = next.metadata.difficultyTier;
    if (isImmediateScaffoldPairable(missed)) {
      scaffoldEvaluableMisses += 1;
      if (nextTier === 'scaffolding') scaffoldingFollowed += 1;
    }
    if (
      (missTier === 'scaffolding' || missTier === 'standard' || missTier === 'stretch') &&
      (nextTier === 'scaffolding' || nextTier === 'standard' || nextTier === 'stretch')
    ) {
      deltas.push(TIER_RANK[nextTier] - TIER_RANK[missTier]);
    }
  }

  const scaffoldingRateAfterMiss = scaffoldEvaluableMisses === 0
    ? null
    : scaffoldingFollowed / scaffoldEvaluableMisses;
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

export interface PolicyTelemetryMetrics {
  challengePolicyCoverage: number | null;
  challengeMatchRate: number | null;
  challengeAppliedRate: number | null;
  avgChallengeDistance: number | null;
  noveltyPolicyCoverage: number | null;
  recentNearDuplicateRate: number | null;
  avgNoveltyPenalty: number | null;
}

export function computePolicyTelemetry(
  trajectory: TrajectoryEvent[],
): PolicyTelemetryMetrics {
  const reviewItems = trajectory.filter(
    event => event.sourceType === 'card' || event.sourceType === 'question',
  );
  const challengeObserved = reviewItems.filter(
    event => typeof event.metadata.challengePolicyVersion === 'string'
      && typeof event.metadata.challengeDistance === 'number',
  );
  const challengeDistances = challengeObserved.map(
    event => event.metadata.challengeDistance as number,
  );
  const cardItems = reviewItems.filter(event => event.sourceType === 'card');
  const noveltyObserved = cardItems.filter(
    event => typeof event.metadata.noveltyPolicyVersion === 'string',
  );
  const noveltySimilarities = noveltyObserved
    .map(event => event.metadata.recentNeighborSimilarity)
    .filter((value): value is number => typeof value === 'number');
  const noveltyPenalties = noveltyObserved
    .map(event => event.metadata.noveltyPenalty)
    .filter((value): value is number => typeof value === 'number');

  return {
    challengePolicyCoverage: reviewItems.length === 0
      ? null
      : challengeObserved.length / reviewItems.length,
    challengeMatchRate: challengeObserved.length === 0
      ? null
      : challengeDistances.filter(distance => distance === 0).length / challengeObserved.length,
    challengeAppliedRate: challengeObserved.length === 0
      ? null
      : challengeObserved.filter(event => event.metadata.challengePolicyApplied === true).length
        / challengeObserved.length,
    avgChallengeDistance: mean(challengeDistances),
    noveltyPolicyCoverage: cardItems.length === 0
      ? null
      : noveltyObserved.length / cardItems.length,
    recentNearDuplicateRate: noveltyObserved.length === 0
      ? null
      : noveltySimilarities.filter(
        similarity => similarity > RECENT_NEIGHBOR_SIMILARITY_THRESHOLD,
      ).length / noveltyObserved.length,
    avgNoveltyPenalty: mean(noveltyPenalties),
  };
}

export function computeWalkConceptThreadTelemetry(
  sessions: readonly Pick<Session, 'trajectory' | 'responses'>[],
): ConceptThreadWalkMetrics {
  const telemetry = computeConceptThreadTelemetry(
    sessions.flatMap((session) => {
      const responses = [...session.responses]
        .filter(response => response.eventType === 'mcq_attempted')
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
      const consumedResponseIndexes = new Set<number>();

      return session.trajectory.flatMap((event, eventIndex) => {
        // clinical-thread-facets-v1 evaluates question candidates only. Cards
        // may be successful anchors, but are deliberately outside coverage.
        if (event.sourceType !== 'question') return [];
        const nextSameQuestion = session.trajectory
          .slice(eventIndex + 1)
          .find(next => next.sourceType === 'question' && next.sourceId === event.sourceId);
        const responseIndex = responses.findIndex((response, index) => (
          !consumedResponseIndexes.has(index)
          && response.sourceType === 'question'
          && response.sourceId === event.sourceId
          && response.createdAt >= event.createdAt
          && (!nextSameQuestion || response.createdAt < nextSameQuestion.createdAt)
        ));
        if (responseIndex >= 0) consumedResponseIndexes.add(responseIndex);
        return [{
          metadata: event.metadata,
          isCorrect: responseIndex >= 0 ? responses[responseIndex].isCorrect : null,
        }];
      });
    }),
  );
  return {
    conceptThreadEligibleCount: telemetry.eligibleCount,
    conceptThreadPolicyObservedCount: telemetry.policyObservedCount,
    conceptThreadPolicyCoverage: telemetry.policyCoverage,
    conceptThreadAppliedCount: telemetry.appliedCount,
    conceptThreadAppliedRate: telemetry.appliedRate,
    conceptThreadCompleteAppliedCount: telemetry.completeAppliedCount,
    conceptThreadMedianAgeMs: telemetry.medianAgeMs,
    conceptThreadAgeSampleCount: telemetry.ageSampleCount,
    conceptThreadMedianInterveningExposures: telemetry.medianInterveningExposures,
    conceptThreadInterveningExposureSampleCount:
      telemetry.interveningExposureSampleCount,
    conceptThreadAnsweredAppliedCount: telemetry.answeredAppliedCount,
    conceptThreadAppliedCorrectCount: telemetry.appliedCorrectCount,
    conceptThreadAppliedCorrectnessRate: telemetry.appliedCorrectnessRate,
  };
}

/** Latest append-only vote per delivered decision; clear removes the vote. */
export function collapseContentRatings(
  ratings: ContentRatingEvent[],
): Map<string, ContentRatingEvent> {
  const latest = new Map<string, ContentRatingEvent>();
  for (const rating of [...ratings].sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  )) {
    if (rating.rating === 'clear') {
      latest.delete(rating.serveDecisionId);
    } else {
      latest.set(rating.serveDecisionId, rating);
    }
  }
  return latest;
}

export interface ContentRatingMetrics {
  ratingCount: number;
  ratingResponseRate: number | null;
  positiveRatingRate: number | null;
}

export function computeContentRatingMetrics(
  trajectory: TrajectoryEvent[],
  ratings: ContentRatingEvent[],
): ContentRatingMetrics {
  const eligibleDecisionIds = new Set(
    trajectory
      .filter(event => event.sourceType === 'card' || event.sourceType === 'question')
      .map(event => event.metadata.serveDecisionId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  const active = [...collapseContentRatings(ratings).values()]
    .filter(rating => eligibleDecisionIds.has(rating.serveDecisionId));
  return {
    ratingCount: active.length,
    ratingResponseRate: eligibleDecisionIds.size === 0
      ? null
      : active.length / eligibleDecisionIds.size,
    positiveRatingRate: active.length === 0
      ? null
      : active.filter(rating => rating.rating === 'good').length / active.length,
  };
}

export function computeSessionMetrics(session: Session): SessionMetrics {
  const coherence = computeCoherence(session.trajectory);
  const diversity = computeDiversity(session.trajectory);
  const calibration = computeCalibration(session.trajectory);
  const recovery = computeRecovery(session.trajectory, session.responses);
  const policyTelemetry = computePolicyTelemetry(session.trajectory);
  const conceptThreadTelemetry = computeWalkConceptThreadTelemetry([session]);
  const ratingMetrics = computeContentRatingMetrics(
    session.trajectory,
    session.contentRatings,
  );

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
    ...policyTelemetry,
    ...conceptThreadTelemetry,
    ...ratingMetrics,
  };
}
