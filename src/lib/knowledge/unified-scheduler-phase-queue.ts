/**
 * Unified scheduler: the ordered queue
 *
 * Phases 8.5 and 9 of a session build: from the selected items to the queue the
 * learner sees. 8.5 lets the struggle layer add its interventions to the
 * selection; 9 orders the result. The bodies were moved unchanged out of
 * constructUnifiedSessionImpl; the first lines of each function name the fields
 * it reads from the inputs, the plan and the build state.
 */

import { logger } from '@/lib/logger';
import { batchLoadItemEmbeddings } from '@/lib/manifold';
import { isComposedDeck } from '@/lib/personal-decks';
import { sourceCorpusFor } from '@/lib/study/source-corpus';
import { capCrossSourceSessionItems } from './cross-source-cap';
import { applyDifficultyRhythm } from './difficulty-rhythm';
import { orderByManifoldWalk } from './manifold-walk';
import { breakModalityRuns } from './modality-guard';
import { injectPreemptiveScaffolds } from './preemptive-scaffold';
import { recordScaffoldGap } from './record-scaffold-gap';
import { applyStruggleInterventions } from './struggle-interventions';
import { applyReviewChallengeWave, normalizeReviewChallengeLevel } from '@/lib/study/review-challenge';
import { modalityEligibleForReviewLearning, reviewLearningPolicy } from '@/lib/study/review-learning-policy';
import { getEffectiveQuestionDifficulty } from './candidate-ranking';
import type { SessionBuildState } from './unified-scheduler-phase-state';
import type { ConceptPlan, SchedulerInputs, SessionCardMeta } from './unified-scheduler-phase-types';
import { enforceConceptTeachingCaps } from './unified-scheduler-scoring';
import type { UnifiedSessionItem } from './unified-scheduler-types';

/**
 * Phase 8.5: let the struggle layer add its interventions to the selection.
 *
 * Detects stuck cards among the selected items and applies their interventions.
 * If that fails for any reason the selection is used as it is.
 */
export async function applyStruggleToSelection(
  inputs: SchedulerInputs,
  build: SessionBuildState,
): Promise<UnifiedSessionItem[]> {
  const { userId, rotation, options, nowMs, servingRotationSeed, excludedCardIds } = inputs;
  const { selectedItems } = build;

  // 8.5. Apply struggle interventions to stuck cards
  // This is the local intelligence layer: detect stuck cards and apply interventions
  let itemsWithInterventions: UnifiedSessionItem[];
  try {
    // rotationSeed is always set, so the previous "pass options only when
    // non-empty" branch collapsed into a single call.
    const struggleOptions: {
      nowMs?: number;
      suppressSideEffects?: boolean;
      rotationSeed?: string;
      excludedCardIds: ReadonlySet<string>;
    } = { rotationSeed: servingRotationSeed, nowMs, excludedCardIds };
    if (options.suppressSchedulerSideEffects) struggleOptions.suppressSideEffects = true;
    itemsWithInterventions = await applyStruggleInterventions(
      userId,
      rotation,
      selectedItems,
      struggleOptions,
    );
  } catch (err) {
    logger.warn('Struggle interventions failed, using items as-is', { error: String(err) });
    itemsWithInterventions = selectedItems;
  }

  return itemsWithInterventions;
}

/** What phase 9 hands on: the final queue, and the card metadata phase 10 reads again. */
export interface OrderedSession {
  finalOrdered: UnifiedSessionItem[];
  cardMetaById: ReadonlyMap<string, SessionCardMeta>;
}

/**
 * Phase 9: turn the selected items into the ordered queue.
 *
 * Loads the items' embeddings, orders them by the manifold walk, applies the
 * difficulty rhythm and the modality guard, pairs pre-emptive scaffolds with the
 * high-pressure items, then re-applies the teaching caps, the mastery-stage
 * order, the cross-source ceiling and the modality guard that the scaffold pass
 * could have undone. It also settles how many core and surplus target seats the
 * final queue holds, on `build`.
 *
 * `itemsWithInterventions` is the selection after the struggle interventions. The
 * per-card metadata gathered here is returned because phase 10 reads it again.
 */
