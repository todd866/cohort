/**
 * Unified Scheduler
 *
 * Constructs study sessions using ConceptMastery (recall probability)
 * instead of per-card due-date queues. This scheduler:
 *
 * 1. Identifies weak concepts (low recallOnExamDay)
 * 2. Decides intervention type per concept:
 *    - Low confidence → probe with MCQ (need more data)
 *    - High confidence + low recall → review cards (known weak)
 * 3. Selects items from weak concepts
 * 4. Avoids interference (similar items spaced apart)
 *
 * This replaces the legacy card-only session builder for session construction.
 */

import { logger } from '@/lib/logger';
import { withQueryCounting } from '@/lib/observability/query-counter';
import {
  buildDifficultyPlan,
  getEffectiveQuestionDifficulty,
  normalizeQuestionDifficulty,
} from './candidate-ranking';
import { resolveCardConceptId } from './scheduler-attribution';
import type { UnifiedSessionOptions, UnifiedSessionResult } from './unified-scheduler-types';
import { constructClusterSession } from './unified-scheduler-cluster-session';
import { assembleSessionResult, attachDeliveryTelemetry } from './unified-scheduler-phase-finalize';
import {
  backfillCardsUncapped,
  backfillFromAnyConcept,
  probeStaleStrongConcepts,
  releaseFirstSightReservation,
  rescueOrphans,
  topUpFromRotationBank,
} from './unified-scheduler-phase-backfill';
import { applyStruggleToSelection, orderSessionItems } from './unified-scheduler-phase-queue';
import { loadSchedulerInputs } from './unified-scheduler-phase-load';
import { resolveSchedulerSetup } from './unified-scheduler-phase-setup';
import {
  createSessionBuild,
  fillCards,
  fillCoverageLane,
  fillQuestions,
  holdBackUnearnedStages,
  preTeachNaiveConcepts,
  preTeachVideos,
  reserveAppliedSurplus,
  reserveScheduledCore,
} from './unified-scheduler-phase-select';
import {
  findPristineConcepts,
  planCardQuota,
  rankConcepts,
  selectWeakConcepts,
  sortConceptsByPriority,
} from './unified-scheduler-phase-concepts';
import type { ConceptPlan } from './unified-scheduler-phase-types';

export { resolveCardConceptId };

// The public surface this module has always had. Its types, scoring helpers and
// diagnostics now live in the unified-scheduler-* modules beside it and are
// re-exported here, so existing imports of this file keep working.
export type {
  ConceptState,
  ScheduledExamTargetCandidateTrace,
  ScheduledExamTargetItemTrace,
  SessionMode,
  UnifiedSessionExamTargetDecision,
  UnifiedSessionItem,
  UnifiedSessionOptions,
  UnifiedSessionResult,
  UnifiedSessionSelectionDeterminism,
} from './unified-scheduler-types';
export {
  CLUSTER_DAMPEN_FLOOR,
  CLUSTER_FREE_EXPOSURES,
  HIGH_RECALL_PRIORITY_MULTIPLIER,
  allocateExamTargetConceptOrder,
  buildClusterRoundRobin,
  clusterExposureDampening,
  computeExamPressure,
  computeRecallSoftPenalty,
  enforceConceptTeachingCaps,
  isCalibratedReviewItem,
  resolveExamTargetEvaluationInfluence,
  resolveMaxNewCards,
} from './unified-scheduler-scoring';
export type {
  AllocateExamTargetConceptOrderInput,
  ExamTargetConceptAllocationMapping,
  ExamTargetConceptAllocationOrder,
} from './unified-scheduler-scoring';
export { getConceptDiagnostics } from './unified-scheduler-diagnostics';

// =============================================================================
// Main Function
// =============================================================================

/**
 * Construct a unified study session driven by ConceptMastery
 */
/**
 * Public entry: builds a session and emits per-pass scheduler telemetry.
 *
 * Wraps the implementation in a query-counting scope so we capture how many DB
 * queries one scheduling pass issues. Latency was already logged downstream
 * (`schedulerMs`); query count is the missing N+1 / cost-creep signal — it
 * scales with every heuristic we add × sessions × users. Emitted as a
 * `scheduler.pass` structured log; querying that in Vercel shows whether the
 * per-session DB cost is drifting up over time.
 */
export async function constructUnifiedSession(
  userId: string,
  options: UnifiedSessionOptions
): Promise<UnifiedSessionResult> {
  const tracked = await withQueryCounting(() =>
    constructUnifiedSessionImpl(userId, options)
  );

  logger.info('scheduler.pass', {
    userId,
    rotation: options.rotation,
    week: options.week ?? null,
    size: options.size ?? null,
    mode: options.mode ?? null,
    durationMs: tracked.durationMs,
    queryCount: tracked.queryCount,
    items: tracked.result.items.length,
    concepts: tracked.result.stats.totalConcepts,
  });

  return tracked.result;
}

