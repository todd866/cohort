/**
 * Unified scheduler: loading the inputs
 *
 * Phase 3 of a session build. Everything the later phases read, in one place:
 * the database reads that depend on the concepts, and the values derived from
 * them. The body was moved unchanged out of constructUnifiedSessionImpl.
 */

import { ownerPrivateOrSharedCardScope, scopedCardProgressWhere } from '@/lib/cards/read-repository.server';
import type { ExamTargetMasteryStage } from '@/lib/exam-target/mastery';
import {
  type LoadedExamTargetMasteryEvidence,
  type MasteryEvidenceRepositoryClient,
  loadExamTargetMasteryEvidence,
} from '@/lib/exam-target/mastery-evidence.server';
import {
  type ExamTargetConceptScoreRepositoryClient,
  loadConceptExamTargetScores,
} from '@/lib/exam-target/repository.server';
import { computeExamTargetWorkload } from '@/lib/exam-target/workload';
import { logger } from '@/lib/logger';
import { batchLoadConceptEmbeddings } from '@/lib/manifold';
import { getExamTarget } from '@/lib/manifold/exam-target';
import { getFlowAxis } from '@/lib/manifold/flow-axis';
import { computeGapDirection } from '@/lib/manifold/gap-analysis';
import { computeKnowledgeVectorFromData } from '@/lib/manifold/knowledge-vector';
import { prisma } from '@/lib/prisma';
import { getStudyDayStart } from '@/lib/study-day';
import { applyReviewLearningPoolPolicy, bulkFetchCandidates } from './bulk-candidates';
import { hasDemonstratedLearningGap } from '@/lib/study/review-learning-policy';
import { loadRecentClinicalThreadAnchors } from './concept-thread-history';
import type { ClinicalThreadAnchor } from './concept-thread-policy';
import { fetchRecentlyServedFormatsByConcept } from './format-history';
import { PRACTICE_MISS_WINDOW_MS, derivePracticeMissConceptIds } from './practice-miss-concepts';
import {
  buildConceptTopicIndex,
  deriveCardSignalConcepts,
  deriveRecentFailureConceptIds,
  recentQuestionFailureRows,
} from './scheduler-attribution';
import { computeRemainingBudget, estimateDailyThroughput } from './throughput';
import type { SchedulerInputs, SchedulerSetup } from './unified-scheduler-phase-types';
import { resolveExamTargetEvaluationInfluence } from './unified-scheduler-scoring';

/**
 * Phase 3: everything that depends on the concepts.
 *
 * Starts the concept-scoped reads in parallel (concept states, embeddings, the
 * exam target, flow axis, throughput, recent failures and formats, practice
 * misses, the bulk candidate pool), joins them, loads the exam-target mastery
 * evidence, and derives what the later phases read: the budget, the exam-target
 * workload, the knowledge vector and its gap direction. The reads happen in the
 * same order and through the same shared-read slots as before; the block was
 * moved unchanged out of constructUnifiedSessionImpl.
 *
 * Phase 1's frozen read boundary ends inside this function, at the comment that
 * says so.
 */
