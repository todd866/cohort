import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { UnifiedItem } from './unified-session-types';
import { formatServeDecisionSummary } from './serve-decision-summary';

export interface LiveWriteCtx {
  userId: string;
  sessionId: string;
  batchId?: string;
  rotation?: string;
  decisionPath: string;
  queueReason?: string;
}

export interface CacheBuildWriteCtx {
  userId: string;
  cacheBuildSessionId: string;
  rotation?: string;
  decisionPath: string;
  queueReason?: string;
}

export interface DeliveryCtx {
  serveDecisionId: string;
  currentSessionId: string;
  currentPosition: number;
  userId: string;
}

function buildRow(
  item: UnifiedItem,
  index: number,
  ctx: { userId: string; sessionId: string; batchId?: string; rotation?: string },
  decisionPath: string,
  deliveryPath: 'live' | 'cached' | null,
  queueReason?: string,
) {
  const rankInPool =
    typeof (item as { rankInPool?: number }).rankInPool === 'number'
      ? (item as { rankInPool?: number }).rankInPool
      : index;
  // Prefer the per-item interventionReason (set by the scheduler — values
  // like 'pre_teach_naive', 'weak_recall', 'mcq_bridge_card') over the
  // ctx-level queueReason (which is the pathway name like 'manifold-walk').
  // Before this fix, every ServeDecision row from a manifold session got
  // queueReason='manifold-walk' regardless of why the scheduler picked the
  // item — losing the per-item teaching signal in analytics. The pathway
  // name is still preserved on `decisionPath`, so that view of the data
  // doesn't change.
  const itemReason = (item as { interventionReason?: string }).interventionReason;
  const effectiveQueueReason = itemReason ?? queueReason;
  const summary = formatServeDecisionSummary({
    decisionPath,
    deliveryPath,
    queueReason: effectiveQueueReason,
    rankInPool,
    poolSize: item.poolSize ?? undefined,
    predictedRecall: item.predictedRecall ?? undefined,
    conceptLabel: (item as { conceptName?: string }).conceptName,
  });
  const predictionPayload = item.predictedRecallModel
    || item.predictedRecallSource
    || item.predictedRecallStatus
    ? {
      ...(item.predictedRecallModel ? { predictedRecallModel: item.predictedRecallModel } : {}),
      ...(item.predictedRecallSource ? { predictedRecallSource: item.predictedRecallSource } : {}),
      ...(item.predictedRecallStatus ? { predictedRecallStatus: item.predictedRecallStatus } : {}),
    }
    : null;
  return {
    id: item.serveDecisionId ?? createId(),
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId ?? null,
    itemType: item.type,
    itemId: item.id,
    rotation: ctx.rotation ?? null,
    week: item.week ?? null,
    decisionPath,
    deliveryPath,
    queueReason: effectiveQueueReason ?? null,
    position: index,
    rankInPool: rankInPool ?? null,
    poolSize: item.poolSize ?? null,
    priority: item.priority ?? null,
    predictedRecall: item.predictedRecall ?? null,
    difficultyTier: item.difficultyTier ?? null,
    conceptId: (item as { conceptId?: string | null }).conceptId ?? null,
    clusterId: (item as { clusterId?: string | null }).clusterId ?? null,
    variantGroupId: (item as { variantGroupId?: string | null }).variantGroupId ?? null,
    variantIndex: (item as { variantIndex?: number | null }).variantIndex ?? null,
    variantType: (item as { variantType?: string | null }).variantType ?? null,
    summary,
    payload: predictionPayload ?? Prisma.JsonNull,
  };
}

export async function writeLiveServeDecisions(
  items: UnifiedItem[],
  ctx: LiveWriteCtx,
): Promise<UnifiedItem[]> {
  if (items.length === 0) return items;
  const itemsWithIds = items.map((item) => ({
    ...item,
    serveDecisionId: item.serveDecisionId ?? createId(),
  }));
  const rows = itemsWithIds.map((item, i) =>
    buildRow(item, i, ctx, ctx.decisionPath, 'live', ctx.queueReason),
  );
  try {
    await prisma.serveDecision.createMany({ data: rows });
    return itemsWithIds;
  } catch (err) {
    logger.error('writeLiveServeDecisions failed', {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      decisionPath: ctx.decisionPath,
      count: rows.length,
      error: String(err),
    });
    return items;
  }
}

export async function writeCacheBuildServeDecisions(
  items: UnifiedItem[],
  ctx: CacheBuildWriteCtx,
): Promise<UnifiedItem[]> {
  if (items.length === 0) return items;
  const itemsWithIds = items.map((item) => ({
    ...item,
    serveDecisionId: item.serveDecisionId ?? createId(),
  }));
  const rows = itemsWithIds.map((item, i) =>
    buildRow(
      item,
      i,
      {
        userId: ctx.userId,
        sessionId: ctx.cacheBuildSessionId,
        batchId: ctx.cacheBuildSessionId,
        rotation: ctx.rotation,
      },
      ctx.decisionPath,
      null,
      ctx.queueReason,
    ),
  );
  try {
    await prisma.serveDecision.createMany({ data: rows });
    return itemsWithIds;
  } catch (err) {
    logger.error('writeCacheBuildServeDecisions failed', {
      userId: ctx.userId,
      cacheBuildSessionId: ctx.cacheBuildSessionId,
      count: rows.length,
      error: String(err),
    });
    return items;
  }
}

