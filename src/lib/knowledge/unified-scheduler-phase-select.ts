/**
 * Unified scheduler: item selection
 *
 * Phase 7 of a session build: the lanes that pick the session's items. Each lane
 * reads the inputs and the plan and records what it picked on the build state.
 * The bodies were moved unchanged out of constructUnifiedSessionImpl; the first
 * lines of each function name the fields it reads.
 */

import { allocateExamTargetMasterySeats } from '@/lib/exam-target/mastery-seat-allocation';
import { classifyTeachingState } from '@/lib/scheduler/concept-teaching-state';
import { type NaivePreTeachConcept, pickNaivePreTeachCards } from '@/lib/scheduler/naive-pre-teach';
import { expandTopicSet } from '@/lib/topics';
import {
  type CardCandidate,
  type QuestionDifficulty,
  getCardsFromBulk,
  getQuestionsFromBulk,
  getVideosFromBulk,
} from './candidate-ranking';
import { resolveInterventionReason } from './intervention-reason';
import { resolveRetirementPolicy, takeWithReentryCap } from './question-retirement';
import { DEFAULTS } from './unified-scheduler-config';
import { SessionBuildState, conceptThreadTrace } from './unified-scheduler-phase-state';
import type { ConceptPlan, SchedulerInputs } from './unified-scheduler-phase-types';
import { buildClusterRoundRobin } from './unified-scheduler-scoring';
import {
  type ConceptState,
  type UnifiedSessionItem,
  conceptThreadPolicyReceipt,
} from './unified-scheduler-types';
import { questionSuppressionKey } from './variant-suppression';
import { hasDemonstratedLearningGap } from '@/lib/study/review-learning-policy';
import { normalizeReviewChallengeLevel } from '@/lib/study/review-challenge';

/**
 * Create the build state for a session: the empty selection with its budgets, and
 * the fail-closed rule for an exam target that has core seats but no mastery
 * evidence. Without the evidence nothing discretionary may be served, so every
 * candidate is marked as already selected.
 */
export function createSessionBuild(inputs: SchedulerInputs, plan: ConceptPlan): SessionBuildState {
  const {
    applyExamTarget,
    bulk,
    conceptThreadAnchors,
    excludedCardIds,
    excludedQuestionIds,
    excludedVideoIds,
    masteryEvidence,
    nowMs,
    options,
    size,
    targetWorkload,
  } = inputs;
  const {
    crossSourceCardIds,
    crossSourceQuestionIds,
    maxCrossSourceItems,
    maxNewCards,
    unseenCardIds,
    weakConcepts,
  } = plan;

  const minFirstSightItems = Math.min(
    size,
    Math.max(
      0,
      Math.floor(Math.max(
        options.minFirstSightItems ?? 0,
        normalizeReviewChallengeLevel(options.reviewChallenge) === 2 ? Math.ceil(size * 0.8) : 0,
      )),
    ),
  );
  // Everything the selection lanes share and mutate lives on `build`: the items
  // picked so far, the id sets and per-concept counts that stop repeats, and the
  // new-card, cross-source and first-sight budgets. The collections are aliased
  // below; the counters are always read and written through `build`.
  const build = new SessionBuildState({
    size,
    minFirstSightItems,
    maxNewCards,
    maxCrossSourceItems,
    unseenCardIds,
    crossSourceCardIds,
    crossSourceQuestionIds,
    bulk,
    excludedCardIds,
    excludedQuestionIds,
    excludedVideoIds,
    weakConcepts,
    conceptThreadAnchors,
    nowMs,
  });
  const { selectedCardIds, selectedQuestionIds, selectedVideoIds } = build;

  const failClosedForMissingMasteryEvidence = applyExamTarget
    && (targetWorkload?.coreTargetSeats ?? 0) > 0
    && masteryEvidence === null;
  if (failClosedForMissingMasteryEvidence) {
    // Without the mastery ledger we cannot distinguish scheduled atomic core
    // from ordinary breadth. Preserve the caller-owned protected prefix by
    // returning no discretionary candidate instead of guessing.
    for (const card of [...bulk.unseenCards, ...bulk.seenCards]) {
      selectedCardIds.add(card.id);
    }
    for (const question of bulk.rotationQuestions) {
      selectedQuestionIds.add(question.id);
    }
    for (const video of bulk.rotationVideos) {
      selectedVideoIds.add(video.id);
    }
  }

  return build;
}

