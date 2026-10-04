/**
 * Unified scheduler: setting up the request
 *
 * Phases 1 and 2 of a session build. The two functions here were moved unchanged
 * out of unified-scheduler.ts; the fingerprint helper is used only by the setup.
 */

import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { loadRatingReliabilityRecord } from '@/lib/review/rating-reliability-record';
import { getExamDateForUser } from '@/lib/rotations';
import { fetchExclusionData } from './exclusion-data';
import { DEFAULTS } from './unified-scheduler-config';
import type { SchedulerSetup } from './unified-scheduler-phase-types';
import { computeExamPressure, resolveMaxNewCards } from './unified-scheduler-scoring';
import { fingerprintUnifiedSchedulerSharedReadInput } from './unified-scheduler-shared-reads';
import type { UnifiedSessionOptions } from './unified-scheduler-types';
import { reviewLearningPolicy } from '@/lib/study/review-learning-policy';

function unifiedSchedulerSharedReadFingerprint(
  userId: string,
  options: UnifiedSessionOptions,
): string {
  const target = options.examTarget;
  return fingerprintUnifiedSchedulerSharedReadInput({
    schema: 'md3.unified-scheduler-shared-reads/v1',
    userId,
    request: {
      rotation: options.rotation,
      // Preserve values that the runtime treats differently even if the
      // TypeScript surface excludes them. This key is a fail-closed boundary,
      // so an explicit null must never alias an omitted optional input.
      week: options.week,
      size: options.size === undefined ? DEFAULTS.size : options.size,
      mode: options.mode ?? 'normal',
      cardRatio: options.cardRatio ?? null,
      interferenceThreshold: options.interferenceThreshold === undefined
        ? DEFAULTS.interferenceThreshold
        : options.interferenceThreshold,
      excludeCardIdsSource: options.excludeCardIds === undefined
        ? 'omitted'
        : options.excludeCardIds === null
          ? 'null'
          : 'provided',
      excludeCardIds: new Set(options.excludeCardIds ?? []),
      excludeQuestionIdsSource: options.excludeQuestionIds === undefined
        ? 'omitted'
        : options.excludeQuestionIds === null
          ? 'null'
          : 'provided',
      excludeQuestionIds: new Set(options.excludeQuestionIds ?? []),
      excludeVideoIds: new Set(options.excludeVideoIds ?? []),
      recentTopicExposuresProvided: options.recentTopicExposures !== undefined,
      recentTopicExposures: options.recentTopicExposures ?? null,
      recentCardIds: new Set(options.recentCardIds ?? []),
      recentClusterExposures: options.recentClusterExposures ?? null,
      recentQuestionFailures: options.recentQuestionFailures ?? null,
      maxNewCards: options.maxNewCards ?? null,
      includeVideos: options.includeVideos ?? false,
      commitmentLevel: options.commitmentLevel ?? 'browser',
      imageTier: options.imageTier ?? 'standard',
      currentTeachingWeek: options.currentTeachingWeek ?? null,
      protectedSeatCount: options.protectedSeatCount ?? null,
      protectedTargetSeatCount: options.protectedTargetSeatCount ?? null,
      requestedBatchSize: options.requestedBatchSize ?? null,
      examTargetTieBreakSeed: options.examTargetTieBreakSeed ?? null,
      selectionDeterminism: options.selectionDeterminism ?? null,
      crossSourceRotations: new Set(options.crossSourceRotations ?? []),
      maxCrossSourceItems: options.maxCrossSourceItems ?? null,
    },
    target: target ? {
      computeRequested: Boolean(
        target.snapshot && target.resolved.effectiveMode !== 'off'
      ),
      targetVersion: target.resolved.targetVersion,
      snapshot: target.snapshot ? {
        id: target.snapshot.id,
        targetId: target.snapshot.targetId,
        revision: target.snapshot.revision,
        targetVersion: target.snapshot.targetVersion,
        rotation: target.snapshot.rotation,
        lifecycle: target.snapshot.lifecycle,
        privacyValidated: target.snapshot.privacyValidated,
        targetBasis: target.snapshot.targetBasis,
        scorerVersion: target.snapshot.scorerVersion,
        artifactHash: target.snapshot.artifactHash,
        definition: target.snapshot.definition,
      } : null,
      activationRevision: target.activationRevision,
      schedulerVersion: target.schedulerVersion,
      policyDigest: target.policyDigest,
      loadFailureReason: target.loadFailureReason,
    } : null,
  });
}