export async function applyCacheDelivery(
  ctx: DeliveryCtx,
): Promise<{ serveDecisionId: string | null }> {
  const parent = await prisma.serveDecision.findUnique({ where: { id: ctx.serveDecisionId } });
  if (!parent) {
    return { serveDecisionId: null };
  }
  if (parent.sessionId === ctx.currentSessionId) {
    await prisma.serveDecision.update({
      where: { id: parent.id },
      data: {
        deliveryPath: 'cached',
        position: ctx.currentPosition,
        // A cache-build prediction is not a delivery-time prediction. Clear it
        // so a later grade cannot enter calibration under stale conditions.
        predictedRecall: null,
        payload: { cachePredictionDiscarded: true },
      },
    });
    return { serveDecisionId: parent.id };
  }
  const childSummary = formatServeDecisionSummary({
    decisionPath: parent.decisionPath ?? 'unknown',
    deliveryPath: 'cached',
    queueReason: parent.queueReason ?? undefined,
    rankInPool: parent.rankInPool ?? undefined,
    poolSize: parent.poolSize ?? undefined,
    predictedRecall: undefined,
  });
  const child = await prisma.serveDecision.create({
    data: {
      userId: ctx.userId,
      sessionId: ctx.currentSessionId,
      itemType: parent.itemType,
      itemId: parent.itemId,
      rotation: parent.rotation,
      week: parent.week,
      decisionPath: parent.decisionPath,
      deliveryPath: 'cached',
      queueReason: parent.queueReason,
      position: ctx.currentPosition,
      rankInPool: parent.rankInPool,
      poolSize: parent.poolSize,
      priority: parent.priority,
      predictedRecall: null,
      difficultyTier: parent.difficultyTier,
      conceptId: parent.conceptId,
      clusterId: parent.clusterId,
      variantGroupId: parent.variantGroupId,
      variantIndex: parent.variantIndex,
      variantType: parent.variantType,
      parentDecisionId: parent.id,
      summary: childSummary,
      payload: {
        inheritedFrom: parent.id,
        cachePredictionDiscarded: true,
      },
    },
  });
  return { serveDecisionId: child.id };
}

export interface AnswerUpdateCtx {
  userId: string;
  itemType: 'card' | 'question' | 'video' | 'group';
  itemId: string;
  sessionId?: string;
  serveDecisionId?: string;
  isCorrect?: boolean | null;
  quality?: number | null;
  responseTimeMs?: number | null;
}

export async function updateServeDecisionForAnswer(args: AnswerUpdateCtx): Promise<void> {
  const data = {
    answeredAt: new Date(),
    isCorrect: args.isCorrect ?? null,
    quality: args.quality ?? null,
    responseTimeMs: args.responseTimeMs ?? null,
  };
  try {
    if (args.serveDecisionId) {
      // The ID arrives verbatim from the client. Scope it to the exact served
      // item (and current session when supplied), not just the account: a stale
      // same-user ID must not attribute this outcome to another item/session.
      const updated = await prisma.serveDecision.updateMany({
        where: {
          id: args.serveDecisionId,
          userId: args.userId,
          itemType: args.itemType,
          itemId: args.itemId,
          deliveryPath: { not: null },
          answeredAt: null,
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
        data,
      });
      if (updated.count > 0) return;
      logger.warn('serveDecisionId did not match the submitted item/session, falling back', {
        serveDecisionId: args.serveDecisionId,
      });
    }
    if (args.sessionId) {
      const row = await prisma.serveDecision.findFirst({
        where: {
          userId: args.userId,
          sessionId: args.sessionId,
          itemType: args.itemType,
          itemId: args.itemId,
          deliveryPath: { not: null },
          answeredAt: null,
        },
        orderBy: { decidedAt: 'desc' },
      });
      if (row) {
        // The lookup chooses the newest candidate; the guarded write is the
        // atomic claim. A concurrent grade can win between these statements,
        // but can never be overwritten by this one.
        await prisma.serveDecision.updateMany({
          where: {
            id: row.id,
            userId: args.userId,
            sessionId: args.sessionId,
            itemType: args.itemType,
            itemId: args.itemId,
            deliveryPath: { not: null },
            answeredAt: null,
          },
          data,
        });
      }
    }
  } catch (err) {
    logger.warn('updateServeDecisionForAnswer failed', {
      userId: args.userId,
      itemType: args.itemType,
      itemId: args.itemId,
      sessionId: args.sessionId,
      error: String(err),
    });
  }
}