/**
 * Resolve an already-authorized core card to one in-scope concept. Prefer the
 * scalar manifold score; fall back to a deterministic topic match. This is
 * attribution only — the bulk loader remains the access boundary.
 */
function coreCardResolver(inputs: SchedulerInputs, plan: ConceptPlan) {
  const { bulk, conceptMap } = inputs;
  const { conceptStates } = plan;
  return (card: CardCandidate): ConceptState | null => {
    let best: { state: ConceptState; score: number } | null = null;
    for (const state of conceptStates) {
      const score = bulk.cardScores.get(state.conceptId)?.get(card.id);
      if (score === undefined) continue;
      if (
        !best
        || score > best.score
        || (score === best.score && state.conceptId < best.state.conceptId)
      ) {
        best = { state, score };
      }
    }
    if (best) return best.state;

    const topicMatches = conceptStates.filter(state => {
      const concept = conceptMap.get(state.conceptId);
      if (!concept) return false;
      const expanded = new Set(expandTopicSet(concept.topics));
      return card.topics.some(topic => expanded.has(topic));
    });
    return topicMatches.sort((left, right) => (
      right.priority - left.priority
      || left.conceptId.localeCompare(right.conceptId)
    ))[0] ?? null;
  };
}

/**
 * Phase 7a-core: reserve today's scheduled atomic facts before any ordinary concept,
 * applied or cross-source selection. One fact contributes at most one seat even when
 * it has several card variants. Afterwards it records on `build` whether the core
 * quota was met.
 */
export function reserveScheduledCore(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    eligibleCoreUnitIds,
    interferenceThreshold,
    masteryEvidence,
    size,
    targetWorkload,
  } = inputs;
  const { activeCardTargetScores } = plan;
  const resolveCoreCardConcept = coreCardResolver(inputs, plan);

  // 7a-core) Reserve today's scheduled atomic facts before any ordinary
  // concept, applied or cross-source selection. One fact contributes at most
  // one seat even when it has multiple card variants.
  if (
    applyExamTarget
    && masteryEvidence
    && targetWorkload
    && targetWorkload.coreTargetSeats > 0
  ) {
    const cardById = new Map(
      [...bulk.unseenCards, ...bulk.seenCards].map(card => [card.id, card]),
    );
    const coreSeatPlan = allocateExamTargetMasterySeats({
      candidates: masteryEvidence.units.flatMap(unit => (
        unit.stage === 'scheduled-atomic-core'
          ? unit.safeMetadata.candidateItemKeys.map(itemKey => ({
              itemKey,
              unitId: unit.unitId,
              stage: unit.stage,
            }))
          : []
      )),
      eligibleUnitIdsByStage: {
        'scheduled-atomic-core': [...eligibleCoreUnitIds],
      },
      // Enumerate every eligible core unit so downstream access and teaching
      // constraints can fall through to a later unit. The selection loop below
      // still stops at today's workload quota.
      coreTargetSeats: eligibleCoreUnitIds.size,
      surplusSeats: 0,
    });
    const plannedCoreUnitIds = new Set(
      coreSeatPlan.selectedCandidates.map(candidate => candidate.unitId),
    );
    const orderedCoreUnits = masteryEvidence.units.filter(unit => (
      unit.stage === 'scheduled-atomic-core'
      && plannedCoreUnitIds.has(unit.unitId)
    ));

    for (const unit of orderedCoreUnits) {
      if (build.selectedCoreTargetSeats >= targetWorkload.coreTargetSeats) break;
      const candidates = unit.safeMetadata.candidateItemKeys
        .filter(itemKey => itemKey.startsWith('card:'))
        .map(itemKey => cardById.get(itemKey.slice('card:'.length)))
        .filter((card): card is NonNullable<typeof card> => Boolean(card))
        .map((card): CardCandidate => ({
          id: card.id,
          clusterId: card.clusterId,
          similarCards: card.similarCards,
          topics: card.topics,
          sourceFile: card.sourceFile,
          importance: card.importance,
          complexity: card.complexity,
          variantGroupId: card.variantGroupId,
          variantIndex: card.variantIndex,
          variantType: card.variantType,
        }))
        .sort((left, right) => (
          (activeCardTargetScores.get(right.id) ?? 0)
            - (activeCardTargetScores.get(left.id) ?? 0)
          || right.importance - left.importance
          || left.id.localeCompare(right.id)
        ));
      const picked = build.pickCardCandidate(candidates, {
        similarityThreshold: interferenceThreshold,
        maxPerCluster: 3,
      });
      if (!picked) continue;

      const concept = resolveCoreCardConcept(picked);
      const conceptId = concept?.conceptId ?? '_unattached';
      const added = build.addItem({
        type: 'card',
        id: picked.id,
        conceptId,
        conceptName: concept?.conceptName ?? 'Scheduled atomic core',
        priority: Math.max(1, concept?.priority ?? 0),
        interventionReason: concept && concept.recallOnExamDay < DEFAULTS.recallThreshold
          ? 'weak_recall'
          : 'reinforcement',
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
        examTargetMasteryStage: 'scheduled-atomic-core',
        examTargetMasteryUnitId: unit.unitId,
      });
      if (added) {
        build.selectedCoreTargetSeats += 1;
        build.recordCluster(picked.clusterId);
        build.recordCardNeighborhood(picked);
      }
    }
  }

  const coreTargetSeatRequirement = applyExamTarget
    ? (targetWorkload?.coreTargetSeats ?? size)
    : 0;
  build.coreTargetQuotaSatisfied = build.selectedCoreTargetSeats >= coreTargetSeatRequirement;
}

