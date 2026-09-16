import { createId } from '@paralleldrive/cuid2';
import { Prisma, type ServeDecision } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { UnifiedItem } from './unified-session-types';
import { formatServeDecisionSummary } from './serve-decision-summary';
import type { ExamTargetDecisionPersistenceReceipt } from '@/lib/exam-target/decision-set-persistence.server';
import {
  tierFromComplexity,
  tierFromQuestionDifficulty,
} from '@/lib/audit/walk-metadata';

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
  /**
   * parentDecisionId -> childId already delivered in THIS session, loaded once
   * per request by `loadSessionDeliveries`. Supplying it costs one query for
   * the whole batch; omitting it falls back to one lookup per item, which is N
   * round trips on a hot path.
   */
  deliveredInSession?: Map<string, string>;
  /**
   * Parent rows for the whole batch, loaded once by `loadDeliveryParents`.
   * Without it this function issues one findUnique PER ITEM: a 59-item cached
   * session meant 59 round trips, and with the client retrying that became
   * ~180 concurrent queries competing for the same connection pool. Measured
   * user-visible waits on that path reached 140s.
   */
  parents?: Map<string, ServeDecision>;
}

/**
 * Every parent row for one delivery, in a single query.
 *
 * Returns null if the query FAILS, which is deliberately different from an
 * empty map: a supplied map is treated as authoritative, so returning an empty
 * one on error would silently strip the serveDecisionId from every item in the
 * batch. Null makes the caller fall back to per-item lookups — slower, but it
 * still delivers a session that can record answers.
 */
export async function loadDeliveryParents(
  ids: readonly string[],
): Promise<Map<string, ServeDecision> | null> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  try {
    const rows = await prisma.serveDecision.findMany({ where: { id: { in: unique } } });
    return new Map(rows.map((row) => [row.id, row]));
  } catch (err) {
    logger.error('loadDeliveryParents failed, falling back to per-item lookups', {
      count: unique.length,
      error: String(err),
    });
    return null;
  }
}

/**
 * Children already written for this session, keyed by the parent they came
 * from. Empty on a first attempt, populated on a retry.
 */
export async function loadSessionDeliveries(
  userId: string,
  sessionId: string,
): Promise<Map<string, string>> {
  try {
    const rows = await prisma.serveDecision.findMany({
      where: { userId, sessionId, parentDecisionId: { not: null } },
      select: { id: true, parentDecisionId: true },
    });
    return new Map(rows.map((r) => [r.parentDecisionId as string, r.id]));
  } catch (err) {
    // Degrade to per-item lookups rather than failing the delivery.
    logger.warn('loadSessionDeliveries failed', { userId, sessionId, error: String(err) });
    return new Map();
  }
}

export interface LiveServeDecisionWriteReceipt {
  items: UnifiedItem[];
  status: 'persisted' | 'failed' | 'empty';
  requestedCount: number;
  persistedCount: number;
}

export interface AtomicServeDecisionWriterClient {
  serveDecision: {
    createMany(args: { data: readonly Record<string, unknown>[] }): Promise<{ count: number }>;
  };
}