/**
 * Phases 1 and 2: settle the request before any read that depends on the concepts.
 *
 * Resolves the selection clock and the seeds, reads the exam date, the concepts and
 * the exclusions in parallel, and derives the exam horizon (days to exam, exam
 * pressure), the card ratio and the new-card allowance. The body was moved
 * unchanged out of constructUnifiedSessionImpl.
 */
export async function resolveSchedulerSetup(
  userId: string,
  options: UnifiedSessionOptions,
): Promise<SchedulerSetup> {
  const {
    rotation,
    week,
    size = DEFAULTS.size,
    interferenceThreshold = DEFAULTS.interferenceThreshold,
    includeVideos = false,
  } = options;
  const selectionDeterminism = options.selectionDeterminism
    && Number.isFinite(options.selectionDeterminism.nowMs)
    && /^[a-f0-9]{64}$/.test(options.selectionDeterminism.seed)
    ? options.selectionDeterminism
    : null;
  // Rotation seed shared by every lane that INJECTS an item chosen from a
  // candidate pool (pre-emptive scaffolds, mcq bridge cards). Without a seed
  // those lanes pick deterministically — lowest index, or top-1 by a static
  // score — which makes one card the permanent choice for its cluster or topic
  // set. Measured 2026-08-19: cache-refresh ran 6.52 scaffold serves/card over
  // 336 cards, and mcq_bridge_card 7.40 over 20. Hour granularity keeps a study
  // block stable while still rotating 24×/day, and a replay pass reuses its own
  // seed so determinism is preserved. See .claude/rules/repetition-guards.md.
  const servingRotationSeed = selectionDeterminism
    ? `serving:${selectionDeterminism.seed}`
    : `serving:${userId}:${new Date().toISOString().slice(0, 13)}`;
  const sharedReadContext = options.sharedReadContext;
  if (sharedReadContext) {
    sharedReadContext.assertFingerprint(
      unifiedSchedulerSharedReadFingerprint(userId, options),
    );
  }
  const readPreselection = <T>(slot: string, loader: () => Promise<T>): Promise<T> =>
    sharedReadContext ? sharedReadContext.read(slot, loader) : loader();
  const selectionNowMs = () => selectionDeterminism?.nowMs ?? Date.now();

  // When exclusion data is not provided, fetch it internally (used by background cache refresh)
  const needsExclusionFetch = !options.excludeCardIds && !options.excludeQuestionIds && !options.recentTopicExposures;

  const nowMs = selectionNowMs();
  const cardRepeatCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const questionRepeatCutoff = new Date(nowMs - 48 * 60 * 60 * 1000);

  // 1+2. Get exam date, concepts, and optionally exclusion data — all in parallel
  const [ratingReliability, examDate, concepts, exclusionData, openIssueExclusions, recentVideoProgress] = await Promise.all([
    // One PK read of a precomputed verdict, not a history aggregation; null
    // when absent, and the grade conditioner then passes through.
    readPreselection('rating-reliability', () => loadRatingReliabilityRecord(userId)),
    readPreselection('exam-date', () => getExamDateForUser(rotation, userId).catch(() => null)),
    readPreselection('concepts', () => prisma.concept.findMany({
      where: {
        rotation,
        ...(week !== undefined ? { week } : {}),
      },
      select: { id: true, name: true, week: true, examWeight: true, prerequisiteIds: true, topics: true },
    }).catch((err) => {
      logger.warn('Failed to fetch concepts, falling back to cluster session', { error: String(err) });
      return [] as Array<{ id: string; name: string; week: number | null; examWeight: number | null; prerequisiteIds: string[]; topics: string[] }>;
    })),
    needsExclusionFetch
      ? readPreselection(
          'exclusion-data',
          () => fetchExclusionData(userId, cardRepeatCutoff, questionRepeatCutoff),
        )
      : Promise.resolve(null),
    readPreselection('open-issue-exclusions', () => getOpenIssueExclusions().catch((error) => {
      logger.warn('Failed to apply open issue exclusions', { error: String(error) });
      return { cardIds: new Set<string>(), questionIds: new Set<string>() };
    })),
    includeVideos ? readPreselection('recent-video-progress', () => prisma.videoProgress.findMany({
      where: { userId, watchedAt: { gte: new Date(selectionNowMs() - 7 * 24 * 60 * 60 * 1000) } },
      select: { videoId: true }
    }).catch(() => [])) : Promise.resolve([]),
  ]);

  let excludedCardIds: Set<string>;
  let excludedQuestionIds: Set<string>;
  const excludedVideoIds = new Set(options.excludeVideoIds ?? []);
  for (const v of recentVideoProgress) excludedVideoIds.add(v.videoId);
  let penaltyContext: {
    recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>;
    recentCardIds: ReadonlySet<string>;
    recentFailureConceptIds?: ReadonlySet<string>;
    nowMs: number;
  } | undefined;
  let recentClusterExposures: Map<string, number> | undefined;

  if (exclusionData) {
    excludedCardIds = exclusionData.excludedCardIds;
    excludedQuestionIds = exclusionData.excludedQuestionIds;
    penaltyContext = exclusionData.recentTopicExposures.size > 0 || exclusionData.recentCardIds.size > 0
      ? {
          recentTopicExposures: exclusionData.recentTopicExposures,
          recentCardIds: exclusionData.recentCardIds,
          nowMs: selectionNowMs(),
        }
      : undefined;
    recentClusterExposures = exclusionData.recentClusterExposures.size > 0
      ? exclusionData.recentClusterExposures
      : undefined;
  } else {
    excludedCardIds = new Set(options.excludeCardIds ?? []);
    excludedQuestionIds = new Set(options.excludeQuestionIds ?? []);
    penaltyContext = options.recentTopicExposures || (options.recentCardIds?.size ?? 0) > 0
      ? {
          recentTopicExposures: options.recentTopicExposures ?? new Map(),
          recentCardIds: options.recentCardIds ?? new Set(),
          nowMs: selectionNowMs(),
        }
      : undefined;
    recentClusterExposures = options.recentClusterExposures;
  }

  for (const id of openIssueExclusions.cardIds) excludedCardIds.add(id);
  for (const id of openIssueExclusions.questionIds) excludedQuestionIds.add(id);

  const knownDaysToExam = examDate
    ? Math.max(0, (examDate.getTime() - selectionNowMs()) / (1000 * 60 * 60 * 24))
    : null;
  // Keep the legacy 45-day fallback for ranking pressure and recall projection.
  // Workload pacing below must retain an unknown deadline as unknown.
  const daysToExam = knownDaysToExam ?? 45;

  // Exam proximity pressure: sigmoid centered at 21 days
  // Drives gradual shift toward MCQ-heavy, hard-only, high-yield sessions
  const examPressure = options.mode === 'crunch' ? 1 : computeExamPressure(daysToExam);

  // Card ratio: 0.7 (70% cards) at low pressure → 0.4 (40% cards) at full pressure
  const automaticCardRatio = options.cardRatio ?? (DEFAULTS.cardRatio - 0.3 * examPressure);
  const learningPolicy = reviewLearningPolicy(options.reviewChallenge);
  // Endpoint lanes are hard contracts. Middle settings gently bias the
  // ordinary ratio while preserving an explicit caller preference.
  const cardRatio = learningPolicy.level === 2
    ? 0
    : learningPolicy.level === -2
      ? 1
      : learningPolicy.level === 1
        ? Math.min(automaticCardRatio, learningPolicy.preferredCardShare)
        : learningPolicy.level === -1
          ? Math.max(automaticCardRatio, learningPolicy.preferredCardShare)
          : automaticCardRatio;
  // New cards run all the way to the exam; see resolveMaxNewCards.
  const effectiveMaxNewCards = resolveMaxNewCards({
    explicit: options.maxNewCards,
    mode: options.mode,
  });
  // Legacy-only hard filter. A validated v2 treatment disables it after its
  // immutable sidecars have passed the runtime checks below.
  // There was a low-yield filter here: from ~21 days out it dropped every
  // concept whose Concept.examWeight was 1, which on CAH is 38 of 116.
  //
  // Removed 2026-09-17 (owner's call) because that weight does not mean what its
  // name says. It is density-derived from the cluster extract — roughly, how
  // many cards we happen to hold about a thing — and the ranking code says so
  // itself, calling it "a legacy fallback, not an exam blueprint" and
  // neutralising it whenever a real exam-target treatment applies. So the
  // number was DISTRUSTED for scoring and TRUSTED for exclusion, which is
  // backwards: it did its most consequential work in the one place the code
  // did not believe it. It also excluded on a date rather than on anything
  // about the learner.

  return {
    userId,
    options,
    rotation,
    week,
    size,
    interferenceThreshold,
    includeVideos,
    selectionDeterminism,
    servingRotationSeed,
    nowMs,
    selectionNowMs,
    readPreselection,
    ratingReliability,
    examDate,
    concepts,
    excludedCardIds,
    excludedQuestionIds,
    excludedVideoIds,
    penaltyContext,
    recentClusterExposures,
    knownDaysToExam,
    daysToExam,
    examPressure,
    cardRatio,
    effectiveMaxNewCards,
  };
}