/**
 * Phase 7a-surplus: spend the capacity left after today's scheduled-core reservation
 * on eligible applied distinctions before breadth. The seat allocator cannot widen
 * access: every candidate item key came from mastery evidence built over the
 * already-authorized bulk pool.
 */
export function reserveAppliedSurplus(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    eligibleAppliedUnitIds,
    interferenceThreshold,
    masteryEvidence,
    targetWorkload,
  } = inputs;
  const { conceptStates, statesById } = plan;
  const { masteredReentryCounter, selectedQuestionIds, selectedQuestionVariantGroups } = build;
  const resolveCoreCardConcept = coreCardResolver(inputs, plan);

  // 7a-surplus) Surplus is explicit capacity after today's scheduled-core
  // reservation. Spend it on eligible applied distinctions before breadth;
  // the seat allocator cannot widen access because every candidate item key
  // came from mastery evidence built over this already-authorized bulk pool.
  if (
    applyExamTarget
    && masteryEvidence
    && targetWorkload
    && targetWorkload.surplusSeats > 0
    && build.coreTargetQuotaSatisfied
  ) {
    const cardById = new Map(
      [...bulk.unseenCards, ...bulk.seenCards].map(card => [card.id, card]),
    );
    const questionById = bulk.questionMap;
    const surplusPlan = allocateExamTargetMasterySeats({
      candidates: masteryEvidence.units.flatMap(unit => (
        unit.stage === 'applied-distinction' || unit.stage === 'breadth-exploration'
          ? unit.safeMetadata.candidateItemKeys.map(itemKey => ({
              itemKey,
              unitId: unit.unitId,
              stage: unit.stage,
            }))
          : []
      )),
      eligibleUnitIdsByStage: {
        'applied-distinction': [...eligibleAppliedUnitIds],
        // Breadth remains in the ordinary constrained scheduler. Enumerate all
        // eligible applications here so a stale or runtime-rejected reservation
        // can fall through to a later unit before breadth gets the seat.
        'breadth-exploration': [],
      },
      coreTargetSeats: 0,
      surplusSeats: eligibleAppliedUnitIds.size,
    });

    const resolveQuestionConcept = (
      questionId: string,
      topics: readonly string[],
    ): ConceptState | null => {
      const linked = bulk.questionConceptLinks
        .filter(link => link.questionId === questionId)
        .map(link => ({ link, state: statesById.get(link.conceptId) }))
        .filter((entry): entry is typeof entry & { state: ConceptState } => Boolean(entry.state))
        .sort((left, right) => (
          Number(right.link.isPrimary) - Number(left.link.isPrimary)
          || right.state.priority - left.state.priority
          || left.state.conceptId.localeCompare(right.state.conceptId)
        ));
      if (linked[0]) return linked[0].state;
      return conceptStates
        .filter(state => {
          const concept = conceptMap.get(state.conceptId);
          if (!concept) return false;
          const expanded = new Set(expandTopicSet(concept.topics));
          return topics.some(topic => expanded.has(topic));
        })
        .sort((left, right) => (
          right.priority - left.priority
          || left.conceptId.localeCompare(right.conceptId)
        ))[0] ?? null;
    };

    for (const planned of surplusPlan.selectedCandidates) {
      // Applied units require an explicit reservation so an ordinary breadth
      // pick cannot consume their seat. Breadth remains in the downstream
      // constrained scheduler, where domain allocation, teaching order and
      // source caps jointly decide its membership.
      if (planned.stage !== 'applied-distinction') continue;
      if (build.selectedSurplusTargetSeats >= targetWorkload.surplusSeats) break;
      if (planned.itemKey.startsWith('card:')) {
        const card = cardById.get(planned.itemKey.slice('card:'.length));
        if (!card) continue;
        const picked = build.pickCardCandidate([{
          id: card.id,
          clusterId: card.clusterId,
          similarCards: card.similarCards,
          topics: card.topics,
          sourceFile: card.sourceFile,
          importance: card.importance,
          complexity: card.complexity,
          variantGroupId: card.variantGroupId,
          variantIndex: card.variantIndex,
          variantType: card.variantType,
        }], {
          similarityThreshold: interferenceThreshold,
          maxPerCluster: 3,
        });
        if (!picked) continue;
        const concept = resolveCoreCardConcept(picked);
        const added = build.addItem({
          type: 'card',
          id: picked.id,
          conceptId: concept?.conceptId ?? '_unattached',
          conceptName: concept?.conceptName ?? 'Exam-target surplus',
          priority: concept?.priority ?? 0.5,
          interventionReason: concept && concept.recallOnExamDay < DEFAULTS.recallThreshold
            ? 'weak_recall'
            : 'reinforcement',
          variantGroupId: picked.variantGroupId,
          variantIndex: picked.variantIndex,
          variantType: picked.variantType,
          examTargetMasteryStage: planned.stage,
          examTargetMasteryUnitId: planned.unitId,
        });
        if (added) {
          build.selectedSurplusTargetSeats += 1;
          build.recordCluster(picked.clusterId);
          build.recordCardNeighborhood(picked);
        }
        continue;
      }

      if (!planned.itemKey.startsWith('question:')) continue;
      const question = questionById.get(planned.itemKey.slice('question:'.length));
      if (!question || selectedQuestionIds.has(question.id)) continue;
      const suppressionKey = questionSuppressionKey(question);
      if (suppressionKey && selectedQuestionVariantGroups.has(suppressionKey)) continue;
      if (!takeWithReentryCap(
        question.id,
        bulk.questionFamiliarity,
        resolveRetirementPolicy(),
        masteredReentryCounter,
      )) continue;
      const concept = resolveQuestionConcept(question.id, question.topics);
      const added = build.addItem({
        type: 'question',
        id: question.id,
        conceptId: concept?.conceptId ?? `rotation:${question.id}`,
        conceptName: concept?.conceptName ?? 'Exam-target application',
        priority: concept?.priority ?? 0.5,
        interventionReason: concept && concept.recallOnExamDay < DEFAULTS.recallThreshold
          ? 'needs_retest'
          : 'reinforcement',
        ...conceptThreadPolicyReceipt(),
        variantGroupId: question.variantGroupId,
        variantType: question.variantType,
        examTargetMasteryStage: planned.stage,
        examTargetMasteryUnitId: planned.unitId,
      });
      if (added) build.selectedSurplusTargetSeats += 1;
    }
  }
}

