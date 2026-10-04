/**
 * Unified scheduler: the concept plan
 *
 * Phases 4 to 6 of a session build decide which concepts the session works: phase 4
 * ranks them, phase 5 sorts them with jitter, phase 6 picks the weak set. The
 * bodies were moved unchanged out of constructUnifiedSessionImpl; the first lines
 * of each function name the fields it reads.
 */

import { teachingWeekForTopics } from '@/lib/curriculum/teaching-pace';
import { type ExamTargetLearnerPolicy, buildExamTargetLearnerPolicy } from '@/lib/exam-target/learner-policy';
import { logger } from '@/lib/logger';
import { truncateToManifoldDim } from '@/lib/manifold/exam-target';
import { expandTopicSet } from '@/lib/topics';
import { teachingCadenceConceptBoost } from './curriculum-pacing';
import { cosineSimilarity } from './manifold-walk';
import { PRACTICE_MISS_BOOST } from './practice-miss-concepts';
import { computeHubReadiness, computeKnowledgeBreadth, computeMaintenanceShift } from './scheduler-signals';
import { applyDecay, projectRecallToExamDay } from './state';
import { computeExposuresNeeded } from './throughput';
import { reviewLearningPolicy } from '@/lib/study/review-learning-policy';
import { DEFAULTS, RECALL_RANKING_HORIZON_DAYS, stableTargetRandom } from './unified-scheduler-config';
import type {
  CardQuota,
  ConceptRanking,
  ConceptSelection,
  SchedulerInputs,
} from './unified-scheduler-phase-types';
import {
  allocateExamTargetConceptOrder,
  clusterExposureDampening,
  computeRecallSoftPenalty,
} from './unified-scheduler-scoring';
import type { ConceptState } from './unified-scheduler-types';

/**
 * Phase 4: compute every concept's state and priority.
 *
 * Each concept's recall is decayed to now and projected to exam day, its
 * intervention decided (probe, remediate or reinforce), and its priority scored
 * from the recall gap and the boosts for low confidence, stale probes, exam cold
 * spots, likes, acute failures, practice misses and the teaching cadence. An active
 * exam-target treatment then scales the priorities and supplies the item-level
 * scores; weak concepts pull their prerequisites forward (4b), hub concepts whose
 * prerequisites are not ready are held back (4c), and clusters already served
 * heavily today yield (4e). Last it indexes the candidate pool (unseen cards,
 * rotations, cross-source ids) for the selection lanes.
 */
