import { prisma } from '@/lib/prisma';
import {
  computeNextDueAt,
  updateRetrievalStrength,
  updateStabilityDays,
} from '@/lib/manifold';
import { updateMasteryState, type CardStatus } from '@/lib/mastery';
import { updateUserStreak } from '@/lib/stats';
import {
  updateStruggleTracking,
  isCardStuck,
  addToStruggleRegion,
  removeFromStruggleRegion,
  isLeech,
  computeLeechSuppressionHours,
} from '@/lib/knowledge/struggle';
import { resolveIntervention } from '@/lib/knowledge/intervention';
import { findLeechAlternatives } from '@/lib/knowledge/leech-regeneration';
import {
  applyLearningEventDerivedState,
  createPreparedLearningEvent,
  getConceptIdsForCard,
  prepareLearningEvent,
  type PreparedLearningEvent,
} from '@/lib/learning';
import { getCoreSkillCap } from '@/lib/core-skills';
import { findSimilar } from '@/lib/manifold';
import { invalidateClusterState } from '@/lib/manifold/clustering';
import { logger } from '@/lib/logger';
import { persistableConceptId } from '@/lib/knowledge/synthetic-concept';
import { mergeDecisionContext, type DecisionContext } from '@/lib/scheduler-observability';
import { Prisma } from '@prisma/client';
import {
  buildRequestFingerprint,
  isPrismaErrorCode,
  readOperationReplay,
} from '@/lib/idempotency';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import type { ReviewWriteContext } from '@/lib/review/review-write-observability';
import {
  dispatchPostCommit,
  type NamedPostCommitTask,
  type PostCommitScheduler,
} from '@/lib/review/post-commit';

const CARD_DUE_THRESHOLD = 0.4;

export type RecordCardReviewInput = {
  userId: string;
  cardId: string;
  clientRequestId: string;
  quality: number;
  responseTimeMs?: number | null;
  confusedWith?: string | null;
  now?: Date;
  clientTimestampFingerprint?: string | null;
  metadata?: Record<string, unknown>;
  /** Server-authored concept selected for this exact delivery. Never trust a client value. */
  servedConceptId?: string | null;
  writeContext?: ReviewWriteContext;
  // Walk audit (Phase 1 of 2026-04-17-scheduler-walk-audit)
  sessionId?: string;
  batchId?: string;
  /** Request handlers pass Next's after(); non-request callers await inline. */
  schedulePostCommit?: PostCommitScheduler;
};

export type RecordCardReviewOk = {
  ok: true;
  progress: Awaited<ReturnType<typeof prisma.cardProgress.upsert>>;
  masteryUpdate: ReturnType<typeof updateMasteryState>;
};

export type CardReviewReceipt = {
  nextDueAt: string;
  stabilityDays: number;
  retrievalStrength: number;
  status: string;
  graduated: boolean;
  consecutiveCorrectFast: number;
  /** Historical offline event was retained but did not rewind live scheduler state. */
  staleSchedulerState?: boolean;
};

export type RecordCardReviewDuplicate = {
  ok: true;
  deduped: true;
  receipt: CardReviewReceipt | null;
};

export type RecordCardReviewResult =
  | RecordCardReviewOk
  | RecordCardReviewDuplicate
  | { ok: false; status: number; error: string };