async function constructUnifiedSessionImpl(
  userId: string,
  options: UnifiedSessionOptions
): Promise<UnifiedSessionResult> {
  // 1+2. Settle the request: the clock and seeds, the exam horizon, the exclusions and
  // the concepts. Everything here happens before any read that depends on the concepts.
  const setup = await resolveSchedulerSetup(userId, options);
  const {
    rotation,
    size,
    concepts,
    excludedCardIds,
    excludedQuestionIds,
    selectionDeterminism,
    readPreselection,
    effectiveMaxNewCards,
    cardRatio,
  } = setup;

  if (concepts.length === 0) {
    // No Concept rows for this rotation → cluster fallback. Logged so a seed/config
    // gap (a rotation that SHOULD be conceptualized but isn't — the class the team
    // closed by conceptualizing CAH/PWH) is distinguishable at serve time from a
    // genuinely cluster-only rotation.
    logger.warn('scheduler: no concepts for rotation, using cluster fallback', { rotation });
    // The fallback returns before the normal bulk/mastery boundary. Cache its
    // complete result as one branch-local snapshot so a paired concept-empty
    // request cannot reopen a second repository view midway through the pair.
    return readPreselection('cluster-fallback-session', () => constructClusterSession(userId, {
        rotation,
        size,
        cardRatio,
        maxNewCards: effectiveMaxNewCards,
        minFirstSightItems: options.minFirstSightItems ?? 0,
        excludeCardIds: [...excludedCardIds],
        excludeQuestionIds: [...excludedQuestionIds],
        practiceLocale: options.practiceLocale ?? 'au',
        crossSourceRotations: options.crossSourceRotations ?? [],
        crossSourceMappingMode: options.crossSourceMappingMode ?? 'adjacent',
        isCopyrightTier: options.imageTier === 'copyright',
        ...(selectionDeterminism ? { selectionDeterminism } : {}),
      }));
  }

  // 3. Everything that depends on the concepts: the reads, the frozen read boundary,
  // and the values derived from them.
  const inputs = await loadSchedulerInputs(setup);

  // 4. Compute concept states with priority scores
  const ranking = rankConcepts(inputs);

  // 5. Sort by priority (highest first) with jitter to avoid deterministic ordering.
  sortConceptsByPriority(inputs, ranking);

  // Precompute which concepts have unseen cards in bulk: used for the strong-but-pristine
  // extension of phase 6 and for the coverage lane (7d).
  const conceptHasPristine = findPristineConcepts(inputs);

  // 6. Select the concepts that need work (and shift the card ratio if breadth is narrowing).
  const selection = selectWeakConcepts(inputs, ranking, conceptHasPristine);

  // How many cards and questions the session wants, and the seats the coverage lane holds.
  const quota = planCardQuota(inputs, selection.cardRatio);

  // What phases 4 to 6 decided: the ranked concepts, the weak set the session works,
  // and the indexes over the candidate pool that selection consults.
  const plan: ConceptPlan = {
    ...ranking,
    ...selection,
    ...quota,
    conceptHasPristine,
  };

  // 7. Select items from top concepts
  const build = createSessionBuild(inputs, plan);

  // 7a-core) Reserve today's scheduled atomic facts before any ordinary concept, applied
  // or cross-source selection.
  reserveScheduledCore(inputs, plan, build);

  // 7a-surplus) Spend the surplus capacity after the core reservation on eligible applied
  // distinctions before breadth.
  reserveAppliedSurplus(inputs, plan, build);

  // Hold back what the learner has not yet earned the right to see.
  holdBackUnearnedStages(inputs, build);

  // 7a) NEW: Video Pre-teach (Inject videos for very weak concepts)
  preTeachVideos(inputs, plan, build);

  // 7a-naive) Naive-concept pre-teach: a topic-matched C1 card before the fill loops
  // reach a concept the learner has never seen.
  preTeachNaiveConcepts(inputs, plan, build);

  // 7b) Fill questions (round-robin across clusters)
  fillQuestions(inputs, plan, build);

  // 7c) Fill cards (round-robin across clusters for spatial diversity)
  fillCards(inputs, plan, build);

  // 7d) Coverage lane: pristine cards from concepts the main loops would not reach
  fillCoverageLane(inputs, plan, build);

  // 8. If still short on items, backfill from any concepts (cards + questions)
  backfillFromAnyConcept(inputs, plan, build);

  // 8.2. Maintenance probing: pull questions from strong concepts not probed recently
  probeStaleStrongConcepts(inputs, plan, build);

  // 8b. Rotation-bank top-up: pad an under-filled batch with unanswered questions
  await topUpFromRotationBank(inputs, plan, build);

  // 8c. Final uncapped card backfill
  backfillCardsUncapped(inputs, plan, build);

  // 8d. Orphan rescue: the final fill for otherwise-unreachable cards and questions
  rescueOrphans(inputs, plan, build);

  // Release the first-sight reservation when the pool cannot meet it
  releaseFirstSightReservation(inputs, build);

  // 8.5. Apply struggle interventions to stuck cards
  const itemsWithInterventions = await applyStruggleToSelection(inputs, build);

  // 9. Order by manifold walk, then pair scaffolds and apply the final guards
  const { finalOrdered, cardMetaById } = await orderSessionItems(inputs, plan, build, itemsWithInterventions);

  // 10. Attach delivery-grounded policy and item-recall telemetry after ordering
  // (see attachDeliveryTelemetry).
  const telemetry = attachDeliveryTelemetry(inputs, plan, build, finalOrdered, cardMetaById);

  // 11. Compute stats and assemble the result
  return assembleSessionResult(inputs, plan, build, finalOrdered, telemetry);
}


// Re-exported from candidate-ranking.ts for backward compatibility with tests
export { buildDifficultyPlan, normalizeQuestionDifficulty, getEffectiveQuestionDifficulty };
