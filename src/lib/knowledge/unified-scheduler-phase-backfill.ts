/**
 * Unified scheduler: backfill lanes
 *
 * Phase 8 of a session build. When the priority-driven lanes leave the batch
 * short, these lanes fill it, in order: any concept the lanes did not reach,
 * stale strong concepts, the rotation bank, uncapped cards, orphaned items, and
 * finally the review work the first-sight reservation had deferred. Each guards
 * itself with `selectedItems.length < size`, so a full batch passes through
 * untouched. The bodies were moved unchanged out of constructUnifiedSessionImpl;
 * the first lines of each function name the fields it reads from the inputs,
 * the plan and the build state.
 */

import { logger } from '@/lib/logger';
import { applyBoundedExamTargetNudge, getCardsFromBulk, getQuestionsFromBulk } from './candidate-ranking';
import { resolveInterventionReason } from './intervention-reason';
import { resolveRetirementPolicy, takeWithReentryCap } from './question-retirement';
import { hasSpecificClinicalTopicOverlap } from './specific-topic-overlap';
import { DEFAULTS } from './unified-scheduler-config';
import { type SessionBuildState, conceptThreadTrace } from './unified-scheduler-phase-state';
import type { ConceptPlan, SchedulerInputs } from './unified-scheduler-phase-types';
import { getQuestionsForRotation } from './unified-scheduler-queries';
import { conceptThreadPolicyReceipt } from './unified-scheduler-types';
import { prioritizeLeastRecentlyServedContrastSiblings, questionSuppressionKey } from './variant-suppression';
import { hasDemonstratedLearningGap } from '@/lib/study/review-learning-policy';

/**
 * Phase 8: when selection is still short, backfill from any concept the lanes did
 * not reach. First cards, capped at the card quota so card backfill cannot absorb
 * the question quota; then questions.
 */
export function backfillFromAnyConcept(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    interferenceThreshold,
    options,
    penaltyContext,
    recentFormatsByConcept,
    recentFailureConceptIds,
    selectionNowMs,
    stateMap,
    size,
  } = inputs;
  const {
    activeCardTargetScores,
    activeQuestionTargetScores,
    activeTargetRankMove,
    conceptStates,
    targetCardCount,
  } = plan;
  const {
    masteredReentryCounter,
    selectedCardIds,
    selectedConceptIds,
    selectedItems,
    selectedQuestionIds,
    selectedQuestionVariantGroups,
  } = build;

  // 8. If still short on items, backfill from any concepts (cards + questions)
  if (selectedItems.length < size) {
    const remainingConcepts = conceptStates.filter((s) => {
      if (selectedConceptIds.has(s.conceptId)) return false;
      return true;
    });

    // 8a. Backfill with cards — capped at targetCardCount so card backfill
    // does not absorb the question quota when 7b found no linked questions.
    // Without this cap, users with weak concepts that lack question→concept
    // links (e.g. stuanki-derived PAAM concepts) get all-card sessions even
    // when the rotation bank has unanswered MCQs ready for top-up below.
    for (const concept of remainingConcepts) {
      if (selectedItems.length >= size) break;
      if (build.selectedCardCount >= targetCardCount) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.currentRecall, options.currentTeachingWeek, applyExamTarget ? activeCardTargetScores : undefined, activeTargetRankMove, options.topicTeachingWeeks, options.recentFigureExposures, selectionNowMs());
      if (candidates.length === 0) continue;

      const picked = build.pickCardCandidate(candidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = build.addItem({
        type: 'card',
        id: picked.id,
        challengePolicyApplied: true,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        interventionReason: 'reinforcement',
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });
      if (added) {
        build.recordAppliedChallengeRecall(picked.id, concept.currentRecall);
        build.recordCluster(picked.clusterId);
        build.recordCardNeighborhood(picked);
      }
    }

    // 8b. Backfill with questions from any remaining concepts
    if (selectedItems.length < size) {
      const stillRemaining = conceptStates.filter((s) => {
        if (selectedConceptIds.has(s.conceptId)) return false;
        return true;
      });
      for (const concept of stillRemaining) {
        if (selectedItems.length >= size) break;

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
          difficultyPlan: ['medium'],
          reviewChallenge: options.reviewChallenge,
          selectedQuestionIds,
          selectedQuestionVariantGroups,
          currentTeachingWeek: options.currentTeachingWeek,
          topicTeachingWeeks: options.topicTeachingWeeks,
          masteredReentryCounter,
          recentFormatsByConcept,
          reviewChallengeGap: hasDemonstratedLearningGap({
            probeCount: stateMap.get(concept.conceptId)?.probeCount,
            recallProbability: stateMap.get(concept.conceptId)?.recallProbability,
            recentFailRate: stateMap.get(concept.conceptId)?.recentFailRate,
            lastProbeAt: stateMap.get(concept.conceptId)?.lastProbeAt,
            recentFailure: recentFailureConceptIds.has(concept.conceptId),
          }),
          conceptThreadMatcher: build.availableConceptThreadMatcher(),
          ...(applyExamTarget ? {
            examTargetScores: activeQuestionTargetScores,
            examTargetMaxRankMove: activeTargetRankMove,
          } : {}),
        });
        if (questions.length === 0) continue;

        const question = questions[0];
        const threadMatch = question.conceptThreadMatch;
        const added = build.addItem({
          type: 'question',
          id: question.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: threadMatch ? 'concept_followup' : 'reinforcement',
          ...conceptThreadTrace(threadMatch),
          variantGroupId: question.variantGroupId,
          variantType: question.variantType,
        });
        if (added && threadMatch) {
          build.conceptThreadFollowupSelected = true;
        }
      }
    }
  }
}