/**
 * Hold back what the learner has not yet earned. Ineligible applications never
 * become eligible merely because a bank row exists; breadth and cross-source
 * material wait until the reserved scheduled-core prefix can actually be assembled.
 */
export function holdBackUnearnedStages(
  inputs: SchedulerInputs,
  build: SessionBuildState,
): void {
  const { applyExamTarget, bulk, eligibleAppliedUnitIds, masteryEvidence, rotation } = inputs;
  const { selectedCardIds, selectedQuestionIds } = build;

  // Ineligible applications never become eligible merely because a bank row
  // exists. Breadth and cross-source material are held back until the reserved
  // scheduled-core prefix can actually be assembled.
  if (applyExamTarget && masteryEvidence) {
    const denyByStage = (itemKey: string, sourceRotation: string): boolean => {
      const assignment = masteryEvidence.itemStageMap[itemKey];
      if (
        assignment?.stage === 'applied-distinction'
        && (
          !eligibleAppliedUnitIds.has(assignment.unitId)
          || !build.coreTargetQuotaSatisfied
        )
      ) return true;
      if (assignment?.stage === 'breadth-exploration' && !build.coreTargetQuotaSatisfied) {
        return true;
      }
      return sourceRotation !== rotation && !build.coreTargetQuotaSatisfied;
    };
    for (const card of [...bulk.unseenCards, ...bulk.seenCards]) {
      if (denyByStage(`card:${card.id}`, card.rotation)) selectedCardIds.add(card.id);
    }
    for (const question of bulk.rotationQuestions) {
      if (denyByStage(`question:${question.id}`, question.rotation)) {
        selectedQuestionIds.add(question.id);
      }
    }
  }
}