export async function recordCardReview(
  input: RecordCardReviewInput
): Promise<RecordCardReviewResult> {
  const { userId, cardId, quality, clientRequestId } = input;
  const responseTimeMs = input.responseTimeMs ?? undefined;
  const confusedWith = input.confusedWith ?? undefined;

  if (!userId) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  if (!cardId || quality === undefined) {
    return { ok: false, status: 400, error: 'cardId and quality are required' };
  }

  if (!clientRequestId) {
    return { ok: false, status: 400, error: 'clientRequestId is required' };
  }

  if (quality < 0 || quality > 5) {
    return { ok: false, status: 400, error: 'quality must be between 0 and 5' };
  }

  // Authorize from routing metadata before loading scheduling fields or
  // creating an idempotency marker. Unauthorized and missing IDs deliberately
  // share the same response.
  const cardAccess = await prisma.card.findUnique({
    where: { id: cardId },
    select: { rotation: true },
  });

  if (
    !cardAccess ||
    !await userIdCanAccessRequestedRotations(userId, [cardAccess.rotation])
  ) {
    return { ok: false, status: 404, error: 'Card not found' };
  }

  const card = await prisma.card.findUnique({
    where: { id: cardId, rotation: cardAccess.rotation },
    select: {
      id: true,
      complexity: true,
      rotation: true,
      clusterId: true,
      topics: true,
      week: true,
      variantGroupId: true,
      variantIndex: true,
    },
  });

  if (!card) {
    return { ok: false, status: 404, error: 'Card not found' };
  }

  const now = input.now ?? new Date();
  const writeContext: ReviewWriteContext = input.writeContext ?? {
    deviceBucket: 'unknown',
    transport: 'server',
    receivedAt: new Date(),
    timestampSource: input.now ? 'client_action' : 'server_received',
  };
  const requestFingerprint = buildRequestFingerprint('card_review', cardId, {
    quality,
    responseTimeMs: responseTimeMs ?? null,
    confusedWith: confusedWith ?? null,
    clientTimestamp: input.clientTimestampFingerprint !== undefined
      ? input.clientTimestampFingerprint
      : input.now?.toISOString() ?? null,
  });
  const basePreparedLearningEvent = await prepareCardLearningEvent({
    userId,
    cardId,
    rotation: card.rotation,
    week: card.week ?? undefined,
    clusterId: card.clusterId,
    variantGroupId: card.variantGroupId,
    variantIndex: card.variantIndex,
    quality,
    responseMs: responseTimeMs ?? null,
    timestamp: now,
    externalMetadata: mergeDecisionContext(input.metadata, {
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
    }),
    servedConceptId: input.servedConceptId,
    clientOperationId: clientRequestId,
    writeContext,
  });

  // Core writes and their completed idempotency receipt are atomic. A crash at
  // any point rolls back the marker, progress, and daily counters together.
  let core: {
    progress: Awaited<ReturnType<typeof prisma.cardProgress.upsert>>;
    receipt: CardReviewReceipt;
    masteryUpdate: ReturnType<typeof updateMasteryState>;
    struggleUpdate: ReturnType<typeof updateStruggleTracking>;
    preparedLearningEvent: PreparedLearningEvent;
    leechInfo: CardReviewTransition['leechInfo'];
    staleSchedulerState: boolean;
  };
  try {
    core = await prisma.$transaction(async (tx) => {
      const operation = await tx.syncOperation.create({
        data: {
          userId,
          clientOperationId: clientRequestId,
          operationType: 'card_review',
          status: 'pending',
          requestFingerprint,
        },
        select: { id: true },
      });

      // Serialize distinct logical grades for the same user/card before the
      // read that drives stability/mastery/views. A transaction isolation flag
      // alone would not help if this read remained outside the transaction.
      //
      // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`, and
      // the Prisma driver adapters (Neon in production, pg in integration) both
      // fail to deserialize a void column. $executeRaw runs the statement
      // without mapping a result set.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${cardId}))
      `;
      const existingProgress = await tx.cardProgress.findUnique({
        where: {
          cardId_userId: {
            cardId,
            userId,
          },
        },
      });

      const recordDailyStatsForReview = async () => {
        const day = new Date(now);
        day.setHours(0, 0, 0, 0);
        const txStats = await tx.dailyStats.upsert({
          where: { userId_date: { userId, date: day } },
          update: {
            cardsReviewed: { increment: 1 },
            cardsCorrect: quality >= 3 ? { increment: 1 } : undefined,
            studyTimeMs: responseTimeMs ? { increment: responseTimeMs } : undefined,
          },
          create: {
            userId,
            date: day,
            cardsReviewed: 1,
            cardsCorrect: quality >= 3 ? 1 : 0,
            pagesViewed: 0,
            studyTimeMs: responseTimeMs ?? 0,
            studyTimeMin: 0,
          },
        });
        if (responseTimeMs) {
          await tx.dailyStats.update({
            where: { id: txStats.id },
            data: { studyTimeMin: Math.ceil(txStats.studyTimeMs / 60000) },
          });
        }
      };

      // Offline sync can deliver an older logical review after a newer review
      // has already advanced this card. Preserve the historical immutable event
      // and its day-level accounting, but never apply it to current scheduler,
      // mastery, struggle, or leech state.
      if (existingProgress?.lastReview && now < existingProgress.lastReview) {
        const preparedLearningEvent = withAdditionalLearningEventMetadata(
          basePreparedLearningEvent,
          {
            retrievalStrengthBefore: existingProgress.retrievalStrength,
            staleSchedulerState: true,
          },
        );
        await recordDailyStatsForReview();
        await createPreparedLearningEvent(tx, preparedLearningEvent);
        const masteryUpdate: ReturnType<typeof updateMasteryState> = {
          status: existingProgress.status as CardStatus,
          consecutiveCorrectFast: existingProgress.consecutiveCorrectFast,
          avgResponseTimeMs: existingProgress.avgResponseTimeMs,
          masteredAt: existingProgress.masteredAt,
        };
        const receipt: CardReviewReceipt = {
          nextDueAt: existingProgress.nextDueAt.toISOString(),
          stabilityDays: existingProgress.stabilityDays,
          retrievalStrength: existingProgress.retrievalStrength,
          status: existingProgress.status,
          graduated: existingProgress.masteredAt !== null,
          consecutiveCorrectFast: existingProgress.consecutiveCorrectFast,
          staleSchedulerState: true,
        };
        await tx.syncOperation.update({
          where: { id: operation.id },
          data: { status: 'completed', result: receipt },
        });
        return {
          progress: existingProgress,
          receipt,
          masteryUpdate,
          struggleUpdate: {
            recentFailCount: existingProgress.recentFailCount,
            recentFailWindowStart: existingProgress.recentFailWindowStart,
            lastFailedAt: existingProgress.lastFailedAt,
          },
          preparedLearningEvent,
          leechInfo: null,
          staleSchedulerState: true,
        };
      }

      const transition = computeCardReviewTransition({
        existingProgress,
        card,
        quality,
        responseTimeMs,
        confusedWith,
        now,
      });
      const {
        nextStabilityDays,
        newRetrievalStrength,
        confusedWithUpdated,
        masteryUpdate,
        struggleUpdate,
        todayStart,
        newViewsToday,
        leechUpdate,
        finalNextDueAt,
      } = transition;
      const preparedLearningEvent = withAdditionalLearningEventMetadata(
        basePreparedLearningEvent,
        { retrievalStrengthBefore: transition.currentStrength },
      );

      const txProgress = await tx.cardProgress.upsert({
        where: {
          cardId_userId: {
            cardId,
            userId,
          },
        },
        update: {
          stabilityDays: nextStabilityDays,
          nextDueAt: finalNextDueAt,
          lastReview: now,
          lastQuality: quality,
          totalReviews: { increment: 1 },
          correctCount: quality >= 3 ? { increment: 1 } : undefined,
          retrievalStrength: newRetrievalStrength,
          confusedWith: confusedWithUpdated,
          reviewContext: responseTimeMs ? { responseTimeMs } : undefined,
          status: masteryUpdate.status,
          consecutiveCorrectFast: masteryUpdate.consecutiveCorrectFast,
          avgResponseTimeMs: masteryUpdate.avgResponseTimeMs,
          masteredAt: masteryUpdate.masteredAt,
          // Struggle tracking
          recentFailCount: struggleUpdate.recentFailCount,
          recentFailWindowStart: struggleUpdate.recentFailWindowStart,
          lastFailedAt: struggleUpdate.lastFailedAt,
          // Daily view cap
          viewsToday: newViewsToday,
          viewsTodayDate: todayStart,
          // Leech suppression
          ...leechUpdate,
        },
        create: {
          cardId,
          userId,
          stabilityDays: nextStabilityDays,
          nextDueAt: finalNextDueAt,
          lastReview: now,
          lastQuality: quality,
          totalReviews: 1,
          correctCount: quality >= 3 ? 1 : 0,
          retrievalStrength: newRetrievalStrength,
          confusedWith: confusedWithUpdated,
          reviewContext: responseTimeMs ? { responseTimeMs } : undefined,
          status: masteryUpdate.status,
          consecutiveCorrectFast: masteryUpdate.consecutiveCorrectFast,
          avgResponseTimeMs: masteryUpdate.avgResponseTimeMs,
          masteredAt: masteryUpdate.masteredAt,
          // Struggle tracking
          recentFailCount: struggleUpdate.recentFailCount,
          recentFailWindowStart: struggleUpdate.recentFailWindowStart,
          lastFailedAt: struggleUpdate.lastFailedAt,
          // Daily view cap
          viewsToday: 1,
          viewsTodayDate: todayStart,
        },
      });

      await recordDailyStatsForReview();

      // Mode A: the immutable event is part of the same commit boundary as
      // progress, counters, and the completed idempotency receipt.
      await createPreparedLearningEvent(tx, preparedLearningEvent);

      const receipt: CardReviewReceipt = {
        nextDueAt: txProgress.nextDueAt.toISOString(),
        stabilityDays: txProgress.stabilityDays,
        retrievalStrength: txProgress.retrievalStrength,
        status: txProgress.status,
        graduated: masteryUpdate.masteredAt !== null,
        consecutiveCorrectFast: txProgress.consecutiveCorrectFast,
      };
      await tx.syncOperation.update({
        where: { id: operation.id },
        data: { status: 'completed', result: receipt },
      });

      return {
        progress: txProgress,
        receipt,
        masteryUpdate,
        struggleUpdate,
        preparedLearningEvent,
        leechInfo: transition.leechInfo,
        staleSchedulerState: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (!isPrismaErrorCode(error, 'P2002')) throw error;
    const replay = await readOperationReplay<CardReviewReceipt>({
      userId,
      clientRequestId,
      operationType: 'card_review',
      requestFingerprint,
    });
    if (replay.kind === 'completed') {
      return { ok: true, deduped: true, receipt: replay.result };
    }
    if (replay.kind === 'conflict') {
      return { ok: false, status: 409, error: 'clientRequestId was already used for a different review' };
    }
    if (replay.kind === 'incomplete') {
      return { ok: false, status: 503, error: 'Review is still being recorded; retry with the same clientRequestId' };
    }
    throw error;
  }
  const {
    progress,
    masteryUpdate,
    struggleUpdate,
    preparedLearningEvent,
    leechInfo,
    staleSchedulerState,
  } = core;

  if (staleSchedulerState) {
    await dispatchPostCommit({
      owner: 'card-review',
      context: { userId, cardId, clientRequestId },
      scheduler: input.schedulePostCommit,
      tasks: [
        { name: 'streak', run: () => updateUserStreak(userId) },
      ],
    });
    return { ok: true, progress, masteryUpdate };
  }

  const postCommitTasks: NamedPostCommitTask[] = [];

  if (leechInfo) {
    logger.info('Leech card suppressed', {
      cardId,
      userId,
      suppressionCount: leechInfo.suppressionCount,
      suppressionHours: leechInfo.suppressionHours,
      suppressedUntil: leechInfo.suppressedUntil.toISOString(),
    });
    postCommitTasks.push({
      name: 'leech-alternatives',
      run: () => findLeechAlternatives(userId, cardId),
    });
  }

  postCommitTasks.push(
    { name: 'streak', run: () => updateUserStreak(userId) },
    {
      name: 'cluster-invalidation',
      run: () => invalidateClusterState(userId, card.clusterId ?? null),
    },
    {
      name: 'derived-learning-state',
      run: () => applyLearningEventDerivedState(preparedLearningEvent),
    },
    {
      name: 'struggle-region',
      run: () => updateStruggleRegions(
        userId,
        cardId,
        card.rotation,
        quality,
        struggleUpdate.recentFailCount,
        responseTimeMs ?? undefined,
      ),
    },
  );

  // When wrong, show similar cards instead of same card again
  if (quality < 3) {
    postCommitTasks.push({
      name: 'scaffolding-queue',
      run: () => queueScaffoldingCards(
        userId,
        cardId,
        card.rotation,
        now,
        (card.topics as string[]) ?? [],
      ),
    });
  }

  await dispatchPostCommit({
    owner: 'card-review',
    context: { userId, cardId, clientRequestId },
    scheduler: input.schedulePostCommit,
    tasks: postCommitTasks,
  });

  return { ok: true, progress, masteryUpdate };
}

type ExistingCardReviewProgress = {
  lastReview: Date | null;
  stabilityDays: number;
  retrievalStrength: number;
  totalReviews: number;
  correctCount: number;
  confusedWith: string[];
  status: string;
  consecutiveCorrectFast: number;
  avgResponseTimeMs: number | null;
  recentFailCount: number;
  recentFailWindowStart: Date | null;
  viewsTodayDate: Date | null;
  viewsToday: number;
  leechSuppressionCount: number;
  liked: boolean;
};

type CardReviewTransition = {
  currentStrength: number;
  nextStabilityDays: number;
  newRetrievalStrength: number;
  confusedWithUpdated: string[];
  masteryUpdate: ReturnType<typeof updateMasteryState>;
  struggleUpdate: ReturnType<typeof updateStruggleTracking>;
  todayStart: Date;
  newViewsToday: number;
  leechUpdate: Record<string, unknown>;
  finalNextDueAt: Date;
  leechInfo: {
    suppressionCount: number;
    suppressionHours: number;
    suppressedUntil: Date;
  } | null;
};

function computeCardReviewTransition(input: {
  existingProgress: ExistingCardReviewProgress | null;
  card: { complexity: number; rotation: string };
  quality: number;
  responseTimeMs?: number;
  confusedWith?: string;
  now: Date;
}): CardReviewTransition {
  const { existingProgress, card, quality, responseTimeMs, confusedWith, now } = input;
  const daysSinceLastReview = existingProgress?.lastReview
    ? (now.getTime() - existingProgress.lastReview.getTime()) / (1000 * 60 * 60 * 24)
    : 0;

  const currentStabilityDays = existingProgress?.stabilityDays ?? 3;
  const coreSkillCap = getCoreSkillCap(card.rotation);
  const nextStabilityDays = updateStabilityDays(
    currentStabilityDays,
    quality,
    card.rotation,
    now,
    coreSkillCap,
  );

  const currentStrength = existingProgress?.retrievalStrength ?? 0;
  const newRetrievalStrength = updateRetrievalStrength(
    currentStrength,
    quality,
    existingProgress?.totalReviews ?? 0,
    daysSinceLastReview,
    currentStabilityDays,
  );
  const computedNextDueAt = computeNextDueAt(
    newRetrievalStrength,
    now,
    nextStabilityDays,
    CARD_DUE_THRESHOLD,
    now,
  );
  const totalReviewsAfter = (existingProgress?.totalReviews ?? 0) + 1;

  let confusedWithUpdated = existingProgress?.confusedWith ?? [];
  if (confusedWith && quality < 3 && !confusedWithUpdated.includes(confusedWith)) {
    confusedWithUpdated = [...confusedWithUpdated, confusedWith];
  }

  const masteryUpdate = updateMasteryState(
    {
      status: (existingProgress?.status as CardStatus) || 'learning',
      consecutiveCorrectFast: existingProgress?.consecutiveCorrectFast ?? 0,
      avgResponseTimeMs: existingProgress?.avgResponseTimeMs ?? null,
      totalReviews: existingProgress?.totalReviews ?? 0,
    },
    { quality, responseTimeMs: responseTimeMs ?? null },
    { complexity: card.complexity },
    { totalReviews: totalReviewsAfter, retrievalStrength: newRetrievalStrength },
  );
  const struggleUpdate = updateStruggleTracking(
    quality,
    existingProgress?.recentFailCount ?? 0,
    existingProgress?.recentFailWindowStart ?? null,
    now,
  );

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const existingViewsToday = existingProgress?.viewsTodayDate
    && existingProgress.viewsTodayDate >= todayStart
    ? existingProgress.viewsToday
    : 0;
  const newViewsToday = existingViewsToday + 1;

  const newCorrectCount = (existingProgress?.correctCount ?? 0) + (quality >= 3 ? 1 : 0);
  let leechUpdate: Record<string, unknown> = {};
  let leechInfo: CardReviewTransition['leechInfo'] = null;
  if (quality < 3 && isLeech(totalReviewsAfter, newCorrectCount)) {
    const priorSuppressions = existingProgress?.leechSuppressionCount ?? 0;
    const suppressionCount = priorSuppressions + 1;
    const suppressionHours = computeLeechSuppressionHours(priorSuppressions);
    const suppressedUntil = new Date(now.getTime() + suppressionHours * 60 * 60 * 1000);
    leechUpdate = {
      leechSuppressedUntil: suppressedUntil,
      leechSuppressionCount: suppressionCount,
    };
    leechInfo = { suppressionCount, suppressionHours, suppressedUntil };
  }

  let finalNextDueAt = masteryUpdate.nextDueInDays
    ? new Date(now.getTime() + masteryUpdate.nextDueInDays * 24 * 60 * 60 * 1000)
    : computedNextDueAt;
  if (newViewsToday >= 2 && finalNextDueAt < tomorrowStart) {
    finalNextDueAt = tomorrowStart;
  }
  if (quality < 3) {
    const failCount = struggleUpdate.recentFailCount;
    const failPushbackDays = failCount >= 3 ? 3 : failCount >= 2 ? 2 : 1;
    const failFloor = new Date(todayStart.getTime() + failPushbackDays * 24 * 60 * 60 * 1000);
    if (finalNextDueAt < failFloor) finalNextDueAt = failFloor;
  }
  if (existingProgress?.liked && quality >= 3) {
    const intervalMs = finalNextDueAt.getTime() - now.getTime();
    finalNextDueAt = new Date(now.getTime() + intervalMs * 0.7);
    if (finalNextDueAt < tomorrowStart) finalNextDueAt = tomorrowStart;
  }

  return {
    currentStrength,
    nextStabilityDays,
    newRetrievalStrength,
    confusedWithUpdated,
    masteryUpdate,
    struggleUpdate,
    todayStart,
    newViewsToday,
    leechUpdate,
    finalNextDueAt,
    leechInfo,
  };
}

function withAdditionalLearningEventMetadata(
  prepared: PreparedLearningEvent,
  additions: Record<string, unknown>,
): PreparedLearningEvent {
  const existing = prepared.data.metadata;
  const metadata = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as unknown as Record<string, unknown>
    : {};
  return {
    ...prepared,
    data: {
      ...prepared.data,
      metadata: { ...metadata, ...additions } as Prisma.InputJsonValue,
    },
  };
}

/**
 * Update struggle regions after a card review
 * - On failure: check if card is now stuck, add to region
 * - On success: remove from region, resolve interventions
 */
async function updateStruggleRegions(
  userId: string,
  cardId: string,
  rotation: string,
  quality: number,
  recentFailCount: number,
  responseTimeMs?: number
): Promise<void> {
  const isSuccess = quality >= 3;

  if (isSuccess) {
    // Remove from struggle region on success
    await removeFromStruggleRegion(userId, cardId, rotation);
    // Resolve any pending interventions
    await resolveIntervention(userId, cardId, quality, responseTimeMs ?? null);
  } else {
    // Check if card is now stuck
    const stuck = isCardStuck(recentFailCount, new Date());
    if (stuck.isStuck) {
      // Add to struggle region
      await addToStruggleRegion(
        userId,
        cardId,
        rotation,
        recentFailCount,
        responseTimeMs
      );
    }
  }
}

/**
 * Queue scaffolding content when a card is failed.
 *
 * Two-pronged scaffolding:
 * 1. Simpler cloze cards (existing) — build foundational recall
 * 2. Related MCQs with explanations (new) — teach WHY, not just WHAT
 *
 * The MCQ scaffolding is the key improvement: MCQ explanations provide
 * the teaching that a student needs after failing a cloze card. Without
 * this, the student just sees more tests without understanding.
 */
async function queueScaffoldingCards(
  userId: string,
  failedCardId: string,
  rotation: string,
  now: Date,
  failedCardTopics: string[] = []
): Promise<void> {
  // Find similar cards (scaffolding) using embedding similarity
  const similarCards = await findSimilar(failedCardId, 5);

  if (similarCards.length === 0) {
    return;
  }

  // Filter to simpler cards (complexity 1-2) that might scaffold the failed concept
  const cardIds = similarCards
    .filter((c) => (c.complexity ?? 2) <= 2)
    .map((c) => c.cardId);

  // Log scaffold gap: when the scheduler WANTS to scaffold but can't find content.
  // These accumulate as demand signals for content creation.
  const hasScaffoldCards = cardIds.length > 0;
  if (!hasScaffoldCards) {
    // No simpler cards exist nearby — record as a content gap
    await prisma.contentGap.create({
      data: {
        rotation,
        gapType: 'scaffold_gap',
        nearestSimilarity: similarCards.length > 0 ? similarCards[0].similarity : 0,
        candidateCount: similarCards.length,
        // Store the failed card info in a way the worklist script can use
        conceptId: null, // Will be enriched by worklist script if needed
      },
    });

    logger.info('Scaffold gap detected', {
      failedCardId, rotation, topics: failedCardTopics,
      similarCount: similarCards.length, scaffoldableCount: 0,
    });
  }

  // Queue related MCQs — these have explanations that teach the concept
  if (failedCardTopics.length > 0) {
    try {
      const { prependCardsToQueue } = await import('@/lib/study-queue');
      // Find MCQ-backed cards on the same topics (MCQs have explanations)
      const relatedMcqCards = await prisma.card.findMany({
        where: {
          rotation,
          cardType: 'mcq',
          deletedAt: null,
          topics: { hasSome: failedCardTopics },
          id: { not: failedCardId },
        },
        select: { id: true },
        take: 2,
      });

      if (relatedMcqCards.length > 0) {
        await prependCardsToQueue(
          userId,
          rotation,
          relatedMcqCards.map(c => c.id),
          { reason: 'reinforcement', insertOffset: 3, maxItems: 2 }
        );
      }
    } catch (error) {
      // Non-critical — scaffolding cards still queue below
      logger.warn('Failed to queue related MCQ scaffolds', {
        userId,
        failedCardId,
        error: String(error),
      });
    }
  }

  if (cardIds.length === 0) {
    return;
  }

  // Queue simpler cloze cards as due now (but respect daily cap)
  await prisma.cardProgress.createMany({
    data: cardIds.map((cardId) => ({
      userId,
      cardId,
      nextDueAt: now,
    })),
    skipDuplicates: true,
  });

  // For existing progress records, just make them due now if not already seen today
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  await prisma.cardProgress.updateMany({
    where: {
      userId,
      cardId: { in: cardIds },
      // Only update if not already seen 2x today
      OR: [
        { viewsTodayDate: null },
        { viewsTodayDate: { lt: todayStart } },
        { viewsToday: { lt: 2 } },
      ],
    },
    data: {
      nextDueAt: now,
    },
  });
}

async function prepareCardLearningEvent(input: {
  userId: string;
  cardId: string;
  rotation: string;
  week?: number;
  clusterId: string | null;
  variantGroupId: string | null;
  variantIndex: number | null;
  quality: number;
  responseMs: number | null;
  timestamp: Date;
  externalMetadata?: Record<string, unknown>;
  servedConceptId?: string | null;
  clientOperationId: string;
  writeContext: ReviewWriteContext;
}): Promise<PreparedLearningEvent> {
  const servedConceptId = persistableConceptId(input.servedConceptId);
  let conceptIds: string[] = servedConceptId ? [servedConceptId] : [];
  if (conceptIds.length === 0) {
    try {
      conceptIds = await getConceptIdsForCard(input.cardId);
    } catch (error) {
      // Concept links are derived context. Preserve the immutable event even if
      // enrichment is temporarily unavailable.
      logger.warn('Failed to resolve card concepts for learning event', {
        cardId: input.cardId,
        error: String(error),
      });
    }
  }

  // Build metadata: clusterId for cluster-mastery, variantGroupId/Index for
  // variant-collapse audit, plus any caller-provided context.
  const internalMetadata: Record<string, unknown> = {};
  if (input.clusterId) internalMetadata.clusterId = input.clusterId;
  if (input.variantGroupId) internalMetadata.variantGroupId = input.variantGroupId;
  if (input.variantIndex !== null) {
    internalMetadata.variantIndex = input.variantIndex;
  }

  return prepareLearningEvent({
    userId: input.userId,
    eventType: 'card_reviewed',
    sourceType: 'card',
    sourceId: input.cardId,
    quality: input.quality,
    responseMs: input.responseMs ?? undefined,
    conceptIds,
    rotation: input.rotation,
    week: input.week,
    metadata: mergeDecisionContext(
      Object.keys(internalMetadata).length > 0 ? internalMetadata : undefined,
      input.externalMetadata as DecisionContext | undefined
    ),
    clientOperationId: input.clientOperationId,
    deviceBucket: input.writeContext.deviceBucket,
    writeTransport: input.writeContext.transport,
    receivedAt: input.writeContext.receivedAt,
    timestampSource: input.writeContext.timestampSource,
    timestamp: input.timestamp,
  });
}