const inheritedExamTargetFields = (parent: ServeDecision) => ({
  decisionSetId: parent.decisionSetId ?? null,
  examTargetSnapshotId: parent.examTargetSnapshotId ?? null,
  schedulerVersion: parent.schedulerVersion ?? null,
  targetPolicyVersion: parent.targetPolicyVersion ?? null,
  targetMode: parent.targetMode ?? null,
  targetAssignment: parent.targetAssignment ?? null,
  targetId: parent.targetId ?? null,
  targetRevision: parent.targetRevision ?? null,
  targetBasis: parent.targetBasis ?? null,
  targetScorerVersion: parent.targetScorerVersion ?? null,
  targetEmbeddingHash: parent.targetEmbeddingHash ?? null,
  targetActivationRevision: parent.targetActivationRevision ?? null,
  targetRotation: parent.targetRotation ?? null,
  sourceRotation: parent.sourceRotation ?? null,
  slotClass: parent.slotClass ?? null,
  targetEligible: parent.targetEligible ?? null,
  targetApplied: parent.targetApplied ?? null,
  targetBypassReason: parent.targetBypassReason ?? null,
  targetDomainCode: parent.targetDomainCode ?? null,
  targetPressureBucket: parent.targetPressureBucket ?? null,
  examRelevancePct: parent.examRelevancePct ?? null,
  examDomainWeight: parent.examDomainWeight ?? null,
  userDomainGap: parent.userDomainGap ?? null,
  contentTargetScore: parent.contentTargetScore ?? null,
  personalizedTargetScore: parent.personalizedTargetScore ?? null,
  targetWeightProvenance: parent.targetWeightProvenance ?? null,
  targetBoostDelta: parent.targetBoostDelta ?? null,
  baseRankInPool: parent.baseRankInPool ?? null,
  targetRankInPool: parent.targetRankInPool ?? null,
  finalRankInPool: parent.finalRankInPool ?? null,
  targetChangedMembership: parent.targetChangedMembership ?? null,
  targetTraceVersion: parent.targetTraceVersion ?? null,
  targetTrace: parent.targetTrace ?? Prisma.DbNull,
});

const CONCEPT_THREAD_PAYLOAD_FIELDS = [
  'conceptThreadPolicyVersion',
  'conceptThreadPolicyApplied',
  'conceptThreadAnchorEventId',
  'conceptThreadAnchorItemId',
  'conceptThreadAnchorFacet',
  'conceptThreadTargetFacet',
  'conceptThreadSharedTopic',
  'conceptThreadAgeMs',
  'conceptThreadInterveningExposures',
] as const;

/**
 * Concept-thread fields describe why the item was selected, so they remain
 * valid when a cache-build decision is delivered later. Delivery-time recall,
 * challenge, and novelty observations do not, and are deliberately omitted.
 */
function inheritedConceptThreadPayload(
  payload: Prisma.JsonValue | null,
): Prisma.InputJsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};

  const source = payload as Prisma.JsonObject;
  const inherited: Record<string, Prisma.InputJsonValue | null> = {};
  for (const field of CONCEPT_THREAD_PAYLOAD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (value !== undefined) {
      inherited[field] = value as Prisma.InputJsonValue | null;
    }
  }
  return inherited;
}

/**
 * Where the correct option sat in the arrangement the learner was handed.
 *
 * Derived here, in the one shared row builder, rather than at each of the three
 * delivery call sites that invoke `getQuestionOptions` — a per-site wiring is a
 * per-site chance to forget, and the item already carries the exact array that
 * was sent to the client.
 *
 * Returns 0 for a correct answer at A. That value is falsy, and it is precisely
 * the one under investigation, so every consumer must use `??` rather than `||`.
 */
