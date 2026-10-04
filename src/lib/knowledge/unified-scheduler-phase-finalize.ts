/**
 * Unified scheduler: finalisation
 *
 * The last two phases of a session build. Phase 10 attaches the delivery-grounded
 * telemetry to the ordered items; phase 11 counts what was selected and assembles
 * the result object. Both bodies were moved unchanged out of
 * constructUnifiedSessionImpl; the first lines of each function name the fields
 * it reads from the inputs, the plan and the build state.
 */

import { tierFromComplexity, tierFromQuestionDifficulty } from '@/lib/audit/walk-metadata';
import { hashExamTargetArtifact } from '@/lib/exam-target/artifact';
import { buildServeConditioning, proximityOverlayFor } from '@/lib/review/serve-conditioning';
import {
  type RepetitionSlotContext,
  buildRepetitionSlotContext,
  shadowForDueId,
} from '@/lib/study/repetition-slot-shadow';
import { getEffectiveQuestionDifficulty } from './candidate-ranking';
import {
  CHALLENGE_POLICY_VERSION,
  challengeTierDistance,
  targetChallengeTierForRecall,
} from './challenge-policy';
import { estimateItemRecall } from './item-recall-estimate';
import { computeConceptPairingRate } from './manifold-walk';
import { RECENT_NEIGHBOR_POLICY_VERSION, recentNeighborSignal } from './recent-neighbor-penalty';
import { isSyntheticConceptAttribution } from './synthetic-concept';
import type { SessionBuildState } from './unified-scheduler-phase-state';
import type { ConceptPlan, SchedulerInputs, SessionCardMeta } from './unified-scheduler-phase-types';
import { isCalibratedReviewItem } from './unified-scheduler-scoring';
import type {
  ScheduledExamTargetCandidateTrace,
  ScheduledExamTargetItemTrace,
  UnifiedSessionExamTargetDecision,
  UnifiedSessionItem,
  UnifiedSessionResult,
} from './unified-scheduler-types';

/** What phase 10 attaches to the ordered items and hands to the result. */
export interface DeliveryTelemetry {
  examTargetDecision: UnifiedSessionExamTargetDecision | undefined;
  repetitionSlotContext: RepetitionSlotContext | null;
}

/**
 * Phase 10: attach delivery-grounded policy and item-recall telemetry to the
 * ordered items, and build the exam-target decision trace for the result.
 *
 * `finalOrdered` is mutated in place: every item gains its challenge, novelty
 * and predicted-recall fields, and cards gain their conditioning and repetition
 * slot. `cardMetaById` is the per-card metadata phase 9 gathered.
 */