/**
 * Phase 8.2: maintenance probing. When the session is still short, pull questions
 * from strong concepts that have not been probed recently, so mastered material is
 * retested periodically rather than abandoned.
 */
export function probeStaleStrongConcepts(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    options,
    recentFailureConceptIds,
    recentFormatsByConcept,
    stateMap,
    size,
  } = inputs;
  const {
    activeQuestionTargetScores,
    activeTargetRankMove,
    conceptHasPristine,
    conceptStates,
  } = plan;
  const {
    masteredReentryCounter,
    selectedConceptIds,
    selectedItems,
    selectedQuestionIds,
    selectedQuestionVariantGroups,
  } = build;

  // 8.2. Maintenance probing: when session is still short, pull questions from
  // strong concepts that haven't been probed recently. This ensures mastered
  // material gets periodically retested rather than being abandoned.
  if (selectedItems.length < size) {
    const staleStrongConcepts = conceptStates
      .filter((s) => {
        if (s.recallOnExamDay < DEFAULTS.targetRecall) return false;
        if (s.daysSinceProbe <= DEFAULTS.daysSinceProbeThreshold) return false;
        if (selectedConceptIds.has(s.conceptId)) return false;
        return true;
      })
      .sort((a, b) => b.daysSinceProbe - a.daysSinceProbe); // most stale first

    for (const concept of staleStrongConcepts) {
      if (selectedItems.length >= size) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const maintenanceReason = resolveInterventionReason({
        conceptId: concept.conceptId,
        recallOnExamDay: concept.recallOnExamDay,
        baseReason: 'needs_retest',
        recentFailureConceptIds,
        conceptHasPristine,
        targetRecall: DEFAULTS.targetRecall,
      });
      const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
        difficultyPlan: ['hard'],
        reviewChallenge: options.reviewChallenge,
        selectedQuestionIds,
        selectedQuestionVariantGroups,
        currentTeachingWeek: options.currentTeachingWeek,
        topicTeachingWeeks: options.topicTeachingWeeks,
        masteredReentryCounter,
        recentFormatsByConcept,
        reviewChallengeGap: hasDemonstratedLearningGap({
          probeCount: stateMap.get(concept.conceptId)?.probeCount,
          recallProbability: stateMap.get(concept.conceptId)?.recallProbability,
          recentFailRate: stateMap.get(concept.conceptId)?.recentFailRate,
          lastProbeAt: stateMap.get(concept.conceptId)?.lastProbeAt,
          recentFailure: recentFailureConceptIds.has(concept.conceptId),
        }),
        conceptThreadMatcher: maintenanceReason === 'failure_escalation'
          ? undefined
          : build.availableConceptThreadMatcher(),
        ...(applyExamTarget ? {
          examTargetScores: activeQuestionTargetScores,
          examTargetMaxRankMove: activeTargetRankMove,
        } : {}),
      });
      if (questions.length === 0) continue;

      const question = questions[0];
      const threadMatch = question.conceptThreadMatch;
      const added = build.addItem({
        type: 'question',
        id: question.id,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        // 8a stale-strong fires only on already-strong concepts, so the
        // resolver will tag it as failure_escalation if a recent failure
        // happens to coincide, or strong_pristine if the concept still
        // has unseen cards; otherwise the base needs_retest sticks.
        interventionReason: threadMatch ? 'concept_followup' : maintenanceReason,
        ...conceptThreadTrace(threadMatch),
        variantGroupId: question.variantGroupId,
        variantType: question.variantType,
      });
      if (added && threadMatch) {
        build.conceptThreadFollowupSelected = true;
      }
    }
  }
}