function servedArrangement(item: UnifiedItem): {
  servedCorrectPosition: number | null;
  servedOptionCount: number | null;
} {
  const options = item.type === 'question' ? item.options : undefined;
  if (!Array.isArray(options) || options.length === 0) {
    return { servedCorrectPosition: null, servedOptionCount: null };
  }
  const index = options.findIndex((option) => option.isCorrect === true);
  return {
    servedCorrectPosition: index >= 0 ? index : null,
    servedOptionCount: options.length,
  };
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
  const telemetryPayload = item.predictedRecallModel
    || item.predictedRecallSource
    || item.predictedRecallStatus
    || item.challengePolicyVersion
    || item.noveltyPolicyVersion
    || item.conceptThreadPolicyVersion
    || item.conditioning
    ? {
      // Grade-conditioner context, read back by the record handler alongside
      // predictedRecall so the grade path needs no history read.
      ...(item.conditioning ? { conditioning: item.conditioning } : {}),
      ...(item.predictedRecallModel ? { predictedRecallModel: item.predictedRecallModel } : {}),
      ...(item.predictedRecallSource ? { predictedRecallSource: item.predictedRecallSource } : {}),
      ...(item.predictedRecallStatus ? { predictedRecallStatus: item.predictedRecallStatus } : {}),
      ...(item.challengePolicyVersion ? {
        challengePolicyVersion: item.challengePolicyVersion,
        challengeTargetTier: item.challengeTargetTier ?? null,
        challengeDistance: item.challengeDistance ?? null,
        challengePolicyApplied: item.challengePolicyApplied ?? null,
      } : {}),
      ...(item.noveltyPolicyVersion ? {
        noveltyPolicyVersion: item.noveltyPolicyVersion,
        recentNeighborSimilarity: item.recentNeighborSimilarity ?? null,
        noveltyPenalty: item.noveltyPenalty ?? null,
      } : {}),
      ...(item.conceptThreadPolicyVersion ? {
        conceptThreadPolicyVersion: item.conceptThreadPolicyVersion,
        conceptThreadPolicyApplied: item.conceptThreadPolicyApplied ?? null,
        conceptThreadAnchorEventId: item.conceptThreadAnchorEventId ?? null,
        conceptThreadAnchorItemId: item.conceptThreadAnchorItemId ?? null,
        conceptThreadAnchorFacet: item.conceptThreadAnchorFacet ?? null,
        conceptThreadTargetFacet: item.conceptThreadTargetFacet ?? null,
        conceptThreadSharedTopic: item.conceptThreadSharedTopic ?? null,
        conceptThreadAgeMs: item.conceptThreadAgeMs ?? null,
        conceptThreadInterveningExposures:
          item.conceptThreadInterveningExposures ?? null,
      } : {}),
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
    // `complexity` is already the scheduler's immutable item-at-serve input.
    // Several paths populated exposure difficulty but left the durable decision
    // null, making concept + difficulty follow-up impossible to reconstruct.
    difficultyTier: item.difficultyTier
      ?? (item.type === 'question'
        ? tierFromQuestionDifficulty(item.difficulty)
        : tierFromComplexity(item.complexity)),
    conceptId: (item as { conceptId?: string | null }).conceptId ?? null,
    clusterId: (item as { clusterId?: string | null }).clusterId ?? null,
    variantGroupId: (item as { variantGroupId?: string | null }).variantGroupId ?? null,
    variantIndex: (item as { variantIndex?: number | null }).variantIndex ?? null,
    variantType: (item as { variantType?: string | null }).variantType ?? null,
    ...servedArrangement(item),
    summary,
    payload: telemetryPayload ?? Prisma.JsonNull,
  };
}

export async function writeLiveServeDecisionsWithReceipt(
  items: UnifiedItem[],
  ctx: LiveWriteCtx,
): Promise<LiveServeDecisionWriteReceipt> {
  if (items.length === 0) {
    return {
      items,
      status: 'empty',
      requestedCount: 0,
      persistedCount: 0,
    };
  }
  const itemsWithIds = items.map((item) => ({
    ...item,
    serveDecisionId: item.serveDecisionId ?? createId(),
  }));
  const rows = itemsWithIds.map((item, index) =>
    buildRow(item, index, ctx, ctx.decisionPath, 'live', ctx.queueReason),
  );
  try {
    const written = await prisma.serveDecision.createMany({ data: rows });
    if (written.count !== rows.length) {
      const nativeItems = items.filter((item) => item.rotation === ctx.rotation);
      logger.error('writeLiveServeDecisions incomplete', {
        userId: ctx.userId,
        sessionId: ctx.sessionId,
        decisionPath: ctx.decisionPath,
        requestedCount: rows.length,
        persistedCount: written.count,
        crossSourceDropped: items.length - nativeItems.length,
      });
      return {
        items: nativeItems,
        status: 'failed',
        requestedCount: rows.length,
        persistedCount: written.count,
      };
    }
    return {
      items: itemsWithIds,
      status: 'persisted',
      requestedCount: rows.length,
      persistedCount: written.count,
    };
  } catch (err) {
    const nativeItems = items.filter((item) => item.rotation === ctx.rotation);
    logger.error('writeLiveServeDecisions failed', {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      decisionPath: ctx.decisionPath,
      count: rows.length,
      crossSourceDropped: items.length - nativeItems.length,
      error: String(err),
    });
    return {
      items: nativeItems,
      status: 'failed',
      requestedCount: rows.length,
      persistedCount: 0,
    };
  }
}

