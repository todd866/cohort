import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import { questionImageIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { resolveImageAlternatives } from '@/lib/figures/resolve-alternatives';
import { logger } from '@/lib/logger';
import { getExamDateForUser } from '@/lib/rotations';
import { getCurrentRetrievalStrength } from '@/lib/manifold';
import {
  estimateDailyThroughput,
  projectStrengthWithStudy,
} from '@/lib/knowledge/throughput';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import { scoreOrderedPairwiseDistances } from '@/lib/manifold/scoring';
import { sessionCandidateItemWhere } from '@/lib/knowledge/session-candidate-scope';
import {
  capCrossSourceSessionItems,
  MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
} from '@/lib/knowledge/cross-source-cap';
import {
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';
import { logExposures } from './unified-session-helpers';
import { writeLiveServeDecisions } from './serve-decision-write';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import {
  isProtectedReviewTargetContext,
  type ProtectedReviewDecisionContext,
  writeProtectedReviewServeDecisions,
} from '@/lib/exam-target/protected-review-decision.server';
import type { ExamTargetRotation } from '@/lib/exam-target/types';
import {
  terminalizeExamTargetDecisionAttempt,
  type ExamTargetAttemptFailureClass,
  type ExamTargetAttemptLedgerClient,
} from '@/lib/exam-target/attempt-ledger.server';

const MASTERY_THRESHOLD = 0.7;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizedTopics(ctx: SessionContext): string[] {
  return [...new Set(
    (ctx.topicsFilter ?? '')
      .split(',')
      .map((topic) => topic.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function rowMatchesTopics(
  row: { card: { topics?: readonly string[] } },
  topics: readonly string[],
): boolean {
  if (topics.length === 0) return true;
  const rowTopics = new Set(
    (row.card.topics ?? []).map((topic) => topic.toLowerCase()),
  );
  return topics.some((topic) => rowTopics.has(topic));
}

function protectedReviewDecisionContext(
  ctx: SessionContext,
): ProtectedReviewDecisionContext | null {
  if (
    (ctx.reviewFilter !== 'due' && ctx.reviewFilter !== 'at-risk')
    || !isProtectedReviewTargetContext(ctx.rotation, ctx.examTarget)
    || ctx.examTargetAttempt?.decisionPath !== 'review-filter'
  ) {
    return null;
  }
  return {
    attemptId: ctx.examTargetAttempt.id,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
    rotation: ctx.rotation as ExamTargetRotation,
    reviewFilter: ctx.reviewFilter,
    requestedSize: ctx.batchSize,
    sourcePolicy: {
      allowed: [...new Set([
        ctx.rotation,
        ...(ctx.crossSourceRotations ?? []),
      ])].sort(),
      max: MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
    },
    examTarget: ctx.examTarget,
  };
}

async function writeProtectedReviewTelemetryIfNeeded(
  items: UnifiedItem[],
  ctx: SessionContext,
): Promise<UnifiedItem[] | null> {
  const context = protectedReviewDecisionContext(ctx);
  return context === null
    ? null
    : writeProtectedReviewServeDecisions({ context, items });
}

function authorizedCrossSourceRotations(ctx: SessionContext): string[] {
  return [...new Set(
    (ctx.crossSourceRotations ?? []).filter(
      (sourceRotation) => sourceRotation !== ctx.rotation,
    ),
  )];
}

const PROGRESS_SELECT = {
  cardId: true,
  retrievalStrength: true,
  stabilityDays: true,
  lastReview: true,
  nextDueAt: true,
  suppressed: true,
  flagged: true,
  status: true,
  leechSuppressedUntil: true,
  card: {
    select: {
      id: true,
      front: true,
      back: true,
      backs: true,
      context: true,
      sourceComponent: true,
      rotation: true,
      week: true,
      difficulty: true,
      topics: true,
      imageUrl: true,
      imageCaption: true,
      imageRole: true,
      clusterId: true,
      shelvedAt: true,
    },
  },
} as const;

// At-risk ranking can inspect thousands of progress rows (especially for
// imported decks). Keep that first pass narrow, then hydrate only the selected
// batch with PROGRESS_SELECT below.
const RISK_PROGRESS_SELECT = {
  cardId: true,
  retrievalStrength: true,
  stabilityDays: true,
  lastReview: true,
  suppressed: true,
  flagged: true,
  status: true,
  leechSuppressedUntil: true,
  card: {
    select: {
      week: true,
      topics: true,
      shelvedAt: true,
      rotation: true,
    },
  },
} as const;

type ProgressRow = {
  cardId: string;
  retrievalStrength: number;
  stabilityDays: number;
  lastReview: Date | null;
  nextDueAt: Date;
  suppressed: boolean;
  flagged: boolean;
  status: string;
  leechSuppressedUntil: Date | null;
  card: {
    id: string;
    front: string;
    back: string;
    backs: unknown;
    context: string | null;
    sourceComponent: string;
    rotation: string;
    week: number | null;
    difficulty: string;
    topics: string[];
    imageUrl: string | null;
    imageCaption: string | null;
    imageRole: string | null;
    clusterId: string | null;
    shelvedAt: Date | null;
  };
};

type RiskProgressRow = {
  cardId: string;
  retrievalStrength: number;
  stabilityDays: number;
  lastReview: Date | null;
  suppressed: boolean;
  flagged: boolean;
  status: string;
  leechSuppressedUntil: Date | null;
  card: {
    week: number | null;
    topics: string[];
    shelvedAt: Date | null;
    rotation: string;
  };
};

type RankedRow = {
  row: ProgressRow;
  predictedRecall: number;
};

function emptyResponse(ctx: SessionContext) {
  return NextResponse.json({
    items: [],
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
  });
}

function isCurrentlySuppressed(
  row: Pick<
    ProgressRow,
    'suppressed' | 'flagged' | 'status' | 'leechSuppressedUntil'
  > & { card: { shelvedAt: Date | null } },
  now: Date,
): boolean {
  return row.suppressed
    || row.flagged
    || row.status === 'retired'
    || row.card.shelvedAt !== null
    || (row.leechSuppressedUntil !== null && row.leechSuppressedUntil > now);
}

async function loadDuePartitionRows(
  ctx: SessionContext,
  now: Date,
  cardScope: Prisma.CardWhereInput,
  take: number,
): Promise<ProgressRow[]> {
  const topics = normalizedTopics(ctx);
  const rows = await prisma.cardProgress.findMany({
    where: scopedCardProgressWhere(
      ownerPrivateOrSharedCardScope(ctx.userId),
      {
        userId: ctx.userId,
        nextDueAt: { lte: now },
        lastReview: { not: null },
        suppressed: false,
        flagged: false,
        status: { notIn: ['retired'] },
        OR: [
          { leechSuppressedUntil: null },
          { leechSuppressedUntil: { lt: now } },
        ],
        ...(ctx.clientExcludeCardSet.size > 0
          ? { cardId: { notIn: [...ctx.clientExcludeCardSet] } }
          : {}),
      },
      {
        ...cardScope,
        ...(ctx.weekFilter !== null ? { week: ctx.weekFilter } : {}),
        ...(topics.length > 0 ? { topics: { hasSome: topics } } : {}),
        deletedAt: null,
        shelvedAt: null,
      },
    ),
    select: PROGRESS_SELECT,
    orderBy: { nextDueAt: 'asc' },
    take,
  });

  return (rows as ProgressRow[]).filter((row) => rowMatchesTopics(row, topics));
}

async function loadDueRows(ctx: SessionContext, now: Date): Promise<RankedRow[]> {
  const nativeRows = await loadDuePartitionRows(
    ctx,
    now,
    sessionCandidateItemWhere(ctx.rotation),
    ctx.batchSize,
  );
  const sourceRotations = authorizedCrossSourceRotations(ctx);
  const sourceLimit = Math.min(
    ctx.batchSize,
    MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
  );
  const sourceRows = sourceRotations.length > 0 && sourceLimit > 0
    ? await loadDuePartitionRows(
      ctx,
      now,
      {
        ...sessionCandidateItemWhere(ctx.rotation, sourceRotations),
        // Keep the target-match OR predicate above and additionally isolate
        // this query to an authorized non-native partition. Running native and
        // source queries independently prevents source-heavy due ordering from
        // consuming the database LIMIT before native rows are considered.
        rotation: { in: sourceRotations },
      },
      sourceLimit,
    )
    : [];

  const rows = capCrossSourceSessionItems(
    [
      ...nativeRows,
      // Prisma enforces `take`, and this slice keeps the boundary deterministic
      // for injected/test delegates too.
      ...sourceRows.slice(0, sourceLimit),
    ].sort((a, b) => a.nextDueAt.getTime() - b.nextDueAt.getTime()),
    {
      sessionRotation: ctx.rotation,
      allowedCrossSourceRotations: sourceRotations,
      maxCrossSourceItems: MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
      getRotation: (row) => row.card.rotation,
    },
  ).slice(0, ctx.batchSize);

  return rows.map((row) => ({
    row,
    predictedRecall: getCurrentRetrievalStrength(
      row.retrievalStrength,
      row.lastReview,
      row.stabilityDays,
    ),
  }));
}

/**
 * Select the same exam-risk population exposed by /api/study/exam-readiness:
 * reviewed cards whose study-aware exam-day projection is below 0.7, ordered
 * by projected decay. The throughput denominator remains rotation-wide even
 * for a week-focused request, then week is applied to the final candidate set.
 */
async function loadAtRiskRows(ctx: SessionContext, now: Date): Promise<RankedRow[]> {
  const examDate = await getExamDateForUser(ctx.rotation, ctx.userId);
  if (!examDate) return [];

  const topics = normalizedTopics(ctx);
  const cardScope: Prisma.CardWhereInput = {
    ...sessionCandidateItemWhere(
      ctx.rotation,
      ctx.crossSourceRotations ?? [],
    ),
    ...(topics.length > 0 ? { topics: { hasSome: topics } } : {}),
  };
  const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);
  const [rawRows, dailyStats] = await Promise.all([
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(
        ownerPrivateOrSharedCardScope(ctx.userId),
        {
          userId: ctx.userId,
          // CardProgress rows are also materialized when a card is merely shown
          // or an initial queue is seeded. Exam readiness divides its future
          // study budget by reviewed cards only, so unseen rows must not dilute
          // the projection denominator.
          lastReview: { not: null },
        },
        {
          ...cardScope,
          deletedAt: null,
        },
      ),
      select: RISK_PROGRESS_SELECT,
    }),
    prisma.dailyStats.findMany({
      where: {
        userId: ctx.userId,
        date: { gte: fourteenDaysAgo },
      },
      select: { cardsReviewed: true, quizzesTaken: true },
      orderBy: { date: 'asc' },
    }),
  ]);

  const rows = rawRows as RiskProgressRow[];
  const daysToExam = Math.max(
    1,
    Math.ceil((examDate.getTime() - now.getTime()) / DAY_MS),
  );
  const dailyThroughput = estimateDailyThroughput(dailyStats);
  const reviewedRows = rows
    .map((row) => ({
      row,
      currentStrength: getCurrentRetrievalStrength(
        row.retrievalStrength,
        row.lastReview,
        row.stabilityDays,
      ),
    }))
    .filter(({ currentStrength }) => currentStrength > 0);
  const exposuresPerCard = reviewedRows.length > 0
    ? (dailyThroughput * daysToExam) / reviewedRows.length
    : 0;

  const rankedCandidates = reviewedRows
    .map(({ row, currentStrength }) => {
      const examDayStrength = projectStrengthWithStudy(
        currentStrength,
        row.stabilityDays,
        daysToExam,
        exposuresPerCard,
      );
      return {
        row,
        currentStrength,
        examDayStrength,
        decayRisk: Math.max(0, currentStrength - examDayStrength),
      };
    })
    .filter(({ row, currentStrength, examDayStrength }) =>
      currentStrength > 0
      && examDayStrength < MASTERY_THRESHOLD
      && !isCurrentlySuppressed(row, now)
      && (ctx.weekFilter === null || row.card.week === ctx.weekFilter)
      && rowMatchesTopics(row, topics)
      && !ctx.clientExcludeCardSet.has(row.cardId),
    )
    .sort((a, b) => b.decayRisk - a.decayRisk);
  const selected = capCrossSourceSessionItems(rankedCandidates, {
    sessionRotation: ctx.rotation,
    allowedCrossSourceRotations: authorizedCrossSourceRotations(ctx),
    maxCrossSourceItems: MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
    getRotation: ({ row }) => row.card.rotation,
  })
    // Apply the source quota before the batch slice. Otherwise an imported
    // deck can occupy the whole risk-ranked prefix and native candidates that
    // follow it never reach hydration.
    .slice(0, ctx.batchSize)
    .map(({ row, currentStrength }) => ({
      cardId: row.cardId,
      predictedRecall: currentStrength,
    }));
  if (selected.length === 0) return [];

  const selectedIds = selected.map(({ cardId }) => cardId);
  const hydratedRows = await prisma.cardProgress.findMany({
    where: scopedCardProgressWhere(
      ownerPrivateOrSharedCardScope(ctx.userId),
      {
        userId: ctx.userId,
        cardId: { in: selectedIds },
      },
      {
        ...cardScope,
        deletedAt: null,
        shelvedAt: null,
      },
    ),
    select: PROGRESS_SELECT,
  }) as ProgressRow[];
  const hydratedById = new Map(hydratedRows.map((row) => [row.cardId, row]));

  // Preserve the risk ordering from the first pass. Re-check mutable suppression
  // fields after hydration so a concurrent flag/suppress cannot slip through
  // between the ranking and delivery queries.
  return selected.flatMap(({ cardId, predictedRecall }) => {
    const row = hydratedById.get(cardId);
    if (
      !row
      || isCurrentlySuppressed(row, now)
      || !rowMatchesTopics(row, topics)
    ) return [];
    return [{ row, predictedRecall }];
  });
}

async function hydrateRows(
  rankedRows: RankedRow[],
  ctx: SessionContext,
): Promise<UnifiedItem[]> {
  const trustOverride = ctx.imageTier === 'copyright'
    ? 'copyright-required' as const
    : 'auth-required' as const;
  const rawItems = (await Promise.all(rankedRows.map(async ({ row, predictedRecall }) => {
    const { card } = row;
    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(card.imageUrl, null, trustOverride);
    } catch (error) {
      logger.warn('review-filter: card image resolve failed', {
        cardId: card.id,
        error: String(error),
      });
    }
    if (questionImageIsPrompt(card.imageRole, card.imageUrl) && !resolved) return null;

    return {
      type: 'card' as const,
      id: card.id,
      front: card.front,
      back: card.back,
      backs: card.backs as string[] | null,
      context: card.context,
      sourceComponent: card.sourceComponent,
      rotation: card.rotation,
      week: card.week,
      difficulty: card.difficulty,
      topics: card.topics,
      imageUrl: resolved?.imageUrl ?? null,
      imageKey: resolved?.imageKey ?? null,
      imageCaption: card.imageCaption,
      imageRole: card.imageRole ?? null,
      imageMeta: resolved?.imageMeta,
      imageAlternatives: await resolveImageAlternatives({ ...card, type: 'card' }, card.imageUrl ?? null, null, trustOverride),
      servedBy: 'focused' as const,
      clusterId: card.clusterId,
      poolSize: rankedRows.length,
      predictedRecall,
      difficultyTier: null,
      decisionContext: {
        servedBy: 'focused' as const,
        sessionType: 'review' as const,
        sessionId: ctx.sessionId,
        reviewFilter: ctx.reviewFilter,
        embeddingType: 'none' as const,
      },
    };
  }))).filter((item): item is NonNullable<typeof item> => item !== null);

  const eligibleRawItems = await filterDeliverableReinforcementCardRows(rawItems, {
    cardReadScope: ownerPrivateOrSharedCardScope(ctx.userId),
    logContext: {
      path: 'review-filter',
      userId: ctx.userId,
      rotation: ctx.rotation,
      reviewFilter: ctx.reviewFilter,
    },
  });
  const ordered = eligibleRawItems.map((item) => ({
    id: item.id,
    table: 'card_embeddings' as const,
    column: 'card_id' as const,
  }));
  const similarityToPriorMap = await scoreOrderedPairwiseDistances(ordered);
  return enrichItemsWithWalkMetadata(eligibleRawItems, similarityToPriorMap);
}

/**
 * Fast explicit-filter lane. It owns due/at-risk requests completely (including
 * the empty result) so they can never fall through into an unrelated feed.
 * `new` continues through the existing new-only manifold contract.
 */
export async function tryReviewFilterSession(
  ctx: SessionContext,
): Promise<NextResponse | null> {
  if (ctx.reviewFilter !== 'due' && ctx.reviewFilter !== 'at-risk') return null;
  // The client may issue a small rereview slot beside the primary slot. An
  // explicit due/at-risk filter is owned by the primary request only; refusing
  // this duplicate call keeps one aggregate cross-source ceiling and prevents
  // phantom ServeDecisions for items the merged UI would discard.
  if (ctx.requestedMode === 'rereview') return emptyResponse(ctx);
  if (ctx.isGuest || ctx.typeFilter === 'question' || ctx.typeFilter === 'group') {
    return emptyResponse(ctx);
  }

  let failureClass: ExamTargetAttemptFailureClass = 'precompute_failed';
  try {
    const now = new Date();
    const rankedRows = ctx.reviewFilter === 'due'
      ? await loadDueRows(ctx, now)
      : await loadAtRiskRows(ctx, now);
    if (rankedRows.length === 0) {
      await writeProtectedReviewTelemetryIfNeeded([], ctx);
      return emptyResponse(ctx);
    }

    failureClass = 'postprocess_failed';
    const cappedRankedRows = capCrossSourceSessionItems(rankedRows, {
      sessionRotation: ctx.rotation,
      allowedCrossSourceRotations: ctx.crossSourceRotations ?? [],
      maxCrossSourceItems: MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
      getRotation: ({ row }) => row.card.rotation,
    });
    const items = await hydrateRows(cappedRankedRows, ctx);
    if (items.length === 0) {
      await writeProtectedReviewTelemetryIfNeeded([], ctx);
      return emptyResponse(ctx);
    }

    const targetItemsWithDecisions = await writeProtectedReviewTelemetryIfNeeded(
      items,
      ctx,
    );
    const itemsWithDecisions = targetItemsWithDecisions
      ?? await writeLiveServeDecisions(items, {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          batchId: ctx.batchId,
          rotation: ctx.rotation,
          decisionPath: 'review-filter',
          queueReason: ctx.reviewFilter,
        });

    logExposures(itemsWithDecisions, {
      userId: ctx.userId,
      rotation: ctx.rotation,
      queueType: ctx.reviewFilter,
      batchId: ctx.batchId,
      sessionId: ctx.sessionId,
      anonymousSessionId: ctx.anonymousSessionId,
      feedMode: ctx.feedMode,
    });

    return NextResponse.json({
      items: itemsWithDecisions,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
    });
  } catch (error) {
    const attempt = ctx.examTargetAttempt?.decisionPath === 'review-filter'
      ? ctx.examTargetAttempt
      : null;
    if (attempt) {
      try {
        await terminalizeExamTargetDecisionAttempt(
          prisma as unknown as ExamTargetAttemptLedgerClient,
          {
            attemptId: attempt.id,
            userId: ctx.userId,
            outcome: 'request_failed',
            failureClass,
            servedDisposition: 'none',
            servedItemCount: 0,
            fallbackTracePersisted: null,
          },
        );
      } catch {
        logger.warn('review-filter attempt terminalization unavailable', {
          code: 'terminalization-failed',
          rotation: ctx.rotation,
          reviewFilter: ctx.reviewFilter,
          outcome: 'request_failed',
        });
      }
    }
    throw error;
  }
}