export function attachDeliveryTelemetry(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
  finalOrdered: UnifiedSessionItem[],
  cardMetaById: ReadonlyMap<string, SessionCardMeta>,
): DeliveryTelemetry {
  const {
    rotation,
    bulk,
    stateMap,
    ratingReliability,
    recentFailureConceptIds,
    penaltyContext,
    targetComputeRequested,
    runtimeTargetSnapshot,
    runtimeExamTarget,
    targetSidecarsValid,
    examTargetEvaluationOnly,
    applyExamTarget,
    effectiveTargetInfluence,
    masteryEvidence,
    targetWorkload,
    daysToExam,
    examPressure,
  } = inputs;
  const {
    statesById,
    conceptStates,
    learnerTargetPolicy,
    allocationChangedConceptMembershipCount,
    allocationCoverageDebtDomainCodes,
  } = plan;
  const { challengeRecallAtSelectionByCardId } = build;

  // 10. Attach delivery-grounded policy and item-recall telemetry after
  // ordering. These fields remain descriptive and cannot change membership or
  // rank. The card ladder itself acted earlier during candidate ranking; MCQ
  // challenge fit is deliberately shadow-only until the audit has enough data.
  //
  // Do not create TeachingSignal rows here. This function runs for cache builds,
  // not actual deliveries, and the client never returned signalId on grade. That
  // produced a large orphaned prediction table with effectively no outcomes.
  // ServeDecision + LearningEvent are the delivery-grounded measurement contract.
  const challengeBypassReasons = new Set<UnifiedSessionItem['interventionReason']>([
    'failure_escalation',
    'stuck_intervention',
    'pre_teach',
    'pre_teach_naive',
    'chronic_stuck_mcq',
    'mcq_bridge_card',
    'preemptive_scaffold',
  ]);
  const unseenCardIdsForNovelty = new Set(bulk.unseenCards.map(card => card.id));
  const repetitionSlotContext = buildRepetitionSlotContext({
    rotation,
    cards: [...bulk.unseenCards, ...bulk.seenCards],
    grades: bulk.cardGradeById,
    seenCardIds: bulk.seenCards.map((card) => card.id),
    variantGroupHistory: bulk.cardVariantGroupHistory.values(),
    seenQuestionIds: bulk.questionFamiliarity.keys(),
  });
  for (const item of finalOrdered) {
    const rawState = stateMap.get(item.conceptId);
    const scheduledState = statesById.get(item.conceptId);
    const serveRecallEstimate = scheduledState?.currentRecall ?? rawState?.recallProbability ?? 0;
    const serveExposureCount = scheduledState?.exposureCount ?? rawState?.exposureCount ?? 0;
    const questionMeta = item.type === 'question' ? bulk.questionMap.get(item.id) : undefined;
    const cardMeta = item.type === 'card' ? cardMetaById.get(item.id) : undefined;
    // Grade-conditioner context rides the serve decision so the grade path
    // reads no history. Null record → nothing attached → pass-through.
    if (item.type === 'card' && cardMeta) {
      const conditioning = buildServeConditioning(ratingReliability, proximityOverlayFor(rotation), cardMeta.stableId);
      if (conditioning) item.conditioning = conditioning;
      const repetitionSlot = shadowForDueId(item.id, repetitionSlotContext);
      if (repetitionSlot) item.repetitionSlot = repetitionSlot;
    }
    const challengePolicyWasApplied = item.challengePolicyApplied === true;
    // The boolean above doubles as an internal selection marker. Clear it
    // before writing public telemetry so bypassed items never leak a detached
    // `applied=true` without a version/target/distance contract.
    item.challengePolicyApplied = undefined;
    const descriptiveChallengeRecall = scheduledState?.currentRecall
      ?? rawState?.recallProbability;
    const challengeRecallEstimate = challengePolicyWasApplied
      ? challengeRecallAtSelectionByCardId.get(item.id)
      : descriptiveChallengeRecall;
    const actualTier = item.type === 'card'
      ? tierFromComplexity(cardMeta?.complexity ?? item.complexity)
      : item.type === 'question' && questionMeta
        ? tierFromQuestionDifficulty(getEffectiveQuestionDifficulty(questionMeta))
        : null;
    item.difficultyTier = actualTier;

    if (
      (item.type === 'card' || item.type === 'question')
      && !isSyntheticConceptAttribution(item.conceptId)
      && !challengeBypassReasons.has(item.interventionReason)
    ) {
      const targetTier = targetChallengeTierForRecall(challengeRecallEstimate);
      const distance = challengeTierDistance(actualTier, targetTier);
      if (targetTier && distance !== null) {
        item.challengePolicyVersion = CHALLENGE_POLICY_VERSION;
        item.challengeTargetTier = targetTier;
        item.challengeDistance = distance;
        item.challengePolicyApplied = item.type === 'card' && challengePolicyWasApplied;
      }
    }

    if (
      item.type === 'card'
      && challengePolicyWasApplied
      && !isSyntheticConceptAttribution(item.conceptId)
      && unseenCardIdsForNovelty.has(item.id)
      && !recentFailureConceptIds.has(item.conceptId)
      && !challengeBypassReasons.has(item.interventionReason)
    ) {
      const novelty = recentNeighborSignal(
        cardMeta?.similarCards,
        penaltyContext?.recentCardIds,
      );
      item.noveltyPolicyVersion = RECENT_NEIGHBOR_POLICY_VERSION;
      item.recentNeighborSimilarity = novelty.maxSimilarity;
      item.noveltyPenalty = novelty.penalty;
    }
    // Concept recall is the person/concept prior; item facility and its sample
    // size adjust it toward the actual item base rate. Scaffolds and videos have
    // no calibrated binary review outcome and remain unset.
    if (isCalibratedReviewItem(item)) {
      const estimate = estimateItemRecall({
        conceptRecall: serveRecallEstimate,
        conceptExposureCount: serveExposureCount,
        itemType: item.type,
        facilityIndex: cardMeta?.facilityIndex ?? questionMeta?.facilityIndex ?? null,
        sampleSize: cardMeta?.sampleSize ?? questionMeta?.totalAttempts ?? null,
        complexity: cardMeta?.complexity ?? item.complexity ?? null,
        difficulty: questionMeta?.difficulty ?? item.difficulty ?? null,
      });
      item.predictedRecall = estimate.predictedRecall;
      item.predictedRecallModel = estimate.model;
      item.predictedRecallSource = estimate.source;
      item.predictedRecallStatus = estimate.validationStatus;
    }
  }

  let examTargetDecision: UnifiedSessionExamTargetDecision | undefined;
  if (
    targetComputeRequested
    && runtimeTargetSnapshot
    && runtimeExamTarget?.schedulerVersion
    && runtimeExamTarget.policyDigest
    && runtimeExamTarget.activationRevision != null
  ) {
    const mode = runtimeExamTarget.resolved.effectiveMode === 'active' ? 'active' : 'shadow';
    const assignment = runtimeExamTarget.resolved.assignment;
    const bypassReason = !targetSidecarsValid
      ? 'invalid-or-missing-target-sidecars'
      : runtimeTargetSnapshot.definition.influence.allocator === 'shadow'
          && !examTargetEvaluationOnly
        ? 'target-authority-shadow-only'
        : mode === 'shadow'
          ? 'shadow-serves-control'
          : assignment === 'control'
            ? 'control-assignment'
            : applyExamTarget
              ? null
              : 'target-not-applied';
    const itemTraces: Record<string, ScheduledExamTargetItemTrace> = {};
    if (learnerTargetPolicy) {
      for (const item of finalOrdered) {
        if (item.type !== 'card' && item.type !== 'question') continue;
        const itemKey = `${item.type}:${item.id}`;
        const score = bulk.examTargetItemScores.get(itemKey);
        const domain = score
          ? learnerTargetPolicy.desiredDomains.get(score.domainCode)
          : undefined;
        const personalizedTargetScore = learnerTargetPolicy.itemPersonalizedScores.get(itemKey);
        if (!score || !domain || personalizedTargetScore === undefined) continue;
        itemTraces[itemKey] = Object.freeze({
          targetDomainCode: score.domainCode,
          sourceRotation: score.sourceRotation,
          embeddingHash: score.embeddingHash,
          examRelevancePct: score.fitPercentile,
          examDomainWeight: score.effectiveDomainWeight,
          userDomainGap: domain.userDomainGap,
          contentTargetScore: score.itemTargetIndex,
          personalizedTargetScore,
          targetWeightProvenance: score.weightProvenance,
        });
      }
    }
    const candidateItems = [
      ...bulk.unseenCards.map(card => ({
        itemKey: `card:${card.id}`,
        sourceRotation: card.rotation,
      })),
      ...bulk.seenCards.map(card => ({
        itemKey: `card:${card.id}`,
        sourceRotation: card.rotation,
      })),
      ...bulk.rotationQuestions.map(question => ({
        itemKey: `question:${question.id}`,
        sourceRotation: question.rotation,
      })),
    ];
    const seenCandidateKeys = new Set<string>();
    const candidatePool: ScheduledExamTargetCandidateTrace[] = [];
    for (const candidate of candidateItems) {
      if (seenCandidateKeys.has(candidate.itemKey)) continue;
      seenCandidateKeys.add(candidate.itemKey);
      const score = bulk.examTargetItemScores.get(candidate.itemKey);
      const domain = score
        ? learnerTargetPolicy?.desiredDomains.get(score.domainCode)
        : undefined;
      const personalizedTargetScore = learnerTargetPolicy
        ?.itemPersonalizedScores.get(candidate.itemKey);
      const targetEligible = Boolean(
        score && domain && personalizedTargetScore !== undefined,
      );
      candidatePool.push(Object.freeze({
        itemKey: candidate.itemKey,
        sourceRotation: candidate.sourceRotation,
        baseRank: candidatePool.length,
        targetEligible,
        targetDomainCode: targetEligible ? score!.domainCode : null,
        embeddingHash: targetEligible ? score!.embeddingHash : null,
        examRelevancePct: targetEligible ? score!.fitPercentile : null,
        examDomainWeight: targetEligible ? score!.effectiveDomainWeight : null,
        userDomainGap: targetEligible ? domain!.userDomainGap : null,
        contentTargetScore: targetEligible ? score!.itemTargetIndex : null,
        personalizedTargetScore: targetEligible ? personalizedTargetScore! : null,
        targetWeightProvenance: targetEligible ? score!.weightProvenance : null,
      }));
    }
    const targetAllocationError = (() => {
      if (!applyExamTarget || !learnerTargetPolicy) return null;
      const discretionary = finalOrdered.filter(item => (
        (item.type === 'card' || item.type === 'question')
        && item.examTargetMasteryStage !== 'scheduled-atomic-core'
      ));
      if (discretionary.length === 0) return null;
      const observed = new Map<string, number>();
      for (const item of discretionary) {
        const score = bulk.examTargetItemScores.get(`${item.type}:${item.id}`);
        if (!score) continue;
        observed.set(score.domainCode, (observed.get(score.domainCode) ?? 0) + 1);
      }
      const error = [...learnerTargetPolicy.desiredDomains]
        .reduce((sum, [domainCode, domain]) => (
          sum + Math.abs(
            (observed.get(domainCode) ?? 0) / discretionary.length
            - domain.desiredShare,
          )
        ), 0) / 2;
      return Math.min(1, Math.max(0, Math.round(error * 1_000_000) / 1_000_000));
    })();
    examTargetDecision = {
      targetSnapshotId: runtimeTargetSnapshot.id,
      targetVersion: runtimeTargetSnapshot.targetVersion,
      targetBasis: runtimeTargetSnapshot.targetBasis,
      targetScorerVersion: runtimeTargetSnapshot.scorerVersion,
      schedulerVersion: runtimeExamTarget.schedulerVersion,
      policyDigest: runtimeExamTarget.policyDigest,
      activationRevision: runtimeExamTarget.activationRevision,
      mode,
      assignment,
      applied: applyExamTarget,
      bypassReason,
      maxItemRankMove: effectiveTargetInfluence?.maxItemRankMove ?? 0,
      unmappedDomainCodes: learnerTargetPolicy?.unmappedDomainCodes ?? [],
      masteryPolicyVersion: masteryEvidence?.masteryPlan.policyVersion ?? null,
      workload: targetWorkload ? Object.freeze({ ...targetWorkload }) : null,
      coreTargetSeatsSelected: build.selectedCoreTargetSeats,
      coreTargetSeatShortfall: Math.max(
        0,
        (targetWorkload?.coreTargetSeats ?? 0) - build.selectedCoreTargetSeats,
      ),
      surplusTargetSeatsSelected: build.selectedSurplusTargetSeats,
      allocationChangedConceptMembershipCount,
      allocationCoverageDebtDomainCodes: [...allocationCoverageDebtDomainCodes],
      targetAllocationError,
      evaluationOnly: examTargetEvaluationOnly,
      curriculumCoverageDebtCount: masteryEvidence
        ? masteryEvidence.curriculumCoverageDebt.length
        : null,
      masteryLoadWarnings: [...(masteryEvidence?.loadWarnings ?? [])],
      daysToExam: Math.max(0, Math.ceil(daysToExam)),
      pressureBucket: examPressure >= 0.8
        ? 'crunch'
        : examPressure >= 0.5
          ? 'near'
          : examPressure >= 0.2
            ? 'building'
            : 'far',
      learnerStateVersion: hashExamTargetArtifact({
        schema: 'md3.exam-target-learner-state/v1',
        concepts: conceptStates
          .map(state => ({
            conceptId: state.conceptId,
            recallOnExamDay: state.recallOnExamDay,
            confidence: state.confidence,
          }))
          .sort((left, right) => left.conceptId.localeCompare(right.conceptId)),
        completedCoreWorkToday: masteryEvidence?.completedCoreWorkToday ?? 0,
        remainingTargetWork: masteryEvidence?.remainingTargetWork ?? null,
      }),
      candidatePool: Object.freeze(candidatePool),
      itemTraces: Object.freeze(itemTraces),
    };
  }

  return { examTargetDecision, repetitionSlotContext };
}