export async function orderSessionItems(
  inputs: SchedulerInputs,
  plan: ConceptPlan,
  build: SessionBuildState,
  itemsWithInterventions: UnifiedSessionItem[],
): Promise<OrderedSession> {
  const {
    rotation,
    options,
    bulk,
    servingRotationSeed,
    recentFailureConceptIds,
    effectiveMaxNewCards,
    applyExamTarget,
    masteryEvidence,
    eligibleCoreUnitIds,
    eligibleAppliedUnitIds,
    flowAxisPromise,
  } = inputs;
  const {
    cardRotationById,
    questionRotationById,
    cardSourceFileById,
    unknownItemRotation,
  } = plan;

  const learningPolicy = reviewLearningPolicy(options.reviewChallenge);
  const hardGapQuestionIds = new Set(
    learningPolicy.questionsOnly
      ? bulk.questionConceptLinks
          .filter((link) => bulk.questionMap.has(link.questionId))
          .map((link) => link.questionId)
      : [],
  );
  const cardComplexity = new Map(
    [...bulk.unseenCards, ...bulk.seenCards].map(card => [card.id, card.complexity]),
  );
  // 9. Order by manifold walk (replaces round-robin interleaving)
  const sessionCardIds = itemsWithInterventions.filter((i) => i.type === 'card').map((i) => i.id);
  const sessionQuestionIds = itemsWithInterventions.filter((i) => i.type === 'question').map((i) => i.id);
  const sessionVideoIds = itemsWithInterventions.filter((i) => i.type === 'video').map((i) => i.id);

  const [itemEmbeddings, flowResult] = await Promise.all([
    batchLoadItemEmbeddings(sessionCardIds, sessionQuestionIds, sessionVideoIds),
    flowAxisPromise,
  ]);
  const ordered = orderByManifoldWalk(itemsWithInterventions, itemEmbeddings, {
    flowAxis: flowResult?.axis && flowResult.axis.length > 0 ? flowResult.axis : undefined,
  });

  // 9b. Apply difficulty rhythm — light reorder for challenge/relief oscillation
  // Derive difficulty from priority: high priority = weak concept = hard for the student
  for (const item of ordered) {
    item.difficulty = item.priority > 0.66 ? 'hard' : item.priority > 0.33 ? 'medium' : 'easy';
  }
  const rhythmOrdered = normalizeReviewChallengeLevel(options.reviewChallenge) === 0
    ? applyDifficultyRhythm(ordered, options.commitmentLevel ?? 'browser')
    : ordered;

  // 9c. Break trailing same-type runs that would trip walk-audit's modality-monotony
  // pathology. Applied after rhythm so we don't fight its swaps; only a final sweep.
  const monotonyOrdered = breakModalityRuns(rhythmOrdered);

  // 9d. Populate topics + complexity on items from bulk lookups so the
  // preemptive-scaffold pass can do topic-overlap matching without re-fetching.
  const cardMetaById = new Map<string, {
    stableId: string | null;
    topics: string[];
    complexity: number;
    clusterId: string | null;
    variantGroupId: string | null;
    facilityIndex: number | null;
    sampleSize: number | null;
    similarCards: unknown;
  }>();
  for (const c of [...bulk.unseenCards, ...bulk.seenCards]) {
    cardMetaById.set(c.id, {
      stableId: c.stableId ?? null,
      topics: c.topics,
      complexity: c.complexity,
      clusterId: c.clusterId,
      variantGroupId: c.variantGroupId,
      facilityIndex: c.facilityIndex,
      sampleSize: c.sampleSize,
      similarCards: c.similarCards,
    });
  }
  for (const it of monotonyOrdered) {
    if (it.type === 'card') {
      const meta = cardMetaById.get(it.id);
      if (meta) {
        if (!it.topics) it.topics = meta.topics;
        if (it.complexity == null) it.complexity = meta.complexity;
        if (it.clusterId == null) it.clusterId = meta.clusterId;
        if (it.variantGroupId == null) it.variantGroupId = meta.variantGroupId;
      }
    } else if (it.type === 'question') {
      const meta = bulk.questionMap.get(it.id);
      if (meta) {
        if (!it.topics) it.topics = meta.topics;
        // Preserve Auto's exact control path. The explicit slider gets the
        // authored/empirical question difficulty for its content wave.
        if (normalizeReviewChallengeLevel(options.reviewChallenge) !== 0) {
          it.difficulty = getEffectiveQuestionDifficulty(meta);
        }
      }
    }
  }

  // 9e. Pre-emptively pair high-pressure items (questions and C≥2 cards) with
  // a topic-matched complexity-1 card. Closes the no-scaffolding-on-fail gap
  // for first-encounter misses that applyStruggleInterventions can't catch
  // (it only fires on items already known to be stuck). Cap scales with anchor
  // count, hard ceiling at items.length/4. When a pairable anchor finds no
  // matching scaffold, log a ContentGap row so demand surfaces in scaffold:needs.
  // See @/lib/knowledge/preemptive-scaffold and
  // docs/superpowers/specs/2026-05-03-paam-scaffolding-loop-design.md.
  const scaffoldPaired = injectPreemptiveScaffolds(monotonyOrdered, bulk, {
    rotationSeed: servingRotationSeed,
    // A building block follows a frontier card only after that concept was
    // just missed. A correct hard card stays a win.
    stepDownConceptIds: recentFailureConceptIds,
    // Paired scaffolds come exclusively from bulk.unseenCards, so they are
    // new material too. Keep review-only sessions strict: the final pairing
    // pass must not bypass maxNewCards=0 or grow the requested queue with a
    // pristine C1 after all earlier selection gates have run.
    maxPairings: effectiveMaxNewCards === 0 ? 0 : undefined,
    // Fire-and-forget; recordScaffoldGap never throws/rejects and enriches the
    // row with conceptId + a real topic-matched C1 candidateCount so the gap is
    // a usable authoring-vs-consumption signal, not a conceptId:null/0 stub.
    ...(!options.suppressSchedulerSideEffects ? {
      recordGap: (gap: Parameters<typeof recordScaffoldGap>[0]) => {
        void recordScaffoldGap(gap);
      },
    } : {}),
  });

  // Final endpoint gate runs after every intervention/scaffold injector. The
  // same predicate is applied before quota selection in the rankers, but this
  // prevents a later pass from widening +2/-2 back into an unsafe modality.
  const finalPolicyItems = scaffoldPaired.filter(item => {
    if (!modalityEligibleForReviewLearning(item.type, learningPolicy.level)) return false;
    if (learningPolicy.questionsOnly) {
      const question = item.type === 'question' ? bulk.questionMap.get(item.id) : undefined;
      // Injectors may source from a broader rotation pool. +2 must remain
      // inside the already filtered authored-hard, weak-concept question pool.
      if (!question || question.difficulty !== 'hard' || !hardGapQuestionIds.has(item.id)) return false;
    }
    if (learningPolicy.scaffoldsOnly) {
      return item.type === 'card' && cardComplexity.get(item.id) === 1;
    }
    return true;
  });

  // 9f. Final modality guard. injectPreemptiveScaffolds inserts C1 cards
  // after questions/C≥2 anchors, which can extend a trailing card run that
  // step 9c had bounded at 5 (e.g. [q, 5×c] → scaffold inserts c1 after q
  // → 6×c). Re-apply the guard so the scheduler's contract — output runs
  // ≤ MODALITY_MAX_SAME_TYPE_RUN — survives the scaffold pass. Verified by
  // regression test in preemptive-scaffold.test.ts.
  const masteryCoreCountByConcept = new Map<string, number>();
  for (const item of finalPolicyItems) {
    if (item.examTargetMasteryStage !== 'scheduled-atomic-core') continue;
    masteryCoreCountByConcept.set(
      item.conceptId,
      (masteryCoreCountByConcept.get(item.conceptId) ?? 0) + 1,
    );
  }
  const teachingCapped = enforceConceptTeachingCaps(
    finalPolicyItems,
    conceptId => Math.max(
      build.teachingCapFor(conceptId),
      masteryCoreCountByConcept.get(conceptId) ?? 0,
    ),
  );
  if (applyExamTarget && masteryEvidence) {
    for (const item of teachingCapped) {
      if (item.type !== 'card' && item.type !== 'question') continue;
      const assignment = masteryEvidence.itemStageMap[`${item.type}:${item.id}`];
      if (!assignment) continue;
      if (
        assignment.stage === 'scheduled-atomic-core'
        && eligibleCoreUnitIds.has(assignment.unitId)
      ) {
        item.examTargetMasteryStage = assignment.stage;
        item.examTargetMasteryUnitId = assignment.unitId;
      } else if (
        assignment.stage === 'applied-distinction'
        && build.coreTargetQuotaSatisfied
        && eligibleAppliedUnitIds.has(assignment.unitId)
      ) {
        item.examTargetMasteryStage = assignment.stage;
        item.examTargetMasteryUnitId = assignment.unitId;
      } else if (
        assignment.stage === 'breadth-exploration'
        && build.coreTargetQuotaSatisfied
      ) {
        item.examTargetMasteryStage = assignment.stage;
        item.examTargetMasteryUnitId = assignment.unitId;
      }
    }
  }

  const masteryStageRank = (item: UnifiedSessionItem): number => {
    if (item.examTargetMasteryStage === 'scheduled-atomic-core') return 0;
    if (item.examTargetMasteryStage === 'applied-distinction') return 1;
    const itemRotation = item.rotation
      ?? (item.type === 'card' ? cardRotationById.get(item.id) : undefined)
      ?? (item.type === 'question' ? questionRotationById.get(item.id) : undefined)
      ?? rotation;
    if (item.examTargetMasteryStage === 'breadth-exploration') return 3;
    return itemRotation === rotation ? 2 : 3;
  };

  // Keep each injected scaffold with its tested anchor while moving the
  // mastery stages as groups. The manifold still orders within a stage; this
  // pass only establishes the curriculum contract at the queue boundary.
  const scaffoldIndexesByTargetId = new Map<string, number[]>();
  for (let index = 0; index < teachingCapped.length; index += 1) {
    const targetId = teachingCapped[index].struggleIntervention?.isScaffold
      ? teachingCapped[index].struggleIntervention?.targetCardId
      : undefined;
    if (!targetId) continue;
    scaffoldIndexesByTargetId.set(targetId, [
      ...(scaffoldIndexesByTargetId.get(targetId) ?? []),
      index,
    ]);
  }
  const groupedIndexes = new Set<number>();
  const masteryGroups: Array<{
    rank: number;
    originalIndex: number;
    items: UnifiedSessionItem[];
  }> = [];
  for (let index = 0; index < teachingCapped.length; index += 1) {
    if (groupedIndexes.has(index)) continue;
    const item = teachingCapped[index];
    if (item.struggleIntervention?.isScaffold) continue;
    const scaffoldIndexes = scaffoldIndexesByTargetId.get(item.id) ?? [];
    groupedIndexes.add(index);
    for (const scaffoldIndex of scaffoldIndexes) groupedIndexes.add(scaffoldIndex);
    masteryGroups.push({
      rank: masteryStageRank(item),
      originalIndex: index,
      items: [item, ...scaffoldIndexes.map(scaffoldIndex => teachingCapped[scaffoldIndex])],
    });
  }
  for (let index = 0; index < teachingCapped.length; index += 1) {
    if (groupedIndexes.has(index)) continue;
    masteryGroups.push({
      rank: masteryStageRank(teachingCapped[index]),
      originalIndex: index,
      items: [teachingCapped[index]],
    });
  }
  masteryGroups.sort((left, right) => (
    left.rank - right.rank || left.originalIndex - right.originalIndex
  ));
  const masteryOrdered = applyExamTarget
    ? masteryGroups.flatMap(group => group.items)
    : teachingCapped;
  // Preemptive scaffold insertion occurs after addItem(), so repeat the source
  // ceiling at final egress. Safety wins over returning a full batch when a
  // late scaffold would exceed the private-source share.
  const sourceCapped = capCrossSourceSessionItems(masteryOrdered, {
    sessionRotation: rotation,
    allowedCrossSourceRotations: options.crossSourceRotations ?? [],
    maxCrossSourceItems: options.maxCrossSourceItems,
    // Fair seats ONLY for a composed (blended) deck. Most of its batch is
    // cross-source — NSx owns the Kubie corpus since 2026-09-16 and still
    // borrows the plates and BlueLink — so first-come spending lets one corpus
    // take every seat while the cap reports itself satisfied. Decks that own
    // all their content get a handful of dessert seats at most, and rationing
    // those across corpora is a behaviour change nobody asked for.
    ...(isComposedDeck(rotation)
      ? {
        getSourceKey: (item: { id: string; type: string; rotation?: string | null }) =>
          sourceCorpusFor({
            rotation: item.rotation
              ?? (item.type === 'card' ? cardRotationById.get(item.id) : undefined)
              ?? questionRotationById.get(item.id),
            sourceFile: item.type === 'card' ? cardSourceFileById.get(item.id) : null,
          }),
      }
      : {}),
    getRotation: (item) => {
      if (item.rotation) return item.rotation;
      if (item.type === 'card') {
        return cardRotationById.get(item.id) ?? unknownItemRotation;
      }
      if (item.type === 'question') {
        return questionRotationById.get(item.id) ?? unknownItemRotation;
      }
      return unknownItemRotation;
    },
  });
  const finalOrderedBeforeChallenge = applyExamTarget
    ? breakModalityRuns(sourceCapped, { getOrderingGroup: masteryStageRank })
    : breakModalityRuns(sourceCapped);
  // Explicit settings use the actual post-scaffold content wave as their one
  // rhythm pass. Auto remains the existing priority sine-wave control path.
  const finalOrdered = normalizeReviewChallengeLevel(options.reviewChallenge) !== 0
    ? applyReviewChallengeWave(finalOrderedBeforeChallenge, normalizeReviewChallengeLevel(options.reviewChallenge))
    : finalOrderedBeforeChallenge;
  build.selectedCoreTargetSeats = new Set(
    finalOrdered
      .filter(item => item.examTargetMasteryStage === 'scheduled-atomic-core')
      .map(item => item.examTargetMasteryUnitId)
      .filter((unitId): unitId is string => Boolean(unitId)),
  ).size;
  build.selectedSurplusTargetSeats = new Set(
    finalOrdered
      .filter(item => (
        item.examTargetMasteryStage === 'applied-distinction'
        || item.examTargetMasteryStage === 'breadth-exploration'
      ))
      .map(item => item.examTargetMasteryUnitId)
      .filter((unitId): unitId is string => Boolean(unitId)),
  ).size;

  return { finalOrdered, cardMetaById };
}
