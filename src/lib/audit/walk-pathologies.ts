import type { Session, SessionMetrics, Pathology, ResponseEvent } from './walk-types';
import { collapseSiblingsForMetrics } from './walk-metrics';

const DROPOUT_GAP_MS = 30 * 60 * 1000;

/**
 * Audit fires modality-monotony when ≥6 consecutive items of the same sourceType.
 * The scheduler-side guard (see knowledge/modality-guard.ts) keeps trailing same-type
 * runs ≤ MODALITY_MAX_SAME_TYPE_RUN, leaving a one-item buffer below this audit threshold.
 */
export const MODALITY_RUN_THRESHOLD = 6;

/**
 * Minimum miss count before no-scaffolding-on-fail fires. Below this the metric
 * has too little surface area to evaluate scheduler scaffolding behaviour.
 */
export const SCAFFOLDING_MIN_MISSES = 3;

/**
 * Minimum number of observed consecutive-similarity pairs before coherence
 * pathologies fire. A single pair is too noisy to characterize a walk.
 */
export const COHERENCE_MIN_PAIR_OBSERVATIONS = 3;

/**
 * Audit thresholds for an unusually high pre-serve item proxy. This is a
 * review-load heuristic, not a claim that observed item correctness has been
 * calibrated. Outcome calibration lives in the scheduler report's Brier/AUC bins.
 */
export const CALIBRATION_TOO_EASY_THRESHOLD = 0.85;
export const CALIBRATION_ITEM_PENALTY_THRESHOLD = 0.9;

function isMiss(r: ResponseEvent): boolean {
  if (r.eventType === 'card_reviewed') {
    return r.quality != null && r.quality <= 2;
  }
  return r.isCorrect === false;
}

function countCoherencePairObservations(session: Session): number {
  return collapseSiblingsForMetrics(session.trajectory).filter(
    (event) => typeof event.metadata.similarityToPrior === 'number',
  ).length;
}

/**
 * Mirrors the denominator used by computeRecovery: only misses whose source is
 * in the trajectory and has a following item can reveal whether scaffolding
 * followed the miss.
 */
function countEvaluableMisses(session: Session): number {
  const position = new Map<string, number>();
  session.trajectory.forEach((event, index) => position.set(event.sourceId, index));

  return session.responses.filter((response) => {
    if (!isMiss(response)) return false;
    const index = position.get(response.sourceId);
    return index !== undefined && index + 1 < session.trajectory.length;
  }).length;
}

function isPureRereviewSession(session: Session): boolean {
  if (session.trajectory.length === 0) return false;
  return session.trajectory.every((t) => t.metadata.servedBy === 'rereview');
}

function isPureFocusedSession(session: Session): boolean {
  if (session.trajectory.length === 0) return false;
  return session.trajectory.every((t) => t.metadata.servedBy === 'focused');
}

/**
 * Scaffolding-heavy sessions are post-miss teaching bursts: the user failed a
 * K=2 question and the scheduler paired in C1 teaching cards. More than half the
 * trajectory is `difficultyTier='scaffolding'`.
 *
 * These must not be judged for calibration. Scaffolding cards are served
 * *because the user failed* — flagging the session as "too easy" is a category
 * error — and they carry an unreliable predictedRecall (stateless C1 cards
 * inherit a default rather than a measured concept recall), which inflates the
 * session-average predictedRecall. Walk audit 2026-05-15: 6 false-positive
 * calibration-too-easy flags, every one a majority-scaffolding session.
 */
function isScaffoldingHeavySession(session: Session): boolean {
  if (session.trajectory.length === 0) return false;
  const scaffolding = session.trajectory.filter(
    (t) => t.metadata.difficultyTier === 'scaffolding',
  ).length;
  return scaffolding > session.trajectory.length / 2;
}

/**
 * Pool-constrained sessions are ones where the candidate pool is intentionally
 * narrow, so pathologies that assume a varied mixed-feed fire as false
 * positives. Three flavours qualify:
 *
 *   - feedMode='new-only': user is studying never-seen items, often within a
 *     single concept they're exploring.
 *   - servedBy='focused' for every item: focused-session route assembles a
 *     single-topic queue (ECG-only, CXR-only, rotation-only). Modality and
 *     cluster variety are not the design intent.
 *
 * The list is conservative: pure rereview is handled separately because the
 * gating differs (rereview only exempts no-scaffolding-on-fail; modality and
 * calibration can still meaningfully flag a malformed retest).
 */
function isPoolConstrainedSession(session: Session): boolean {
  if (session.feedMode === 'new-only') return true;
  if (isPureFocusedSession(session)) return true;
  return false;
}