/**
 * Phase 11: count what was selected and assemble the session result.
 *
 * `finalOrdered` is the queue after every ordering and cap pass; `telemetry` is
 * what phase 10 produced for it.
 */
export function assembleSessionResult(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
  finalOrdered: UnifiedSessionItem[],
  telemetry: DeliveryTelemetry,
): UnifiedSessionResult {
  const { concepts, examPressure, budget, masteryEvidence } = inputs;
  const { weakConcepts, learnerTargetPolicy } = plan;
  const { selectedConceptIds, minFirstSightItems } = build;
  const { examTargetDecision, repetitionSlotContext } = telemetry;

  // 11. Compute stats
  const quotaTaggedItems = finalOrdered.map((item) => ({
    ...item,
    firstSightAtSelection: build.isFirstSightItem(item),
  }));
  const selectedFirstSightItems = quotaTaggedItems
    .filter((item) => item.firstSightAtSelection).length;
  const cardCount = quotaTaggedItems.filter((i) => i.type === 'card').length;
  const questionCount = quotaTaggedItems.filter((i) => i.type === 'question').length;
  const avgPriority =
    finalOrdered.length > 0
      ? finalOrdered.reduce((sum, i) => sum + i.priority, 0) / finalOrdered.length
      : 0;
  const conceptPairingRate = computeConceptPairingRate(finalOrdered);

  return {
    items: quotaTaggedItems,
    repetitionSlotContext,
    noveltyQuota: {
      required: minFirstSightItems,
      selected: selectedFirstSightItems,
    },
    stats: {
      totalConcepts: concepts.length,
      weakConcepts: weakConcepts.length,
      selectedConcepts: selectedConceptIds.size,
      cardCount,
      questionCount,
      averagePriority: Math.round(avgPriority * 1000) / 1000,
      examPressure: Math.round(examPressure * 100) / 100,
      conceptPairingRate,
      dailyThroughput: Math.round(budget.dailyThroughput),
      totalBudgetRemaining: Math.round(budget.totalRemaining),
      sessionsRemaining: budget.sessionsRemaining,
      ...(examTargetDecision ? {
        examTargetComputed: learnerTargetPolicy !== null,
        examTargetApplied: examTargetDecision.applied,
        examTargetVersion: examTargetDecision.targetVersion,
        examTargetBypassReason: examTargetDecision.bypassReason,
        examTargetCoreSeatsRequired: examTargetDecision.workload?.coreTargetSeats ?? 0,
        examTargetCoreSeatsSelected: examTargetDecision.coreTargetSeatsSelected,
        examTargetCoreSeatShortfall: examTargetDecision.coreTargetSeatShortfall,
        examTargetSurplusSeats: examTargetDecision.workload?.surplusSeats ?? 0,
        examTargetRemainingWork: masteryEvidence?.remainingTargetWork ?? null,
        examTargetWorkloadShortfall: examTargetDecision.workload?.shortfall ?? null,
      } : {}),
    },
    ...(examTargetDecision ? { examTargetDecision } : {}),
  };
}