/**
 * Phase 8b: rotation-bank top-up. When concept-driven selection under-fills the
 * batch (sparse concept coverage, missing question-concept links), pad it with
 * unanswered questions from the rotation bank, capped at the unmet question quota.
 * A failed read leaves the batch short and is logged.
 */
export async function topUpFromRotationBank(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): Promise<void> {
  const { bulk, rotation, selectionDeterminism, size, userId } = inputs;
  const { targetQuestionCount } = plan;
  const {
    masteredReentryCounter,
    selectedItems,
    selectedQuestionIds,
    selectedQuestionVariantGroups,
  } = build;

  // 8b. Rotation-bank top-up: when concept-driven selection under-fills the
  // batch (sparse concept coverage, missing question-concept links), pad with
  // unanswered questions from the rotation bank so users always see a full
  // session instead of hitting a loading screen every few cards.
  //
  // Cap the top-up at the unmet question quota (`targetQuestionCount -
  // selectedQuestionCount`) instead of the whole remaining deficit. Without
  // this cap, sessions where weak concepts have no topic-matching cards (e.g.
  // PAAM stuanki concepts whose topics like "Cluster"/"Detail" don't intersect
  // the cards' "BPD"/"Borderline" topic strings) saw rotation top-up claim
  // the full card budget, and the downstream card backfill (8c) and orphan
  // rescue (8d) never ran. Result: weeks of 15-question/0-card sessions.
  // Capping here lets 8c/8d surface cards before falling back to extra
  // questions in the final orphan-question pass at the end of 8d.
  if (selectedItems.length < size) {
    const questionDeficit = Math.max(0, targetQuestionCount - build.selectedQuestionCount);
    const deficit = Math.min(size - selectedItems.length, questionDeficit);
    if (deficit > 0) {
      const alreadyPicked = new Set<string>(selectedQuestionIds);
      for (const i of selectedItems) {
        if (i.type === 'question') alreadyPicked.add(i.id);
      }
      try {
        const topup = await getQuestionsForRotation(userId, rotation, deficit, {
          selectedQuestionIds: alreadyPicked,
          selectedQuestionVariantGroups,
          questionFamiliarity: bulk.questionFamiliarity,
          masteredReentryCounter,
          ...(selectionDeterminism
            ? { selectionDeterminism }
            : {}),
        });
        for (const q of topup) {
          build.addItem({
            type: 'question',
            id: q.id,
            // This fallback query is strictly scoped to the session rotation.
            // Carry the known source through the final fail-closed source cap.
            rotation,
            conceptId: `rotation:${q.id}`,
            conceptName: 'Rotation fill',
            priority: 0.4,
            interventionReason: 'needs_retest',
            ...conceptThreadPolicyReceipt(),
            variantGroupId: q.variantGroupId,
            variantType: q.variantType,
          });
        }
      } catch (err) {
        logger.warn('Rotation top-up failed, continuing with short batch', {
          rotation, deficit, error: String(err),
        });
      }
    }
  }
}

/**
 * Phase 8c: final uncapped card backfill. If every question-fill path above was
 * exhausted, make up the remaining deficit with cards rather than ship a short
 * session.
 */