export async function writeLiveServeDecisions(
  items: UnifiedItem[],
  ctx: LiveWriteCtx,
): Promise<UnifiedItem[]> {
  const receipt = await writeLiveServeDecisionsWithReceipt(items, ctx);
  return receipt.items;
}

/**
 * Transaction-only target writer. Unlike the legacy fail-safe writer, this
 * deliberately propagates every error so an active treatment cannot be served
 * without its decision set and per-item trace committing atomically.
 */
export async function writeLiveExamTargetServeDecisions(
  client: AtomicServeDecisionWriterClient,
  items: UnifiedItem[],
  ctx: LiveWriteCtx,
  receipt: ExamTargetDecisionPersistenceReceipt,
): Promise<UnifiedItem[]> {
  if (items.length === 0) return items;
  const itemsWithIds = items.map(item => ({
    ...item,
    serveDecisionId: item.serveDecisionId ?? createId(),
  }));
  const rows = itemsWithIds.map((item, index) => {
    const itemKey = `${item.type}:${item.id}`;
    const fields = receipt.serveDecisionFieldsByItemKey.get(itemKey);
    if (!fields) {
      throw new Error('exam-target receipt is missing a served item');
    }
    return {
      ...buildRow(item, index, ctx, ctx.decisionPath, 'live', ctx.queueReason),
      ...fields,
      targetTrace: fields.targetTrace ?? Prisma.DbNull,
    };
  });
  if (receipt.serveDecisionFieldsByItemKey.size !== rows.length) {
    throw new Error('exam-target receipt contains non-served items');
  }
  const written = await client.serveDecision.createMany({ data: rows });
  if (written.count !== rows.length) {
    throw new Error('exam-target ServeDecision write was incomplete');
  }
  return itemsWithIds;
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
  // A supplied map is authoritative: a miss means the parent is genuinely gone,
  // and refetching per item is what this batch exists to avoid.
  const parent = ctx.parents
    ? ctx.parents.get(ctx.serveDecisionId) ?? null
    : await prisma.serveDecision.findUnique({ where: { id: ctx.serveDecisionId } });
  if (!parent) {
    return { serveDecisionId: null };
  }
  const conceptThreadPayload = inheritedConceptThreadPayload(parent.payload);
  if (parent.sessionId === ctx.currentSessionId) {
    const targetCacheAgeMs = parent.decidedAt instanceof Date
      ? Math.max(0, Date.now() - parent.decidedAt.getTime())
      : null;
    await prisma.serveDecision.update({
      where: { id: parent.id },
      data: {
        deliveryPath: 'cached',
        position: ctx.currentPosition,
        // A cache-build prediction is not a delivery-time prediction. Clear it
        // so a later grade cannot enter calibration under stale conditions.
        predictedRecall: null,
        targetCacheAgeMs,
        payload: {
          ...conceptThreadPayload,
          cachePredictionDiscarded: true,
        },
      },
    });
    return { serveDecisionId: parent.id };
  }
  // Retry idempotency. The parent here is the CACHE-BUILD row, so comparing
  // session ids above can never catch a retry of the same delivery — both
  // attempts see a parent from a different session and both insert a child.
  // Keyed on the client's serve-request id (see serve-request-id.ts), a second
  // attempt finds the child the first one wrote and reuses it, so a retried
  // request costs the user nothing in exposure.
  const preloaded = ctx.deliveredInSession?.get(parent.id);
  if (preloaded) return { serveDecisionId: preloaded };
  if (!ctx.deliveredInSession) {
    const existingChild = await prisma.serveDecision.findFirst({
      where: {
        userId: ctx.userId,
        sessionId: ctx.currentSessionId,
        parentDecisionId: parent.id,
      },
      select: { id: true },
    });
    if (existingChild) return { serveDecisionId: existingChild.id };
  }

  const childSummary = formatServeDecisionSummary({
    decisionPath: parent.decisionPath ?? 'unknown',
    deliveryPath: 'cached',
    queueReason: parent.queueReason ?? undefined,
    rankInPool: parent.rankInPool ?? undefined,
    poolSize: parent.poolSize ?? undefined,
    predictedRecall: undefined,
  });
  const targetCacheAgeMs = parent.decidedAt instanceof Date
    ? Math.max(0, Date.now() - parent.decidedAt.getTime())
    : null;
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
      // A cached delivery hands over the arrangement the cache build already
      // fixed, so the child inherits it rather than re-deriving. Without this
      // the ~10:1 cached-to-live split would leave the served distribution
      // recorded almost entirely on rows that are NOT experiences.
      servedCorrectPosition: parent.servedCorrectPosition,
      servedOptionCount: parent.servedOptionCount,
      parentDecisionId: parent.id,
      ...inheritedExamTargetFields(parent),
      targetCacheAgeMs,
      summary: childSummary,
      payload: {
        ...conceptThreadPayload,
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

export async function updateServeDecisionForAnswer(
  args: AnswerUpdateCtx,
): Promise<boolean | undefined> {
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
      if (updated.count > 0) return true;

      // An idempotent grade retry can arrive after the first request already
      // consumed this exact delivery. Treat that as successfully attributed,
      // while retaining every ownership/item/session trust-boundary predicate.
      const alreadyAnswered = await prisma.serveDecision.findFirst({
        where: {
          id: args.serveDecisionId,
          userId: args.userId,
          itemType: args.itemType,
          itemId: args.itemId,
          deliveryPath: { not: null },
          answeredAt: { not: null },
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        },
        select: { id: true },
      });
      if (alreadyAnswered) return true;

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
        const updated = await prisma.serveDecision.updateMany({
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
        if (updated.count > 0) return true;

        // If a concurrent request won the guarded write after our lookup, the
        // delivery is still durably attributed. Confirm rather than reporting
        // a transient failure to the caller.
        const concurrentlyAnswered = await prisma.serveDecision.findFirst({
          where: {
            id: row.id,
            userId: args.userId,
            sessionId: args.sessionId,
            itemType: args.itemType,
            itemId: args.itemId,
            deliveryPath: { not: null },
            answeredAt: { not: null },
          },
          select: { id: true },
        });
        if (concurrentlyAnswered) return true;
      }

      // A retry without a decision id can also follow an already-attributed
      // answer. Report success only for the same user/session/item tuple.
      const alreadyAnsweredFallback = await prisma.serveDecision.findFirst({
        where: {
          userId: args.userId,
          sessionId: args.sessionId,
          itemType: args.itemType,
          itemId: args.itemId,
          deliveryPath: { not: null },
          answeredAt: { not: null },
        },
        orderBy: { decidedAt: 'desc' },
        select: { id: true },
      });
      if (alreadyAnsweredFallback) return true;
    }
    return false;
  } catch (err) {
    logger.warn('updateServeDecisionForAnswer failed', {
      userId: args.userId,
      itemType: args.itemType,
      itemId: args.itemId,
      sessionId: args.sessionId,
      error: String(err),
    });
    return false;
  }
}