export function detectPathologies(
  session: Session,
  metrics: SessionMetrics,
): Pathology[] {
  const flags: Pathology[] = [];
  const poolConstrained = isPoolConstrainedSession(session);

  if (!poolConstrained && metrics.maxConsecutiveSameCluster >= 4) {
    flags.push({
      kind: 'stuck-in-cluster',
      severity: 'warn',
      detail: `Max ${metrics.maxConsecutiveSameCluster} consecutive items in same cluster`,
    });
  }

  const coherencePairObservations = countCoherencePairObservations(session);
  if (
    coherencePairObservations >= COHERENCE_MIN_PAIR_OBSERVATIONS &&
    metrics.avgSimilarityConsecutive != null
  ) {
    if (metrics.avgSimilarityConsecutive < 0.3) {
      flags.push({
        kind: 'thrashing',
        severity: 'warn',
        detail: `Avg similarity ${metrics.avgSimilarityConsecutive.toFixed(2)} (< 0.30 = semantically incoherent)`,
      });
    } else if (metrics.avgSimilarityConsecutive > 0.8) {
      flags.push({
        kind: 'over-tight',
        severity: 'warn',
        detail: `Avg similarity ${metrics.avgSimilarityConsecutive.toFixed(2)} (> 0.80 = stuck in micro-cluster)`,
      });
    }
  }

  // Pure rereview sessions are an explicit retest of cards the user got wrong
  // today — scaffolding is not the intended response. Skip the check.
  // Also require a minimum number of misses to avoid noisy fires on tiny
  // batches where the metric has no follow-up surface to evaluate.
  const evaluableMissCount = countEvaluableMisses(session);
  if (
    !isPureRereviewSession(session) &&
    evaluableMissCount >= SCAFFOLDING_MIN_MISSES &&
    metrics.scaffoldingRateAfterMiss != null &&
    metrics.scaffoldingRateAfterMiss < 0.2 &&
    metrics.accuracy != null &&
    metrics.accuracy < 0.5
  ) {
    flags.push({
      kind: 'no-scaffolding-on-fail',
      severity: 'critical',
      detail: `Scaffolding rate ${(metrics.scaffoldingRateAfterMiss * 100).toFixed(0)}% after ${evaluableMissCount} evaluable misses, session accuracy ${(metrics.accuracy * 100).toFixed(0)}%`,
    });
  }

  // Calibration is gated on poolConstrained: in new-only mode items inherit
  // the user's concept-level recall as a Bayesian prior, so a user studying
  // unseen items in a concept they already know well will *correctly* see
  // high avgPredictedRecall — that's not a calibration bug.
  // It is also gated on scaffolding-heavy sessions: a post-miss teaching burst
  // is not a calibrated review and its predictedRecall is unreliable (see
  // isScaffoldingHeavySession).
  if (!poolConstrained && !isScaffoldingHeavySession(session) && metrics.avgPredictedRecall != null) {
    if (metrics.avgPredictedRecall > CALIBRATION_TOO_EASY_THRESHOLD) {
      flags.push({
        kind: 'calibration-too-easy',
        severity: 'warn',
        detail: `Avg pre-serve item proxy ${metrics.avgPredictedRecall.toFixed(2)} (> ${CALIBRATION_TOO_EASY_THRESHOLD}; review load may be too easy, not observed correctness)`,
      });
    } else if (metrics.avgPredictedRecall < 0.3) {
      flags.push({
        kind: 'calibration-too-hard',
        severity: 'warn',
        detail: `Avg pre-serve item proxy ${metrics.avgPredictedRecall.toFixed(2)} (< 0.30; review load may be too hard, not observed correctness)`,
      });
    }
  }

  let curRun = 1;
  let maxTypeRun = 1;
  for (let i = 1; i < session.trajectory.length; i++) {
    if (session.trajectory[i].sourceType === session.trajectory[i - 1].sourceType) {
      curRun += 1;
      if (curRun > maxTypeRun) maxTypeRun = curRun;
    } else {
      curRun = 1;
    }
  }
  if (!poolConstrained && maxTypeRun >= MODALITY_RUN_THRESHOLD) {
    flags.push({
      kind: 'modality-monotony',
      severity: 'warn',
      detail: `${maxTypeRun} consecutive items of one type (> 5)`,
    });
  }

  if (session.trajectory.length > 0) {
    const lastItem = session.trajectory[session.trajectory.length - 1].createdAt.getTime();
    const lastResponse = session.responses.length > 0
      ? session.responses[session.responses.length - 1].createdAt.getTime()
      : session.trajectory[0].createdAt.getTime();
    if (lastItem - lastResponse > DROPOUT_GAP_MS) {
      flags.push({
        kind: 'dropout',
        severity: 'warn',
        detail: `Last response ${Math.round((lastItem - lastResponse) / 60_000)}min before last item served`,
      });
    }
  }

  // Variant-sibling-repeat: two cards from the same variantGroupId in one
  // session. The unified scheduler's suppression set (Task 11 of the
  // 2026-05-08 cloze-variants design) guarantees at most one sibling per
  // session, so any hit here is a regression worth surfacing. Only cards
  // share the variantGroupId semantic — questions/groups are skipped.
  const groupHits = new Map<string, string[]>(); // groupId → cardIds
  for (const ev of session.trajectory) {
    if (ev.sourceType !== 'card') continue;
    const gid = ev.metadata.variantGroupId ?? null;
    if (!gid) continue;
    const arr = groupHits.get(gid) ?? [];
    arr.push(ev.sourceId);
    groupHits.set(gid, arr);
  }
  for (const [groupId, ids] of groupHits) {
    if (ids.length > 1) {
      flags.push({
        kind: 'variant-sibling-repeat',
        severity: 'warn',
        detail: `Variant group ${groupId} served ${ids.length} sibling cards in one session (${ids.join(', ')})`,
      });
    }
  }

  return flags;
}