export function backfillCardsUncapped(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    interferenceThreshold,
    options,
    penaltyContext,
    recentFailureConceptIds,
    selectionNowMs,
    size,
  } = inputs;
  const { activeCardTargetScores, activeTargetRankMove, conceptHasPristine, conceptStates } = plan;
  const { selectedCardIds, selectedConceptIds, selectedItems } = build;

  // 8c. Final uncapped card backfill — if all question-fill paths above were
  // exhausted (no concept links, no stale-strong, no rotation bank), make up
  // the remaining deficit with cards rather than shipping a short session.
  if (selectedItems.length < size) {
    const stillRemaining = conceptStates.filter((s) => {
      if (selectedConceptIds.has(s.conceptId)) return false;
      return true;
    });
    for (const concept of stillRemaining) {
      if (selectedItems.length >= size) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.currentRecall, options.currentTeachingWeek, applyExamTarget ? activeCardTargetScores : undefined, activeTargetRankMove, options.topicTeachingWeeks, options.recentFigureExposures, selectionNowMs());
      if (candidates.length === 0) continue;

      const picked = build.pickCardCandidate(candidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = build.addItem({
        type: 'card',
        id: picked.id,
        challengePolicyApplied: true,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        // 8c uncapped backfill — same resolver pass so D/E aren't lost in
        // the deepest fallback lane either.
        interventionReason: resolveInterventionReason({
          conceptId: concept.conceptId,
          recallOnExamDay: concept.recallOnExamDay,
          baseReason: 'reinforcement',
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        }),
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });
      if (added) {
        build.recordAppliedChallengeRecall(picked.id, concept.currentRecall);
        build.recordCluster(picked.clusterId);
        build.recordCardNeighborhood(picked);
      }
    }
  }
}

/**
 * Phase 8d: orphan rescue, the final fill for otherwise-unreachable cards and
 * questions. Due seen cards come first and stay eligible in review-only sessions;
 * pristine cards and un-responded questions follow when new material is allowed.
 * There is no per-type cap: the learner should never see "nothing more" while the
 * pool is not empty.
 */