/**
 * Phase 7a: video pre-teach. When the session includes videos, inject one for each
 * very weak concept (recall on exam day under 0.4 and confidence under 0.6) that has
 * none yet.
 */
export function preTeachVideos(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const { bulk, conceptMap, includeVideos, size } = inputs;
  const { weakConcepts } = plan;
  const { selectedItems, selectedVideoIds, videosPerConcept } = build;

  // 7a) NEW: Video Pre-teach (Inject videos for very weak concepts)
  if (includeVideos) {
    const weakRecallConcepts = weakConcepts.filter(c => c.recallOnExamDay < 0.4 && c.confidence < 0.6);
    for (const concept of weakRecallConcepts) {
      if (selectedItems.length >= size) break;
      const already = videosPerConcept.get(concept.conceptId) ?? 0;
      if (already >= 1) continue;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const videos = getVideosFromBulk(concept.conceptId, conceptData, 1, bulk, { excludeVideoIds: selectedVideoIds });
      if (videos.length > 0) {
        const v = videos[0];
        build.addItem({
          type: 'video',
          id: v.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: 'pre_teach',
          videoTitle: v.title,
          videoThumbnailUrl: v.thumbnailR2Key,
          videoDuration: v.durationSecs ?? undefined,
          videoR2Key: v.r2Key,
          creatorName: v.creatorName ?? undefined,
        });
      }
    }
  }
}

/**
 * Phase 7a-naive: for each concept the learner has no prior exposure to, inject a
 * topic-matched complexity-1 card before the regular fill loops reach it, so a
 * first encounter is a teaching moment rather than a cold test. Capped at three, and
 * at the new-card budget that remains.
 */
export function preTeachNaiveConcepts(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const { bulk, conceptMap } = inputs;
  const { maxNewCards, targetCardCount, weakConcepts } = plan;
  const { selectedCardIds } = build;

  // 7a-naive) Naive-concept pre-teach.
  //
  // For each concept the user has zero prior exposure to (classified as
  // 'naive' by classifyTeachingState), inject a topic-matched C1 card
  // BEFORE the regular fill loop reaches that concept. Rationale: first
  // encounter with a brand-new concept should be a teaching moment, not
  // a cold test served from the C2/C3 pool. Empirical-difficulty data
  // (commit 4d863d17) shows ~60% of C1-labelled cards are actually hard
  // — that's a separate calibration problem, but the cleaner first-touch
  // surface here keeps cold-start failures from compounding.
  //
  // Capped at a small number (default 3) so this doesn't crowd out the
  // regular weak-concept loop. Picked cards count against the card
  // budget exactly like any other card pick.
  {
    const naivePreTeachConcepts: NaivePreTeachConcept[] = [];
    for (const cs of weakConcepts) {
      const state = classifyTeachingState({
        exposureCount: cs.exposureCount,
        recallOnExamDay: cs.recallOnExamDay,
        confidence: cs.confidence,
      });
      if (state !== 'naive') continue;
      const conceptData = conceptMap.get(cs.conceptId);
      if (!conceptData) continue;
      naivePreTeachConcepts.push({
        conceptId: cs.conceptId,
        conceptName: cs.conceptName,
        topics: conceptData.topics,
        priority: cs.priority,
      });
    }

    // Pre-teach C1 cards are UNSEEN → they are new cards and must respect the
    // new-card budget. In crunch mode (maxNewCards=0, e.g. exam-day review-only)
    // the regular fill adds no new cards; pre-teach must not sneak them in either.
    // Cap the picks to the remaining new-card budget as well as the card slots.
    const newCardBudgetRemaining = maxNewCards === Infinity ? Infinity : Math.max(0, maxNewCards - build.newCardCount);
    if (newCardBudgetRemaining > 0 && naivePreTeachConcepts.length > 0 && build.selectedCardCount < targetCardCount) {
      const slotsRemaining = targetCardCount - build.selectedCardCount;
      const picks = pickNaivePreTeachCards(naivePreTeachConcepts, bulk, {
        maxPreTeach: Math.min(3, slotsRemaining, newCardBudgetRemaining),
        alreadySelectedCardIds: selectedCardIds,
      });
      for (const pick of picks) {
        if (build.selectedCardCount >= targetCardCount) break;
        build.addItem({
          type: 'card',
          id: pick.card.id,
          conceptId: pick.conceptId,
          conceptName: pick.conceptName,
          priority: pick.priority,
          interventionReason: 'pre_teach_naive',
          variantGroupId: pick.card.variantGroupId,
          variantIndex: pick.card.variantIndex,
          variantType: pick.card.variantType,
        });
      }
    }
  }
}