export async function loadSchedulerInputs(setup: SchedulerSetup): Promise<SchedulerInputs> {
  const {
    cardRatio,
    concepts,
    daysToExam,
    effectiveMaxNewCards,
    examDate,
    examPressure,
    excludedCardIds,
    excludedQuestionIds,
    excludedVideoIds,
    includeVideos,
    interferenceThreshold,
    knownDaysToExam,
    nowMs,
    options,
    penaltyContext,
    ratingReliability,
    readPreselection,
    recentClusterExposures,
    rotation,
    selectionDeterminism,
    selectionNowMs,
    servingRotationSeed,
    size,
    userId,
    week,
  } = setup;

  const conceptIds = concepts.map((c) => c.id);
  const currentConceptIds = new Set(conceptIds);
  const conceptMap = new Map(concepts.map(c => [c.id, c]));
  const conceptTopicIndex = buildConceptTopicIndex(concepts);
  const runtimeExamTarget = options.examTarget;
  const runtimeTargetSnapshot = runtimeExamTarget?.snapshot ?? null;
  const hasDeterministicTargetSeed = typeof options.examTargetTieBreakSeed === 'string'
    && /^[a-f0-9]{64}$/.test(options.examTargetTieBreakSeed);
  const examTargetEvaluationOnly = options.examTargetEvaluationOnly === true
    && options.suppressSchedulerSideEffects === true
    && hasDeterministicTargetSeed
    && runtimeTargetSnapshot?.definition.influence.allocator === 'shadow';
  const effectiveTargetInfluence = runtimeTargetSnapshot
    ? resolveExamTargetEvaluationInfluence(
        runtimeTargetSnapshot.definition,
        examTargetEvaluationOnly,
      )
    : null;
  const targetComputeRequested = Boolean(
    runtimeTargetSnapshot
    && runtimeExamTarget?.resolved.effectiveMode !== 'off',
  );

  // 3. Get concept states, embeddings, exam target, flow axis, knowledge vector, AND bulk candidates — all in parallel
  // Share a single embeddings promise to avoid fetching the same data twice.
  // Load FULL-DIM (3072) so the embeddings can be re-shipped to SQL as halfvec
  // parameters against the 3072-dim *_embeddings tables. Downstream JS consumers
  // (computeKnowledgeVectorFromData, gapAlignmentBoost) call truncateToManifoldDim
  // themselves, so they tolerate either dim.
  const conceptEmbeddingsPromise = readPreselection(
    'concept-embeddings',
    () => batchLoadConceptEmbeddings(conceptIds, /* truncate */ false),
  );
  const bulkPromise = readPreselection('bulk-candidates', () => selectionDeterminism
    ? bulkFetchCandidates(
        userId,
        rotation,
        conceptIds,
        excludedCardIds,
        excludedQuestionIds,
        conceptEmbeddingsPromise,
        options.imageTier === 'copyright',
        options.commitmentLevel ?? 'browser',
        options.crossSourceRotations ?? [],
        targetComputeRequested ? runtimeTargetSnapshot?.id : null,
        selectionDeterminism.nowMs,
        options.crossSourceMappingMode ?? 'adjacent',
        options.practiceLocale ?? 'au',
        includeVideos,
        { clusterId: options.clusterFilter ?? null },
      )
    : bulkFetchCandidates(
        userId,
        rotation,
        conceptIds,
        excludedCardIds,
        excludedQuestionIds,
        conceptEmbeddingsPromise,
        options.imageTier === 'copyright',
        options.commitmentLevel ?? 'browser',
        options.crossSourceRotations ?? [],
        targetComputeRequested ? runtimeTargetSnapshot?.id : null,
        undefined,
        options.crossSourceMappingMode ?? 'adjacent',
        options.practiceLocale ?? 'au',
        includeVideos,
        { clusterId: options.clusterFilter ?? null },
      ));
  const flowAxisPromise = readPreselection(
    'flow-axis',
    () => getFlowAxis(rotation).catch(() => null),
  );
  const conceptTargetScoresPromise = targetComputeRequested && runtimeTargetSnapshot
    ? readPreselection('concept-target-scores', () => loadConceptExamTargetScores({
          client: prisma as unknown as ExamTargetConceptScoreRepositoryClient,
          targetSnapshotId: runtimeTargetSnapshot.id,
          conceptIds,
          allowedDomainCodes: runtimeTargetSnapshot.definition.domains.map(domain => domain.code),
        }))
      : Promise.resolve({
        scores: new Map(),
        rejectedConceptIds: [] as string[],
        neutralConceptIds: [] as string[],
      });
  const recentExamTargetDomainsPromise = targetComputeRequested && runtimeTargetSnapshot
    ? readPreselection('recent-exam-target-domains', () => prisma.serveDecision.findMany({
        where: {
          userId,
          targetRotation: runtimeTargetSnapshot.rotation,
          slotClass: 'discretionary',
          deliveryPath: { not: null },
          targetDomainCode: { not: null },
        },
        select: { targetDomainCode: true },
        orderBy: { decidedAt: 'desc' },
        take: 50,
      }).catch(() => [] as Array<{ targetDomainCode: string | null }>))
    : Promise.resolve([] as Array<{ targetDomainCode: string | null }>);

  const fourteenDaysAgo = new Date(selectionNowMs() - 14 * 24 * 60 * 60 * 1000);
  const recentFormatsPromise = readPreselection(
    'recent-formats',
    () => fetchRecentlyServedFormatsByConcept(
      userId,
      conceptIds,
      selectionDeterminism ? { nowMs: selectionDeterminism.nowMs } : {},
    ),
  );
  const conceptThreadAnchorsPromise = readPreselection(
    'concept-thread-anchors',
    () => loadRecentClinicalThreadAnchors(userId, rotation, nowMs),
  );
  // Acute-failure window: concepts the user has graded q<3 in the last 2h.
  // Used to boost the failed concept's priority on the *next* batch fetch
  // within the same session — so failing item N doesn't lead to item N+1
  // from an unrelated concept; instead, the next batch reshuffles to
  // surface the just-failed concept again for a remediation arc.
  // 2h window matches an average review session length; longer than that
  // and the scheduler relies on the usual recallProbability decay.
  const acuteFailureWindowStart = new Date(selectionNowMs() - 2 * 60 * 60 * 1000);
  const backgroundQuestionFailures = recentQuestionFailureRows(options.recentQuestionFailures, {
    userId, rotation, week: week ?? null, nowMs: selectionNowMs(),
  });
  // ServeDecision is the delivery-grounded attribution contract for both
  // cards and questions. Card.conceptId is intentionally sparse in the live
  // corpus, so joining CardProgress through that nullable column silently
  // disabled failure escalation for nearly every card.
  // Lines missed in a clinical practice sitting (practice-miss-concepts.ts):
  // one bounded read on the (userId, eventType) index, a week long, and a
  // neutral empty set on any failure so the session never waits on it.
  const practiceMissPromise = readPreselection('practice-miss-concepts', async () => {
    try {
      const rows = await prisma.learningEvent.findMany({
        where: {
          userId,
          eventType: { in: ['clinical_practice', 'group_attempted'] },
          timestamp: { gte: new Date(selectionNowMs() - PRACTICE_MISS_WINDOW_MS) },
        },
        select: { metadata: true },
        orderBy: { timestamp: 'desc' },
        take: 50,
      });
      return derivePracticeMissConceptIds(rows ?? [], conceptTopicIndex, currentConceptIds);
    } catch {
      return new Set<string>();
    }
  });

  const recentFailurePromise = readPreselection('recent-failure-concepts', () => Promise.all([
    prisma.serveDecision.findMany({
      where: {
        userId,
        answeredAt: { gte: acuteFailureWindowStart },
        deliveryPath: { not: null },
        conceptId: { in: conceptIds },
        OR: [
          { itemType: 'card', quality: { lt: 3 } },
          { itemType: 'question', isCorrect: false },
        ],
      },
      select: { id: true, itemType: true, itemId: true, conceptId: true, isCorrect: true },
    }).catch(() => []),
    // Legacy/direct card-review routes may not have a ServeDecision. Preserve
    // their remediation behavior with the same topic attribution used by the
    // rest of the card scheduler.
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(
        ownerPrivateOrSharedCardScope(userId),
        {
          userId,
          lastQuality: { lt: 3 },
          lastReview: { gte: acuteFailureWindowStart },
        },
        { rotation, deletedAt: null },
      ),
      select: { card: { select: { conceptId: true, topics: true } } },
    }).catch(() => [] as Array<{ card: { conceptId: string | null; topics: string[] } }>),
    // Keep the pre-ServeDecision question path as a compatibility fallback.
    backgroundQuestionFailures
      ? Promise.resolve(backgroundQuestionFailures.filter(row => (
          row.question.concepts.some(link => currentConceptIds.has(link.conceptId))
        )))
      : prisma.questionResponse.findMany({
      where: {
        userId,
        isCorrect: false,
        // A skip is stored isCorrect false with selectedOption 'SKIP'. It is
        // a decision not to answer, not a wrong answer, and was 42% of all
        // recorded wrong answers when measured on 2026-09-15.
        selectedOption: { not: 'SKIP' },
        createdAt: { gte: acuteFailureWindowStart },
        question: { concepts: { some: { conceptId: { in: conceptIds } } } },
      },
      select: {
        question: { select: { concepts: { select: { conceptId: true } } } },
      },
    }).catch(() => [] as Array<{ question: { concepts: Array<{ conceptId: string }> } }>),
  ]).then(([servedFailures, cardFailures, questionFailures]) => (
    deriveRecentFailureConceptIds({
      servedFailures,
      cardFailures,
      questionFailures,
      currentConceptIds,
      conceptTopicIndex,
    })
  )));

  const cardSignalConceptsPromise = readPreselection('card-signal-concepts', () => prisma.cardProgress.findMany({
    where: scopedCardProgressWhere(
      ownerPrivateOrSharedCardScope(userId),
      {
        userId,
        OR: [
          { liked: true },
          { totalReviews: { gte: 3 } },
        ],
      },
      { rotation, deletedAt: null },
    ),
    select: {
      liked: true,
      totalReviews: true,
      correctCount: true,
      card: { select: { id: true, conceptId: true, topics: true } },
    },
  }).then(async rows => {
    if (rows.length === 0) {
      return deriveCardSignalConcepts({
        rows,
        servedRowsNewestFirst: [],
        currentConceptIds,
        conceptTopicIndex,
      });
    }

    // Prefer the most recent delivery-grounded attribution. Only fall back to
    // Card.conceptId or a unique topic match when no such row exists.
    const servedRows = await prisma.serveDecision.findMany({
      where: {
        userId,
        itemType: 'card',
        itemId: { in: rows.map(row => row.card.id) },
        conceptId: { in: conceptIds },
        deliveryPath: { not: null },
      },
      select: { itemId: true, conceptId: true },
      orderBy: { decidedAt: 'desc' },
    }).catch(() => [] as Array<{ itemId: string; conceptId: string | null }>);
    return deriveCardSignalConcepts({
      rows,
      servedRowsNewestFirst: servedRows,
      currentConceptIds,
      conceptTopicIndex,
    });
  }).catch(() => ({ liked: new Set<string>(), chronic: new Set<string>() })));

  const [
    stateRecords,
    conceptEmbeddings,
    examTargetResult,
    throughputStats,
    cardSignalConcepts,
    recentFormatsByConcept,
    conceptThreadAnchors,
    recentFailureConceptIds,
    bulkCandidate,
    conceptTargetScores,
    recentExamTargetDomains,
    practiceMissConceptIds,
  ] = await Promise.all([
    readPreselection('concept-states', () => prisma.conceptState.findMany({
      where: { userId, conceptId: { in: conceptIds } },
    }).catch((err) => {
      logger.warn('Failed to fetch concept states', { error: String(err) });
      return [] as Awaited<ReturnType<typeof prisma.conceptState.findMany>>;
    })),
    conceptEmbeddingsPromise,
    readPreselection('legacy-exam-target', () => getExamTarget(rotation).catch(() => null)),
    readPreselection('throughput-stats', () => prisma.dailyStats.findMany({
      where: {
        userId,
        date: { gte: fourteenDaysAgo },
      },
      select: { cardsReviewed: true, quizzesTaken: true },
      orderBy: { date: 'asc' },
    }).catch(() => [] as Array<{ cardsReviewed: number; quizzesTaken: number }>)),
    // Explicit preference and chronic-failure signals share one card-history
    // load and one delivery-attribution lookup.
    cardSignalConceptsPromise,
    recentFormatsPromise.catch(() => new Map()),
    conceptThreadAnchorsPromise.catch(() => [] as ClinicalThreadAnchor[]),
    recentFailurePromise.catch(() => new Set<string>()),
    bulkPromise,
    conceptTargetScoresPromise,
    recentExamTargetDomainsPromise,
    practiceMissPromise,
  ]);
  if (penaltyContext) {
    penaltyContext.recentFailureConceptIds = recentFailureConceptIds;
  }
  const observedExamTargetDomainCounts = new Map<string, number>();
  for (const row of recentExamTargetDomains) {
    if (!row.targetDomainCode) continue;
    observedExamTargetDomainCounts.set(
      row.targetDomainCode,
      (observedExamTargetDomainCounts.get(row.targetDomainCode) ?? 0) + 1,
    );
  }
  const likedConceptIds = cardSignalConcepts.liked;
  const chronicFailureConceptIds = cardSignalConcepts.chronic;
  const stateMap = new Map(stateRecords.map((s) => [s.conceptId, s]));
  let bulk = bulkCandidate;
  // Apply strict endpoint lanes before any quota or concept selection.  Low
  // confidence is uncertainty, not a demonstrated gap; only observed recall
  // or an attributed recent failure qualifies the +2 hard-question pool.
  const reviewLearningGapConceptIds = new Set(
    concepts
      .filter((concept) => {
        const state = stateMap.get(concept.id) as (typeof stateRecords)[number] | undefined;
        return Boolean(state && hasDemonstratedLearningGap({
          probeCount: state.probeCount,
          recallProbability: state.recallProbability,
          recentFailRate: state.recentFailRate,
          lastProbeAt: state.lastProbeAt,
          recentFailure: recentFailureConceptIds.has(concept.id),
          now: new Date(selectionNowMs()),
        }));
      })
      .map((concept) => concept.id),
  );
  bulk = applyReviewLearningPoolPolicy(
    bulk,
    options.reviewChallenge,
    reviewLearningGapConceptIds,
  );
  let masteryEvidence: LoadedExamTargetMasteryEvidence | null = null;
  if (targetComputeRequested && runtimeTargetSnapshot) {
    try {
      masteryEvidence = await readPreselection(
        'mastery-evidence',
        () => loadExamTargetMasteryEvidence({
          client: prisma as unknown as MasteryEvidenceRepositoryClient,
          userId,
          rotation: runtimeTargetSnapshot.rotation,
          currentTeachingWeek: options.currentTeachingWeek ?? 0,
          candidateCardIds: [
            ...bulk.unseenCards.map(card => card.id),
            ...bulk.seenCards.map(card => card.id),
          ],
          candidateQuestionIds: bulk.rotationQuestions.map(question => question.id),
          candidateConceptIds: conceptIds,
          examDate,
          todayRequiredCoreComplete: false,
          todayStart: getStudyDayStart(new Date(selectionNowMs())),
          ...(selectionDeterminism
            ? { now: new Date(selectionDeterminism.nowMs) }
            : {}),
        }),
      );
    } catch (error) {
      // Missing mastery evidence is not permission to branch. The workload
      // allocator below receives a null estimate and reserves every
      // discretionary seat for the current target.
      logger.warn('Failed to load exam-target mastery evidence', {
        userId,
        rotation,
        error: String(error),
      });
    }
  }
  // Phase 1's frozen read boundary ends here. Rotation top-up, struggle
  // intervention, and final item-embedding reads below depend on the selected
  // branch output and deliberately remain per-branch residuals; sharing them
  // requires a later immutable candidate/problem snapshot design.
  const treatmentRequested = runtimeExamTarget?.resolved.effectiveMode === 'active'
    && runtimeExamTarget.resolved.assignment === 'treatment';
  const targetSidecarsValid = targetComputeRequested
    && Boolean(runtimeTargetSnapshot)
    && Boolean(runtimeExamTarget?.schedulerVersion)
    && Boolean(runtimeExamTarget?.policyDigest)
    && runtimeExamTarget?.activationRevision != null
    && bulk.examTargetRejectedItemKeys.length === 0
    && conceptTargetScores.rejectedConceptIds.length === 0
    && conceptTargetScores.scores.size > 0;
  const applyExamTarget = Boolean(
    treatmentRequested
    && targetSidecarsValid
    && effectiveTargetInfluence?.allocator !== 'shadow',
  );

  // Compute throughput and budget
  const dailyThroughput = estimateDailyThroughput(throughputStats);
  const budget = computeRemainingBudget(dailyThroughput, daysToExam, size);
  const targetWorkload = targetComputeRequested
    ? computeExamTargetWorkload({
        daysToExam: knownDaysToExam,
        remainingTargetWork: masteryEvidence?.remainingTargetWork ?? null,
        dailyCapacity: dailyThroughput,
        requestedBatchSize: options.requestedBatchSize ?? size,
        protectedCount: options.protectedSeatCount ?? 0,
        completedTargetWorkToday: masteryEvidence?.completedCoreWorkToday ?? 0,
        protectedTargetCount: options.protectedTargetSeatCount ?? 0,
      })
    : null;

  // Compute knowledge vector from already-loaded data (no extra DB queries)
  const knowledgeResult = (() => {
    try {
      return selectionDeterminism
        ? computeKnowledgeVectorFromData(
            conceptIds,
            stateMap,
            conceptEmbeddings,
            new Date(selectionDeterminism.nowMs),
          )
        : computeKnowledgeVectorFromData(conceptIds, stateMap, conceptEmbeddings);
    } catch {
      return null;
    }
  })();

  // Compute 256D gap direction for exam-readiness bias
  let gapDirection: number[] | null = null;
  if (examTargetResult && knowledgeResult && examTargetResult.chunkCount > 0 && knowledgeResult.conceptCount > 0) {
    gapDirection = computeGapDirection(examTargetResult.centroid, knowledgeResult.knowledgeVector);
  }

  const eligibleMasteryUnits = (stage: ExamTargetMasteryStage): Set<string> => new Set(
    masteryEvidence?.masteryPlan.orderedEligibleStages
      .find(entry => entry.stage === stage)
      ?.units.map(unit => unit.unitId) ?? [],
  );
  const eligibleCoreUnitIds = eligibleMasteryUnits('scheduled-atomic-core');
  const eligibleAppliedUnitIds = eligibleMasteryUnits('applied-distinction');

  // Everything phases 1 to 3 settled, gathered read-only for the phases that follow.
  const inputs: SchedulerInputs = {
    userId,
    options,
    rotation,
    size,
    interferenceThreshold,
    includeVideos,
    selectionDeterminism,
    servingRotationSeed,
    nowMs,
    selectionNowMs,
    daysToExam,
    examPressure,
    cardRatio,
    effectiveMaxNewCards,
    excludedCardIds,
    excludedQuestionIds,
    excludedVideoIds,
    penaltyContext,
    recentClusterExposures,
    concepts,
    conceptMap,
    runtimeExamTarget,
    runtimeTargetSnapshot,
    examTargetEvaluationOnly,
    effectiveTargetInfluence,
    targetComputeRequested,
    targetSidecarsValid,
    applyExamTarget,
    conceptTargetScores,
    observedExamTargetDomainCounts,
    masteryEvidence,
    eligibleCoreUnitIds,
    eligibleAppliedUnitIds,
    targetWorkload,
    stateMap,
    conceptEmbeddings,
    gapDirection,
    likedConceptIds,
    chronicFailureConceptIds,
    practiceMissConceptIds,
    recentFailureConceptIds,
    recentFormatsByConcept,
    conceptThreadAnchors,
    ratingReliability,
    budget,
    bulk,
    flowAxisPromise,
  };

  return inputs;
}
