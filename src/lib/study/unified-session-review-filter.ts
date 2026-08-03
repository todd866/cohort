import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import { resolveImage } from '@/lib/figures/resolve';
import { logger } from '@/lib/logger';
import { getExamDateForUser } from '@/lib/rotations';
import { getCurrentRetrievalStrength } from '@/lib/manifold';
import {
  estimateDailyThroughput,
  projectStrengthWithStudy,
} from '@/lib/knowledge/throughput';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import { scoreOrderedPairwiseDistances } from '@/lib/manifold/scoring';
import { logExposures } from './unified-session-helpers';
import { writeLiveServeDecisions } from './serve-decision-write';
import type { SessionContext, UnifiedItem } from './unified-session-types';

const MASTERY_THRESHOLD = 0.7;
const DAY_MS = 24 * 60 * 60 * 1000;

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
      shelvedAt: true,
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
    shelvedAt: Date | null;
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

async function loadDueRows(ctx: SessionContext, now: Date): Promise<RankedRow[]> {
  const rows = await prisma.cardProgress.findMany({
    where: {
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
      card: {
        rotation: ctx.rotation,
        ...(ctx.weekFilter !== null ? { week: ctx.weekFilter } : {}),
        deletedAt: null,
        shelvedAt: null,
      },
      ...(ctx.clientExcludeCardSet.size > 0
        ? { cardId: { notIn: [...ctx.clientExcludeCardSet] } }
        : {}),
    },
    select: PROGRESS_SELECT,
    orderBy: { nextDueAt: 'asc' },
    take: ctx.batchSize,
  });

  return (rows as ProgressRow[]).map((row) => ({
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

  const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);
  const [rawRows, dailyStats] = await Promise.all([
    prisma.cardProgress.findMany({
      where: {
        userId: ctx.userId,
        // CardProgress rows are also materialized when a card is merely shown
        // or an initial queue is seeded. Exam readiness divides its future
        // study budget by reviewed cards only, so unseen rows must not dilute
        // the projection denominator.
        lastReview: { not: null },
        card: {
          rotation: ctx.rotation,
          deletedAt: null,
        },
      },
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

  const selected = reviewedRows
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
      && !ctx.clientExcludeCardSet.has(row.cardId),
    )
    .sort((a, b) => b.decayRisk - a.decayRisk)
    .slice(0, ctx.batchSize)
    .map(({ row, currentStrength }) => ({
      cardId: row.cardId,
      predictedRecall: currentStrength,
    }));
  if (selected.length === 0) return [];

  const selectedIds = selected.map(({ cardId }) => cardId);
  const hydratedRows = await prisma.cardProgress.findMany({
    where: {
      userId: ctx.userId,
      cardId: { in: selectedIds },
      card: {
        rotation: ctx.rotation,
        deletedAt: null,
        shelvedAt: null,
      },
    },
    select: PROGRESS_SELECT,
  }) as ProgressRow[];
  const hydratedById = new Map(hydratedRows.map((row) => [row.cardId, row]));

  // Preserve the risk ordering from the first pass. Re-check mutable suppression
  // fields after hydration so a concurrent flag/suppress cannot slip through
  // between the ranking and delivery queries.
  return selected.flatMap(({ cardId, predictedRecall }) => {
    const row = hydratedById.get(cardId);
    if (!row || isCurrentlySuppressed(row, now)) return [];
    return [{ row, predictedRecall }];
  });
}

async function hydrateRows(
  rankedRows: RankedRow[],
  ctx: SessionContext,
): Promise<UnifiedItem[]> {
  const session = await auth();
  const rawItems = (await Promise.all(rankedRows.map(async ({ row, predictedRecall }) => {
    const { card } = row;
    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(card.imageUrl, session);
    } catch (error) {
      logger.warn('review-filter: card image resolve failed', {
        cardId: card.id,
        error: String(error),
      });
    }
    if (card.imageRole === 'prompt' && !resolved) return null;

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
      imageMeta: resolved?.imageMeta,
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
  if (ctx.isGuest || ctx.typeFilter === 'question' || ctx.typeFilter === 'group') {
    return emptyResponse(ctx);
  }

  const now = new Date();
  const rankedRows = ctx.reviewFilter === 'due'
    ? await loadDueRows(ctx, now)
    : await loadAtRiskRows(ctx, now);
  if (rankedRows.length === 0) return emptyResponse(ctx);

  const items = await hydrateRows(rankedRows, ctx);
  if (items.length === 0) return emptyResponse(ctx);

  const itemsWithDecisions = await writeLiveServeDecisions(items, {
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
}