export function rescueOrphans(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const { applyExamTarget, bulk, concepts, effectiveMaxNewCards, size } = inputs;
  const { activeCardTargetScores, activeQuestionTargetScores, activeTargetRankMove } = plan;
  const {
    masteredReentryCounter,
    selectedCardIds,
    selectedCardVariantGroups,
    selectedItems,
    selectedQuestionIds,
    selectedQuestionVariantGroups,
  } = build;

  // 8d. Orphan rescue — final fill for otherwise-unreachable cards/questions.
  // Due seen cards run first and remain eligible in review-only sessions;
  // pristine cards / un-responded questions follow when new material is
  // allowed. This reaches imported cards that deliberately have no embedding,
  // topics, or concept link even after their first review.
  //
  // No per-type cap: if the upstream passes left a deficit and there's
  // anything left in the pool, fill to session size. Cards first, then
  // questions. This is what enforces the "never show 'nothing more' when
  // pool > 0" UX guarantee — the empty-state should only fire when the
  // pristine pool is genuinely zero.
  //
  const findAttributionConcept = (topics: string[]): { id: string; name: string } => {
    for (const c of concepts) {
      if (hasSpecificClinicalTopicOverlap(topics, c.topics)) return { id: c.id, name: c.name };
    }
    // Discovery remains available without manufacturing clinical attribution
    // from a population or specialty tag rejected by the concept picker.
    return { id: '_unattached', name: 'Unattached' };
  };

  // Pass 0: due seen cards. `bulk.seenCards` has already passed owner/active-
  // epoch scope, due-date, suppression, and leech gates in bulkFetchCandidates.
  // It is therefore safe to rescue directly without an embedding or topic
  // match. These are reviews, so maxNewCards=0 must not suppress them.
  if (selectedItems.length < size) {
    const orphanSeenCardControl = bulk.seenCards
      .filter((card) => !selectedCardIds.has(card.id));
    const orphanSeenCards = applyExamTarget
      ? applyBoundedExamTargetNudge(
          orphanSeenCardControl,
          card => activeCardTargetScores.get(card.id),
          activeTargetRankMove,
        )
      : orphanSeenCardControl;
    for (const card of orphanSeenCards) {
      if (selectedItems.length >= size) break;
      if (card.variantGroupId && selectedCardVariantGroups.has(card.variantGroupId)) continue;
      const attribution = findAttributionConcept(card.topics);
      build.addItem({
        type: 'card',
        id: card.id,
        conceptId: attribution.id,
        conceptName: attribution.name,
        priority: 0.2,
        interventionReason: 'needs_retest',
        variantGroupId: card.variantGroupId,
        variantIndex: card.variantIndex,
        variantType: card.variantType,
      });
    }
  }

  // The remaining orphan passes introduce pristine cards / un-responded
  // questions and stay disabled when the caller explicitly pins new cards to
  // zero (for example crunch mode).
  if (selectedItems.length < size && effectiveMaxNewCards !== 0) {

    // Pass 1: pristine cards. Sort by importance (high first) so foundational
    // cards rescue ahead of stretch cards.
    const orphanCardControl = bulk.unseenCards
      .filter((c) => !selectedCardIds.has(c.id))
      .sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1));
    const orphanCards = applyExamTarget
      ? applyBoundedExamTargetNudge(
          orphanCardControl,
          card => activeCardTargetScores.get(card.id),
          activeTargetRankMove,
        )
      : orphanCardControl;
    for (const card of orphanCards) {
      if (selectedItems.length >= size) break;
      // Respect cloze-variant suppression even in the orphan-rescue lane: surfacing
      // two siblings of the same group back-to-back here is the worst place for it
      // (no concept context to soften the redundancy).
      if (card.variantGroupId && selectedCardVariantGroups.has(card.variantGroupId)) continue;
      const attribution = findAttributionConcept(card.topics);
      build.addItem({
        type: 'card',
        id: card.id,
        conceptId: attribution.id,
        conceptName: attribution.name,
        priority: 0.2,
        interventionReason: 'reinforcement',
        variantGroupId: card.variantGroupId,
        variantIndex: card.variantIndex,
        variantType: card.variantType,
      });
      // Don't recordCluster / recordCardNeighborhood here — those signals
      // exist for within-session interference avoidance among related cards;
      // orphan rescue is by definition about reaching unrelated material.
    }

    // Pass 2: un-responded questions. Variant filter still respected because
    // surfacing two near-identical questions is worse than ending the session
    // a touch short.
    const orphanQuestionControl = prioritizeLeastRecentlyServedContrastSiblings(
      bulk.rotationQuestions.filter((q) => !selectedQuestionIds.has(q.id)),
      (question) => question.id,
      bulk.questionFamiliarity,
    );
    const orphanQuestions = applyExamTarget
      ? applyBoundedExamTargetNudge(
          orphanQuestionControl,
          question => activeQuestionTargetScores.get(question.id),
          activeTargetRankMove,
        )
      : orphanQuestionControl;
    for (const q of orphanQuestions) {
      if (selectedItems.length >= size) break;
      const qKey = questionSuppressionKey(q);
      if (qKey && selectedQuestionVariantGroups.has(qKey)) continue;
      // This rescue lane has no ranking of its own, so without the cap it would fill
      // the session tail with mastered questions in raw DB order once the pristine
      // card pool is exhausted.
      if (!takeWithReentryCap(q.id, bulk.questionFamiliarity, resolveRetirementPolicy(), masteredReentryCounter)) {
        continue;
      }
      const attribution = findAttributionConcept(q.topics);
      build.addItem({
        type: 'question',
        id: q.id,
        conceptId: attribution.id,
        conceptName: attribution.name,
        priority: 0.2,
        interventionReason: 'reinforcement',
        ...conceptThreadPolicyReceipt(),
        variantGroupId: q.variantGroupId,
        variantType: q.variantType,
      });
    }
  }
}

/**
 * Release the first-sight reservation. A minimum can be impossible when the
 * eligible first-sight pool is smaller than the reservation; once every first-sight
 * lane has had its chance, backfill the remaining seats with the review work the
 * reservation deferred, so the batch is not avoidably short.
 */
export function releaseFirstSightReservation(
  inputs: SchedulerInputs,
  build: SessionBuildState,
): void {
  const { size } = inputs;
  const { deferredForNovelty, selectedItems } = build;

  // A minimum can be impossible when the eligible first-sight pool is smaller
  // than the reservation. Do not ship an avoidably short batch: once every
  // first-sight lane has had its chance, backfill the remaining seats with the
  // review work deferred solely by the reservation. Telemetry records the
  // resulting shortfall so this remains observable.
  if (selectedItems.length < size && deferredForNovelty.size > 0) {
    build.enforceFirstSightReservation = false;
    for (const item of deferredForNovelty.values()) {
      if (selectedItems.length >= size) break;
      build.addItem(item);
    }
  }
}