/**
 * Phase 7b: fill the question quota. Walks the weak concepts round-robin across
 * clusters, one question per concept per pass and one more allowed per concept on
 * each pass; the difficulty follows the exam pressure and the concept's intervention
 * reason.
 */
export function fillQuestions(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    examPressure,
    options,
    recentFailureConceptIds,
    recentFormatsByConcept,
    stateMap,
  } = inputs;
  const {
    activeQuestionTargetScores,
    activeTargetRankMove,
    allocatedConceptRanks,
    conceptHasPristine,
    getConceptCluster,
    targetQuestionCount,
    weakConcepts,
  } = plan;
  const {
    masteredReentryCounter,
    questionsPerConcept,
    selectedQuestionIds,
    selectedQuestionVariantGroups,
  } = build;

  const maxQuestionsPerConcept = DEFAULTS.maxQuestionsPerConcept;

  function getQuestionRequestDifficulty(
    reason: UnifiedSessionItem['interventionReason'],
    indexForConcept: number
  ): QuestionDifficulty {
    // High exam pressure: harder ladder regardless of intervention reason
    if (examPressure >= 0.5) {
      const plan: QuestionDifficulty[] = ['medium', 'hard', 'hard', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
    }

    if (reason === 'low_confidence') {
      const plan: QuestionDifficulty[] = ['easy', 'medium', 'medium', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'easy';
    }
    if (reason === 'needs_retest') {
      const plan: QuestionDifficulty[] = ['medium', 'hard', 'hard', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
    }

    const plan: QuestionDifficulty[] = ['medium', 'hard'];
    return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
  }

  // 7b) Fill questions (round-robin across clusters)
  if (targetQuestionCount > 0) {
    const roundRobinForQuestions = buildClusterRoundRobin(
      weakConcepts,
      getConceptCluster,
      allocatedConceptRanks
        ? concept => allocatedConceptRanks?.get(concept.conceptId) ?? null
        : undefined,
    );

    // Iterate the round-robin ordering repeatedly to fill the session.
    // Each pass allows one more question per concept (soft cap escalation).
    for (let pass = 0; build.selectedQuestionCount < targetQuestionCount; pass++) {
      const allowedPerConcept = maxQuestionsPerConcept + pass;
      let addedThisPass = 0;

      for (const concept of roundRobinForQuestions) {
        if (build.selectedQuestionCount >= targetQuestionCount) break;

        const already = questionsPerConcept.get(concept.conceptId) ?? 0;
        if (already >= allowedPerConcept) continue;
        // Teaching-state cap: don't exceed the concept's per-state target.
        // Mastered concepts cap at 1 item total; learning/consolidating at 3;
        // naive at 2 (the 7a-naive C1 already counts).
        if (build.conceptItemsSoFar(concept.conceptId) >= build.teachingCapFor(concept.conceptId)) continue;

        const baseReason =
          concept.intervention === 'probe'
            ? concept.confidence < DEFAULTS.confidenceThreshold || concept.exposureCount < 3
              ? 'low_confidence'
              : 'needs_retest'
            : concept.intervention === 'remediate'
              ? 'needs_retest'
              : 'reinforcement';
        const interventionReason = resolveInterventionReason({
          conceptId: concept.conceptId,
          recallOnExamDay: concept.recallOnExamDay,
          baseReason,
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        });

        // Difficulty ladder still keys off the base teaching-state reason —
        // a failure-escalation pick should use the same ladder it would've
        // used otherwise (needs_retest typically). The boost label is a
        // separate signal for analytics, not a difficulty input.
        const desiredDifficulty = getQuestionRequestDifficulty(baseReason, already);

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
          difficultyPlan: [desiredDifficulty],
          reviewChallenge: options.reviewChallenge,
          reviewChallengeGap: hasDemonstratedLearningGap({
            probeCount: stateMap.get(concept.conceptId)?.probeCount,
            recallProbability: stateMap.get(concept.conceptId)?.recallProbability,
            recentFailRate: stateMap.get(concept.conceptId)?.recentFailRate,
            lastProbeAt: stateMap.get(concept.conceptId)?.lastProbeAt,
            recentFailure: recentFailureConceptIds.has(concept.conceptId),
          }),
          challengeSlotIndex: build.selectedQuestionCount,
          selectedQuestionIds,
          selectedQuestionVariantGroups,
          currentTeachingWeek: options.currentTeachingWeek,
          topicTeachingWeeks: options.topicTeachingWeeks,
          masteredReentryCounter,
          recentFormatsByConcept,
          conceptThreadMatcher: interventionReason === 'failure_escalation'
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
          interventionReason: threadMatch ? 'concept_followup' : interventionReason,
          ...conceptThreadTrace(threadMatch),
          variantGroupId: question.variantGroupId,
          variantType: question.variantType,
        });
        if (added) {
          if (threadMatch) {
            build.conceptThreadFollowupSelected = true;
          }
          addedThisPass += 1;
        }
      }

      if (addedThisPass === 0) break;
    }
  }
}