export function rankConcepts(inputs: SchedulerInputs): ConceptRanking {
  const {
    applyExamTarget,
    bulk,
    chronicFailureConceptIds,
    conceptEmbeddings,
    conceptMap,
    conceptTargetScores,
    concepts,
    daysToExam,
    effectiveMaxNewCards,
    effectiveTargetInfluence,
    examPressure,
    gapDirection,
    likedConceptIds,
    options,
    practiceMissConceptIds,
    recentClusterExposures,
    recentFailureConceptIds,
    rotation,
    runtimeTargetSnapshot,
    selectionNowMs,
    stateMap,
    targetSidecarsValid,
  } = inputs;

  // 4. Compute concept states with priority scores
  const now = new Date(selectionNowMs());
  const conceptStates: ConceptState[] = concepts.map((concept) => {
    const state = stateMap.get(concept.id);

    // Time since last interactions
    const daysSinceProbe = state?.lastProbeAt
      ? (now.getTime() - state.lastProbeAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    const daysSinceExposure = state?.lastExposureAt
      ? (now.getTime() - state.lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    // Current state (with decay applied)
    const storedRecall = state?.recallProbability ?? 0;
    const confidence = state?.confidence ?? 0;
    const exposureCount = state?.exposureCount ?? 0;

    // Apply decay since last exposure
    const currentRecall = daysSinceExposure < Infinity
      ? applyDecay(storedRecall, daysSinceExposure, confidence)
      : 0;

    // Project to exam day
    // True exam-day recall — the SEMANTIC value. Hub-readiness gating, prereq
    // gates, intervention urgency, diagnostics, and the returned state all read
    // this, so it must stay uncapped or those behaviours silently shift. Item
    // difficulty uses currentRecall below: today's capability, not forecast decay.
    const recallOnExamDay = projectRecallToExamDay(currentRecall, daysToExam, confidence);
    // RANKING recall: the same projection horizon-capped so priority stays
    // discriminating far from exam, where the true exam-day recall collapses to
    // ~0 for every concept (examPressure carries exam urgency separately). Used
    // ONLY for the priority gap below — never as recallOnExamDay's substitute
    // (BACKLOG #9 / adversarial review: capping it everywhere changed
    // hub-readiness, not just the sort).
    const rankingRecall = projectRecallToExamDay(currentRecall, daysToExam, confidence, RECALL_RANKING_HORIZON_DAYS);

    // Decide intervention type
    let intervention: 'probe' | 'remediate' | 'reinforce';
    if (confidence < DEFAULTS.confidenceThreshold || exposureCount < 3) {
      // Not enough data - need to probe
      intervention = 'probe';
    } else if (recallOnExamDay < DEFAULTS.recallThreshold) {
      // Known weak - remediate with cards
      intervention = 'remediate';
    } else if (daysSinceProbe > DEFAULTS.daysSinceProbeThreshold) {
      // Haven't tested recently - probe to verify
      intervention = 'probe';
    } else {
      // Okay but could be stronger
      intervention = 'reinforce';
    }

    // Compute priority score (higher = more urgent)
    // Gap to target (0-0.8 maps to 0.8-0)
    const gapScore = Math.max(0, DEFAULTS.targetRecall - rankingRecall);
    // Low confidence boost
    const confidenceBoost = confidence < DEFAULTS.confidenceThreshold ? 0.2 : 0;
    // Stale probe boost
    const staleBoost = daysSinceProbe > DEFAULTS.daysSinceProbeThreshold ? 0.1 : 0;
    // 256D gap alignment: boost concepts aligned with exam cold spots
    // Base 0.15, scales up to 0.30 as exam approaches (examPressure → 1)
    const rawConceptEmb = conceptEmbeddings.get(concept.id);
    const conceptEmb = rawConceptEmb ? truncateToManifoldDim(rawConceptEmb) : null;
    const gapAlignmentBoost =
      !applyExamTarget && conceptEmb && gapDirection
        ? Math.max(0, cosineSimilarity(conceptEmb, gapDirection)) * (0.15 + examPressure * 0.15)
        : 0;
    // Liked concept boost: user explicitly wants more of this
    const likedBoost = likedConceptIds.has(concept.id) ? 0.15 : 0;
    // Acute-failure boost: user failed this concept in the last 2h. Bump
    // its priority so the next batch fetch (within the same session) surfaces
    // remediation rather than continuing the manifold walk away from the
    // failure. Decays naturally as 2h passes without further failure.
    // Magnitude (0.25) deliberately above likedBoost — fresh failure is a
    // stronger signal than a stale "I like this" preference.
    const recentFailureBoost = recentFailureConceptIds.has(concept.id) ? 0.25 : 0;
    // A line missed in clinical practice this week: a nudge, never protection.
    const practiceMissBoost = practiceMissConceptIds.has(concept.id) ? PRACTICE_MISS_BOOST : 0;
    // Teaching-cadence boost: the concepts the course is lecturing on THIS week
    // come forward. This is the half of curriculum pacing that item ranking
    // cannot do — reordering within a concept's card pool is no help if the
    // session never walks to that concept in the first place.
    const teachingCadenceBoost = teachingCadenceConceptBoost(
      teachingWeekForTopics(concept.topics, options.topicTeachingWeeks),
      options.currentTeachingWeek,
    );
    // Exam weight multiplier
    // Density-derived Concept.examWeight is a legacy fallback, not an exam
    // blueprint. A valid v2 treatment starts neutral, then receives the
    // evidence-bounded learner/domain multiplier in the second pass below.
    const examWeightMultiplier = applyExamTarget
      ? 1
      : (concept.examWeight || 1) / 3; // Normalize 1-5 to ~0.3-1.7

    // Soft-deprioritise concepts whose current recall is already very high so
    // session-average predictedRecall lands in the desirable 0.6-0.8 band rather
    // than the >0.85 "wasting review time" band flagged by walk-audit.
    // Chronic-failure concepts opt out: even if the model thinks recall is high,
    // we know the user keeps missing items in this concept — keep them surfaced
    // so struggle-interventions can scaffold them.
    const recallSoftPenalty = computeRecallSoftPenalty(currentRecall, confidence, {
      isChronicFailure: chronicFailureConceptIds.has(concept.id),
    });

    const priority =
      (gapScore + confidenceBoost + staleBoost + gapAlignmentBoost + likedBoost + recentFailureBoost
        + practiceMissBoost + teachingCadenceBoost) *
      examWeightMultiplier *
      recallSoftPenalty;

    return {
      conceptId: concept.id,
      conceptName: concept.name,
      currentRecall,
      recallOnExamDay,
      confidence,
      exposureCount,
      daysSinceProbe,
      daysSinceExposure,
      priority,
      intervention,
    };
  });

  let learnerTargetPolicy: ExamTargetLearnerPolicy | null = null;
  if (targetSidecarsValid && runtimeTargetSnapshot) {
    learnerTargetPolicy = buildExamTargetLearnerPolicy({
      definition: {
        ...runtimeTargetSnapshot.definition,
        influence: effectiveTargetInfluence ?? runtimeTargetSnapshot.definition.influence,
      },
      conceptMappings: conceptTargetScores.scores,
      conceptStates: new Map(conceptStates.map(state => [state.conceptId, {
        projectedRecall: state.recallOnExamDay,
        stateConfidence: state.confidence,
      }])),
      itemScores: bulk.examTargetItemScores,
    });
    if (applyExamTarget) {
      for (const state of conceptStates) {
        state.priority *= learnerTargetPolicy.conceptMultipliers.get(state.conceptId) ?? 1;
      }
    }
  }

  // 4b. Prerequisite boosting: weak concepts pull their prereqs forward so sessions
  // naturally include “build-up” items before high-integration items.
  const statesById = new Map(conceptStates.map((s) => [s.conceptId, s]));
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  for (const concept of concepts) {
    const state = statesById.get(concept.id);
    if (!state) continue;
    if (state.recallOnExamDay >= DEFAULTS.targetRecall) continue;

    const baseBoost = state.priority * 0.85;
    if (baseBoost <= 0) continue;

    const visited = new Set<string>([concept.id]);
    const queue: Array<{ id: string; depth: number }> = concept.prerequisiteIds.map((id) => ({
      id,
      depth: 1,
    }));

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (visited.has(next.id)) continue;
      visited.add(next.id);

      const prereq = statesById.get(next.id);
      if (!prereq) continue;

      const boostedPriority = baseBoost * Math.pow(0.7, next.depth - 1);

      // Don’t waste slots on prereqs already very solid.
      const prereqIsSolid =
        prereq.recallOnExamDay >= DEFAULTS.targetRecall && prereq.confidence >= DEFAULTS.confidenceThreshold;
      if (!prereqIsSolid) {
        prereq.priority = Math.max(prereq.priority, boostedPriority);
      }

      // Expand transitively (depth-capped).
      if (next.depth < 3) {
        const prereqConcept = conceptById.get(next.id);
        if (!prereqConcept) continue;

        for (const prereqId of prereqConcept.prerequisiteIds) {
          if (!visited.has(prereqId)) {
            queue.push({ id: prereqId, depth: next.depth + 1 });
          }
        }
      }
    }
  }

  // 4c. Hub readiness gating: dampen hub concepts whose prerequisites aren't ready.
  // This is complementary to prerequisite boosting above — boosting pulls prereqs forward,
  // gating holds hubs back. Together they ensure sessions build foundations before testing connections.
  const prereqRecallMap = new Map(
    conceptStates.map((s) => [s.conceptId, s.recallOnExamDay]),
  );
  for (const concept of concepts) {
    if (concept.prerequisiteIds.length === 0) continue;
    const state = statesById.get(concept.id);
    if (!state) continue;

    const hubReady = computeHubReadiness(concept.prerequisiteIds, prereqRecallMap);
    if (!hubReady.ready) {
      state.priority *= hubReady.dampening;
    }
  }

  // 4d. Bulk candidates were started in parallel with step 3 and joined above
  // so an active treatment can fail closed before any priority changes occur.
  const activeCardTargetScores = new Map<string, number>();
  const activeQuestionTargetScores = new Map<string, number>();
  if (applyExamTarget && learnerTargetPolicy) {
    for (const [itemKey, score] of learnerTargetPolicy.itemPersonalizedScores) {
      if (itemKey.startsWith('card:')) activeCardTargetScores.set(itemKey.slice(5), score);
      else if (itemKey.startsWith('question:')) activeQuestionTargetScores.set(itemKey.slice(9), score);
    }
  }
  const activeTargetRankMove = applyExamTarget && runtimeTargetSnapshot
    ? (effectiveTargetInfluence?.maxItemRankMove ?? 0)
    : 0;
  // Card-level gapBoost is now driven by SQL-side cardGapAlignment (populated
  // when scoreItemsByGapAlignment is wired up; no-op while courseware_embeddings
  // is empty). The per-concept gapAlignmentBoost above still uses the JS
  // gapDirection because it operates on ~100 concept vectors, not thousands of
  // cards. See docs/superpowers/plans/2026-04-28-embedding-egress-elimination.md.

  // Build topic→cluster map from bulk card data for round-robin grouping
  const topicToCluster = new Map<string, string>();
  for (const card of [...bulk.unseenCards, ...bulk.seenCards]) {
    if (!card.clusterId) continue;
    for (const topic of card.topics) {
      if (!topicToCluster.has(topic)) {
        topicToCluster.set(topic, card.clusterId);
      }
    }
  }

  function getConceptCluster(concept: ConceptState): string {
    const conceptData = conceptMap.get(concept.conceptId);
    if (!conceptData) return concept.conceptId;
    for (const topic of conceptData.topics) {
      const cluster = topicToCluster.get(topic);
      if (cluster) return cluster;
    }
    return concept.conceptId; // fallback: each concept is its own group
  }

  // 4e. Inter-session cluster dampening. A cluster keeps its first few cards
  // of the day, then yields so the next batch can reach a domain that has
  // not already filled the last 24 hours.
  if (recentClusterExposures && recentClusterExposures.size > 0) {
    const totalRecentExposures = [...recentClusterExposures.values()].reduce((sum, c) => sum + c, 0);
    if (totalRecentExposures > 0) {
      for (const state of conceptStates) {
        const conceptCluster = getConceptCluster(state);
        const clusterCount = recentClusterExposures.get(conceptCluster) ?? 0;
        state.priority *= clusterExposureDampening(clusterCount);
      }
    }
  }

  // Track unseen card IDs for new-card budget enforcement
  const unseenCardIds = new Set(bulk.unseenCards.map(c => c.id));
  const maxNewCards = effectiveMaxNewCards ?? Infinity;
  const crossSourceRotations = new Set(options.crossSourceRotations ?? []);
  const cardRotationById = new Map(
    [...bulk.unseenCards, ...bulk.seenCards].map((card) => [card.id, card.rotation]),
  );
  // Corpus identity for fair seat allocation in a composed deck. `sourceFile`
  // is already selected on the bulk cards, so this costs no extra query.
  const cardSourceFileById = new Map(
    [...bulk.unseenCards, ...bulk.seenCards].map((card) => [card.id, card.sourceFile]),
  );
  const questionRotationById = new Map(
    bulk.rotationQuestions.map((question) => [question.id, question.rotation]),
  );
  const crossSourceCardIds = new Set(
    [...cardRotationById]
      .filter(([, cardRotation]) => crossSourceRotations.has(cardRotation))
      .map(([cardId]) => cardId),
  );
  const crossSourceQuestionIds = new Set(
    [...questionRotationById]
      .filter(([, questionRotation]) => crossSourceRotations.has(questionRotation))
      .map(([questionId]) => questionId),
  );
  const maxCrossSourceItems = Math.max(0, Math.floor(options.maxCrossSourceItems ?? 0));
  const unknownItemRotation = crossSourceRotations.size === 0
    ? rotation
    : '__outside-authorized-candidate-scope__';

  return {
    conceptStates,
    statesById,
    learnerTargetPolicy,
    activeCardTargetScores,
    activeQuestionTargetScores,
    activeTargetRankMove,
    getConceptCluster,
    unseenCardIds,
    maxNewCards,
    cardRotationById,
    cardSourceFileById,
    questionRotationById,
    crossSourceCardIds,
    crossSourceQuestionIds,
    maxCrossSourceItems,
    unknownItemRotation,
  };
}

/**
 * Phase 5: sort the concept states by priority, highest first, in place.
 *
 * Each priority is first nudged by seeded jitter (or unseeded random when the
 * request carries no tie-break seed), so a different set of weak concepts leads
 * each session instead of the same few every time.
 */
export function sortConceptsByPriority(
  inputs: SchedulerInputs,
  ranking: Pick<ConceptRanking, 'conceptStates'>,
): void {
  const { options } = inputs;
  const { conceptStates } = ranking;

  // 5. Sort by priority (highest first) with jitter to avoid deterministic ordering.
  // ±30% jitter ensures different weak concepts surface each session instead of
  // the same top-7 dominating every time. High-urgency items still appear often
  // but aren't guaranteed to fill every session.
  for (const state of conceptStates) {
    const jitter = (
      stableTargetRandom(options.examTargetTieBreakSeed, state.conceptId) - 0.5
    ) * 0.6 * Math.max(state.priority, 0.05);
    state.priority += jitter;
  }
  conceptStates.sort((a, b) => b.priority - a.priority);
}

/**
 * The concepts that have at least one unseen card in the candidate pool.
 *
 * Both the strong-but-pristine extension of phase 6 and the coverage lane of
 * phase 7 consult it.
 */
export function findPristineConcepts(inputs: SchedulerInputs): Set<string> {
  const { bulk, concepts } = inputs;

  // Precompute which concepts have unseen cards in bulk — used both for
  // the strong-but-pristine extension below AND for the coverage lane (7d).
  // One pass over (concepts × unseen cards), cached for reuse.
  const conceptHasPristine = new Set<string>();
  for (const c of concepts) {
    const topicSet = new Set<string>(expandTopicSet(c.topics));
    for (const card of bulk.unseenCards) {
      if (card.topics.some((t) => topicSet.has(t))) {
        conceptHasPristine.add(c.id);
        break;
      }
    }
  }

  return conceptHasPristine;
}

/**
 * Phase 6: choose the concepts the session works.
 *
 * Takes the weak concepts plus the strong-but-pristine ones, drops those already
 * projected to pass on exam day, lets an active exam-target treatment reallocate
 * the order across domains, and shifts the card ratio toward cards when the
 * learner's knowledge breadth is narrowing.
 *
 * `ranking` is phase 4's output after phase 5 has sorted it; `conceptHasPristine`
 * is phase 5's.
 */
export function selectWeakConcepts(
  inputs: SchedulerInputs,
  ranking: Pick<ConceptRanking, 'conceptStates' | 'learnerTargetPolicy'>,
  conceptHasPristine: ReadonlySet<string>,
): ConceptSelection {
  const {
    applyExamTarget,
    conceptTargetScores,
    daysToExam,
    effectiveTargetInfluence,
    observedExamTargetDomainCounts,
    options,
    recentFailureConceptIds,
    runtimeTargetSnapshot,
    targetWorkload,
  } = inputs;
  const { conceptStates, learnerTargetPolicy } = ranking;
  let { cardRatio } = inputs;

  // 6. Select concepts that need work.
  //   Primary: weak by recall (recallOnExamDay < targetRecall).
  //   Extension: STRONG-BUT-PRISTINE concepts (recall >= targetRecall but with
  //   unseen cards still in bulk). Previously these were excluded entirely
  //   and only reachable via the meager coverage lane (7d, ~2 reserved slots).
  //   PAAM postmortem: at exam time ~68% of pristine cards lived behind
  //   strong concepts → structurally unreachable. Including them in the
  //   weak-set lets the round-robin surface their pristine cards, naturally
  //   throttled by:
  //     - recallSoftPenalty (deprioritises high-recall concepts)
  //     - teaching cap (mastered concepts get 1 maintenance item)
  //   so they don't crowd out genuinely weak concepts.
  let weakConcepts = conceptStates.filter(
    (s) => s.recallOnExamDay < DEFAULTS.targetRecall || conceptHasPristine.has(s.conceptId)
  );


  // 6b. Budget-aware filtering: skip concepts already projected to pass on exam day.
  // Uses currentRecall (not recallOnExamDay) because computeExposuresNeeded
  // applies its own forward projection internally.
  const budgetFilteredConcepts = weakConcepts.filter((c) => {
    const needed = computeExposuresNeeded(
      c.currentRecall, DEFAULTS.targetRecall, c.confidence, daysToExam
    );
    // Strong-pristine concepts are here precisely because they still contain
    // untouched material. A mastery-only budget must not immediately remove
    // the concepts the un-starve path just admitted.
    return needed > 0 || conceptHasPristine.has(c.conceptId);
  });
  if (budgetFilteredConcepts.length > 0) {
    weakConcepts = budgetFilteredConcepts;
  }

  let allocationChangedConceptMembershipCount = 0;
  let allocationCoverageDebtDomainCodes: string[] = [];
  let allocatedConceptRanks: Map<string, number> | null = null;
  if (
    applyExamTarget
    && learnerTargetPolicy
    && runtimeTargetSnapshot
    && (targetWorkload?.surplusSeats ?? 0) > 0
    && weakConcepts.length > 0
  ) {
    const allocated = allocateExamTargetConceptOrder({
      concepts: weakConcepts,
      protectedConceptIds: recentFailureConceptIds,
      requestedDiscretionarySize: targetWorkload?.surplusSeats ?? 0,
      conceptMappings: conceptTargetScores.scores,
      desiredShares: new Map(
        [...learnerTargetPolicy.desiredDomains].map(([domainCode, domain]) => [
          domainCode,
          domain.desiredShare,
        ]),
      ),
      observedDomainCounts: observedExamTargetDomainCounts,
      influence: effectiveTargetInfluence ?? runtimeTargetSnapshot.definition.influence,
    });
    weakConcepts = allocated.concepts;
    allocatedConceptRanks = new Map(
      weakConcepts.map((concept, rank) => [concept.conceptId, rank]),
    );
    allocationChangedConceptMembershipCount = allocated.changedMembershipCount;
    allocationCoverageDebtDomainCodes = allocated.coverageDebtDomainCodes;
  }

  // 6c. D_eff maintenance shift: when knowledge breadth is narrowing, shift toward
  // broader card reviews (higher cardRatio) instead of deep-diving weak spots with MCQs.
  // See MATH_MODEL.md §8 — D_eff as a health metric.
  // An endpoint policy owns its ratio (0 for hardest questions, 1 for
  // foundations cards). A falsy check here used to turn +2 back into cards.
  if (options.cardRatio == null && reviewLearningPolicy(options.reviewChallenge).level === 0) {
    const conceptRecalls = conceptStates.map((s) => s.recallOnExamDay);
    const breadth = computeKnowledgeBreadth(conceptRecalls);
    const maintenanceShift = computeMaintenanceShift(breadth.breadthRatio, conceptStates.length);
    if (maintenanceShift > 0) {
      cardRatio = Math.min(0.9, cardRatio + maintenanceShift);
      logger.debug('D_eff maintenance shift', {
        dEff: breadth.dEff.toFixed(1),
        breadthRatio: breadth.breadthRatio.toFixed(2),
        maintenanceShift: maintenanceShift.toFixed(2),
        adjustedCardRatio: cardRatio.toFixed(2),
      });
    }
  }

  return {
    weakConcepts,
    allocatedConceptRanks,
    allocationChangedConceptMembershipCount,
    allocationCoverageDebtDomainCodes,
    cardRatio,
  };
}

/**
 * Phase 6, last step: how many cards and questions the session wants.
 *
 * The ordinary card/question blend is a preference after the current-exam
 * obligation: if today's atomic-fact quota is larger, cards claim those seats
 * first and questions use only the remainder. It also sets aside the coverage
 * lane's seats. `cardRatio` is the ratio after the maintenance shift of
 * selectWeakConcepts.
 */
export function planCardQuota(inputs: SchedulerInputs, cardRatio: number): CardQuota {
  const { applyExamTarget, effectiveMaxNewCards, options, size, targetWorkload } = inputs;
  const challenge = reviewLearningPolicy(options.reviewChallenge).level;

  // The ordinary card/question blend is a preference after the current-exam
  // obligation. If today's atomic-fact quota is larger, cards claim those
  // seats first; questions use only the remainder.
  const targetCardCount = challenge === 2 ? 0 : challenge === -2 ? size : Math.min(
    size,
    Math.max(
      Math.ceil(size * cardRatio),
      applyExamTarget ? (targetWorkload?.coreTargetSeats ?? size) : 0,
    ),
  );
  const targetQuestionCount = size - targetCardCount;

  // Coverage reservation — slots that the priority-driven 7c cannot consume,
  // so concepts outside `weakConcepts` (e.g., strong but pristine-rich) get a
  // path into every session. See
  // docs/designs/2026-04-29-scheduler-coverage-postmortem.md §10:
  // ~68% of pristine cards in PAAM are reachable only via strong concepts;
  // without a reservation, 7c monopolizes the budget and 8a never fires.
  // Disabled for crunch mode and when the caller pins maxNewCards = 0
  // (since coverage lane only picks pristine cards, it would no-op anyway).
  const coverageReservation =
    options.mode === 'crunch' || effectiveMaxNewCards === 0
      ? 0
      : Math.min(2, Math.max(0, Math.floor(targetCardCount * 0.3)));
  const targetWeakCardCount = Math.max(0, targetCardCount - coverageReservation);

  return {
    targetCardCount,
    targetQuestionCount,
    coverageReservation,
    targetWeakCardCount,
  };
}