/**
 * Phase 7c: fill the card quota, less the coverage reservation. Walks the weak
 * concepts round-robin across clusters for spatial diversity, one card per concept
 * per pass, within each concept's teaching-state cap and the interference limits.
 */
export function fillCards(
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
  } = inputs;
  const {
    activeCardTargetScores,
    activeTargetRankMove,
    allocatedConceptRanks,
    conceptHasPristine,
    getConceptCluster,
    targetWeakCardCount,
    weakConcepts,
  } = plan;
  const { cardsPerConcept, selectedCardIds } = build;

  // 7c) Fill cards (round-robin across clusters for spatial diversity)
  if (targetWeakCardCount > 0) {
    // Safety ceiling — even if teaching-state suggests 4, never serve more
    // than 5 cards from a single concept in one session (queue health).
    const HARD_MAX_CARDS_PER_CONCEPT = 5;
    const roundRobinConcepts = buildClusterRoundRobin(
      weakConcepts,
      getConceptCluster,
      allocatedConceptRanks
        ? concept => allocatedConceptRanks?.get(concept.conceptId) ?? null
        : undefined,
    );

    // Iterate the round-robin ordering repeatedly (up to HARD_MAX passes)
    // to fill the session. Each pass adds at most 1 card per concept.
    for (let pass = 0; pass < HARD_MAX_CARDS_PER_CONCEPT && build.selectedCardCount < targetWeakCardCount; pass++) {
      let addedThisPass = 0;

      for (const concept of roundRobinConcepts) {
        if (build.selectedCardCount >= targetWeakCardCount) break;

        const already = cardsPerConcept.get(concept.conceptId) ?? 0;
        if (already >= HARD_MAX_CARDS_PER_CONCEPT) continue;
        // Teaching-state cap: total items per concept ≤ teachingArc.targetItems
        // (mastered=1 maintenance, learning/consolidating=3, naive=2). The
        // safety ceiling above is the absolute backstop; this is the
        // pedagogically-intended budget.
        if (build.conceptItemsSoFar(concept.conceptId) >= build.teachingCapFor(concept.conceptId)) continue;

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.currentRecall, options.currentTeachingWeek, applyExamTarget ? activeCardTargetScores : undefined, activeTargetRankMove, options.topicTeachingWeeks, options.recentFigureExposures, selectionNowMs(), options.reviewChallenge);
        if (candidates.length === 0) continue;

        const similarityThreshold = already === 0 ? interferenceThreshold : Math.min(0.97, interferenceThreshold + 0.1);
        const maxPerCluster = already === 0 ? 3 : 5;

        const picked = build.pickCardCandidate(candidates, { similarityThreshold, maxPerCluster });
        if (!picked) continue;

        const baseCardReason =
          concept.recallOnExamDay < DEFAULTS.recallThreshold
            ? 'weak_recall'
            : 'reinforcement';
        const added = build.addItem({
          type: 'card',
          id: picked.id,
          challengePolicyApplied: true,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: resolveInterventionReason({
            conceptId: concept.conceptId,
            recallOnExamDay: concept.recallOnExamDay,
            baseReason: baseCardReason,
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
          addedThisPass += 1;
        }
      }

      if (addedThisPass === 0) break;
    }
  }
}

/**
 * Phase 7d: the coverage lane. Fills the reserved slots with pristine cards from
 * concepts the main loops would not reach, most stranded first (by the size of their
 * unseen pool, exam weight breaking ties), skipping concepts already touched.
 */
export function fillCoverageLane(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
): void {
  const {
    applyExamTarget,
    bulk,
    conceptMap,
    concepts,
    interferenceThreshold,
    options,
    penaltyContext,
    recentFailureConceptIds,
    selectionNowMs,
  } = inputs;
  const {
    activeCardTargetScores,
    activeTargetRankMove,
    conceptHasPristine,
    coverageReservation,
    statesById,
    targetCardCount,
    unseenCardIds,
  } = plan;
  const { selectedCardIds, selectedConceptIds } = build;

  // 7d) Coverage lane — fill the reserved slots with pristine cards from
  // concepts the main loop wouldn't reach. Concepts ordered by their pristine
  // pool size (most stranded first), exam-weight tiebreak. Skips concepts
  // already touched in this session.
  if (coverageReservation > 0 && build.selectedCardCount < targetCardCount) {
    const conceptPristineCount = new Map<string, number>();
    for (const c of concepts) {
      if (selectedConceptIds.has(c.id)) continue;
      // Use the SAME topic expansion as getCardsFromBulk so the ordering
      // signal matches what the picker can actually find. Earlier version
      // used exact topics, which silently excluded concepts whose cards only
      // match via expansion — pristine candidates were unreachable even
      // though getCardsFromBulk would have returned them.
      const conceptTopics = new Set<string>(expandTopicSet(c.topics));
      let count = 0;
      for (const card of bulk.unseenCards) {
        if (selectedCardIds.has(card.id)) continue;
        if (card.topics.some((t) => conceptTopics.has(t))) count++;
      }
      if (count > 0) conceptPristineCount.set(c.id, count);
    }

    const coverageOrder = [...conceptPristineCount.keys()]
      .map((id) => ({
        concept: conceptMap.get(id),
        state: statesById.get(id),
        pristineCount: conceptPristineCount.get(id) ?? 0,
      }))
      .filter((row) => row.concept !== undefined)
      .sort((a, b) => {
        if (a.pristineCount !== b.pristineCount) return b.pristineCount - a.pristineCount;
        return (b.concept!.examWeight ?? 1) - (a.concept!.examWeight ?? 1);
      });

    for (const { concept, state } of coverageOrder) {
      if (build.selectedCardCount >= targetCardCount) break;
      if (!concept) continue;

      const candidates = getCardsFromBulk(concept.id, concept, 20, bulk, selectedCardIds, penaltyContext, state?.currentRecall, options.currentTeachingWeek, applyExamTarget ? activeCardTargetScores : undefined, activeTargetRankMove, options.topicTeachingWeeks, options.recentFigureExposures, selectionNowMs(), options.reviewChallenge);
      // Coverage lane only surfaces actually-pristine cards (the whole point).
      const pristineCandidates = candidates.filter((c) => unseenCardIds.has(c.id));
      if (pristineCandidates.length === 0) continue;

      const picked = build.pickCardCandidate(pristineCandidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = build.addItem({
        type: 'card',
        id: picked.id,
        challengePolicyApplied: true,
        conceptId: concept.id,
        conceptName: concept.name,
        priority: state?.priority ?? 0,
        // Coverage lane only picks pristine cards from concepts the main
        // loop didn't reach. If those concepts are strong (recall ≥ target),
        // that's E un-starve territory — surface it as strong_pristine so
        // analytics can see the lane firing. Failure-escalation still wins
        // if the user just failed this concept.
        interventionReason: resolveInterventionReason({
          conceptId: concept.id,
          recallOnExamDay: state?.recallOnExamDay ?? 0,
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
        build.recordAppliedChallengeRecall(picked.id, state?.currentRecall);
        build.recordCluster(picked.clusterId);
        build.recordCardNeighborhood(picked);
      }
    }
  }
}
