import { NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { UnifiedItem, SessionContext } from './unified-session-types';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import {
  buildCacheResponsePayload,
  filterClientExcludedCachedItems,
  getCacheFreshness,
  getCachePathLabel,
} from './unified-session-cache-helpers';
import {
  deleteSessionCache,
  readSessionCache,
} from './unified-session-cache-store';
import { runSessionCacheRefresh } from './unified-session-cache-refresh';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import { imageKeyIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { applyCacheDelivery } from './serve-decision-write';
import { getQuestionOptions, type DisplayOption } from '@/lib/question-bank';
import type { OptionCombination } from '@/lib/question-bank/types';
import { logExposures } from './unified-session-helpers';
import { meetsRequiredTier } from '@/lib/content-access';
import {
  MASTERY_CORRECT_THRESHOLD,
  resolveRetirementPolicy,
  retiredQuestionIds as computeRetiredQuestionIds,
} from '@/lib/knowledge/question-retirement';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

type CachedQuestionSource = {
  id: string;
  options: unknown;
  combinations?: unknown;
  correctVariants?: unknown;
};

/**
 * A queue row can outlive a video rights change. Filter those videos before
 * cache-delivery ServeDecision/exposure writes, then remove the stale row so
 * the next request recomputes it. Final API egress performs the same rights
 * check again before signing, which closes the race after this lookup.
 */
async function filterRightsStaleCachedVideos(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  const cachedVideos = items.filter((item) => item.type === 'video');
  if (cachedVideos.length === 0) return items;

  const videoIds = [...new Set(cachedVideos.flatMap((item) =>
    typeof item.id === 'string' && item.id.trim().length > 0 ? [item.id] : [],
  ))];
  let deliverableIds = new Set<string>();
  if (videoIds.length > 0) {
    try {
      const deliverable = await prisma.video.findMany({
        where: {
          id: { in: videoIds },
          published: true,
          rightsStatus: 'cleared',
        },
        select: { id: true, requiredTier: true },
      });
      deliverableIds = new Set(
        deliverable
          .filter((video) => meetsRequiredTier(ctx.commitmentLevel, video.requiredTier))
          .map((video) => video.id),
      );
    } catch (error) {
      logger.error('Cached video rights lookup failed; dropping cached videos', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        cachedVideoCount: cachedVideos.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const filtered = items.filter((item) =>
    item.type !== 'video'
      || (typeof item.id === 'string' && deliverableIds.has(item.id)),
  );
  const droppedVideoCount = items.length - filtered.length;
  if (droppedVideoCount === 0) return items;

  logger.warn('Dropped rights-stale videos before cached-session delivery', {
    userId: ctx.userId,
    rotation: ctx.rotation,
    cachedVideoCount: cachedVideos.length,
    droppedVideoCount,
  });
  try {
    await deleteSessionCache(ctx.userId, ctx.rotation);
  } catch (error) {
    logger.error('Failed to invalidate rights-stale video cache', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return filtered;
}

/**
 * Cache rows can survive a corpus-membership or routing change. Revalidate
 * every cached question against the current database policy before any
 * delivery/exposure write so a stale answer-bearing UnifiedItem cannot bypass
 * the opaque public-USMLE transport. Lookup failure is fail-closed for cached
 * questions; cards may still be served.
 */
async function filterRawPublicUsmleCachedQuestions(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  const questionIds = [...new Set(
    items
      .filter((item) => item.type === 'question')
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
  )];
  if (questionIds.length === 0) return items;

  let deliverableIds = new Set<string>();
  try {
    const deliverable = await prisma.question.findMany({
      where: withoutRawPublicUsmleQuestions({ id: { in: questionIds } }),
      select: { id: true },
    });
    deliverableIds = new Set(deliverable.map((question) => question.id));
  } catch (error) {
    logger.error('Cached question eligibility lookup failed; dropping cached questions', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      cachedQuestionCount: questionIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const filtered = items.filter(
    (item) => item.type !== 'question' || deliverableIds.has(item.id),
  );
  const droppedQuestionCount = items.length - filtered.length;
  if (droppedQuestionCount === 0) return items;

  logger.warn('Dropped ineligible questions before cached-session delivery', {
    userId: ctx.userId,
    rotation: ctx.rotation,
    cachedQuestionCount: questionIds.length,
    droppedQuestionCount,
  });
  try {
    await deleteSessionCache(ctx.userId, ctx.rotation);
  } catch (error) {
    logger.error('Failed to invalidate question-ineligible cache', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return filtered;
}

/**
 * A cached Card payload already contains its answer. Re-resolve reinforcement
 * lineage from the current database before any delivery bookkeeping so stale
 * primary or relationless fact siblings cannot survive a parent cross-list.
 */
async function filterRawPublicUsmleCachedReinforcementCards(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  const candidateCards = items.filter((item) => item.type === 'card');
  if (candidateCards.length === 0) return items;

  const deliverableCards = await filterDeliverableReinforcementCardRows(candidateCards, {
    logContext: { path: 'cache', userId: ctx.userId, rotation: ctx.rotation },
  });
  const deliverableIds = new Set(deliverableCards.map((card) => card.id));
  const filtered = items.filter(
    (item) => item.type !== 'card' || deliverableIds.has(item.id),
  );
  if (filtered.length === items.length) return items;

  try {
    await deleteSessionCache(ctx.userId, ctx.rotation);
  } catch (error) {
    logger.error('Failed to invalidate reinforcement-ineligible cache', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return filtered;
}

async function filterRecentlySeenCachedItems(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  const cardIds = items.filter((item) => item.type === 'card').map((item) => item.id);
  const questionIds = items.filter((item) => item.type === 'question').map((item) => item.id);
  if (cardIds.length === 0 && questionIds.length === 0) return items;

  const now = Date.now();
  const cardCutoff = new Date(now - 24 * 60 * 60 * 1000);
  const questionCutoff = new Date(now - 48 * 60 * 60 * 1000);
  const sourceIds = [...cardIds, ...questionIds];

  const [recentEvents, recentResponses, masteredQuestions] = await Promise.all([
    prisma.learningEvent.findMany({
      where: {
        userId: ctx.userId,
        sourceId: { in: sourceIds },
        sourceType: { in: ['card', 'question'] },
        eventType: { in: ['card_reviewed', 'mcq_attempted', 'content_exposed'] },
        timestamp: { gte: questionCutoff },
      },
      select: { sourceId: true, sourceType: true, timestamp: true },
    }),
    questionIds.length > 0
      ? prisma.questionResponse.findMany({
          where: {
            userId: ctx.userId,
            questionId: { in: questionIds },
            createdAt: { gte: questionCutoff },
          },
          select: { questionId: true },
          distinct: ['questionId'],
        })
      : Promise.resolve([]),
    questionIds.length > 0
      ? prisma.questionResponse.groupBy({
          by: ['questionId'],
          where: {
            userId: ctx.userId,
            questionId: { in: questionIds },
            isCorrect: true,
          },
          _count: { questionId: true },
          having: {
            questionId: { _count: { gte: MASTERY_CORRECT_THRESHOLD } },
          },
        })
      : Promise.resolve([]),
  ]);

  const excludedCardIds = new Set<string>();
  const excludedQuestionIds = new Set<string>();

  for (const event of recentEvents) {
    if (event.sourceType === 'card' && event.timestamp >= cardCutoff) {
      excludedCardIds.add(event.sourceId);
    }
    if (event.sourceType === 'question') {
      excludedQuestionIds.add(event.sourceId);
    }
  }
  for (const response of recentResponses) {
    excludedQuestionIds.add(response.questionId);
  }
  // Mastery no longer excludes at delivery. This is a DELIVERY filter over a queue
  // the scheduler already selected — if selection stops retiring but delivery keeps
  // filtering, a deliberately-chosen question silently vanishes from the queue. All
  // four paths must share one policy (question-retirement.ts) or they drift, which
  // they already had.
  for (const questionId of computeRetiredQuestionIds(
    masteredQuestions.map((r) => r.questionId),
    resolveRetirementPolicy()
  )) {
    excludedQuestionIds.add(questionId);
  }

  return items.filter((item) => {
    if (item.type === 'card') return !excludedCardIds.has(item.id);
    if (item.type === 'question') return !excludedQuestionIds.has(item.id);
    return true;
  });
}

/**
 * Resolve cached image keys before any delivery decision or exposure is
 * recorded. A diagnostic prompt is part of the question itself, so a viewer
 * who cannot resolve it must never receive (or be counted as receiving) that
 * question.
 */
async function resolveCachedItemImages(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  if (!items.some((item) => item.imageKey)) return items;

  const session = ctx.isGuest ? null : await auth();
  const resolvedItems = await Promise.all(
    items.map(async (item) => {
      const key = item.imageKey ?? null;
      if (!key) return item;

      const resolved = await resolveImage(key, session);
      if (item.type === 'question' && imageKeyIsPrompt(key) && !resolved) {
        return null;
      }

      return {
        ...item,
        imageUrl: resolved?.imageUrl ?? null,
        imageMeta: resolved?.imageMeta,
      } as UnifiedItem;
    }),
  );

  return resolvedItems.filter((item): item is UnifiedItem => item !== null);
}

async function refreshCachedQuestionOptions(
  ctx: SessionContext,
  items: UnifiedItem[],
): Promise<UnifiedItem[]> {
  const questionIds = items
    .filter((item) => item.type === 'question')
    .map((item) => item.id);
  if (questionIds.length === 0 || ctx.isGuest) return items;

  const staticQuestions = new Map<string, CachedQuestionSource>(
    (ctx.rotationContent.questionList ?? [])
      .filter((question) => questionIds.includes(question.id))
      .map((question) => [question.id, question as CachedQuestionSource]),
  );
  const missingQuestionIds = questionIds.filter((id) => !staticQuestions.has(id));
  const fallbackQuestions = missingQuestionIds.length > 0
    ? await prisma.question.findMany({
        where: withoutRawPublicUsmleQuestions({ id: { in: missingQuestionIds } }),
        select: {
          id: true,
          options: true,
          combinations: true,
          correctVariants: true,
        },
      })
    : [];

  const questionMap = new Map<string, CachedQuestionSource>([
    ...staticQuestions,
    ...fallbackQuestions.map((question) => [question.id, question as CachedQuestionSource] as const),
  ]);
  if (questionMap.size === 0) return items;

  const attemptCounts: Record<string, number> = {};
  const lastCorrectDisplayPositions: Record<string, number> = {};
  const [responses, recentPositions] = await Promise.all([
    prisma.questionResponse.groupBy({
      by: ['questionId'],
      where: {
        userId: ctx.userId,
        questionId: { in: questionIds },
      },
      _count: { id: true },
    }),
    prisma.questionResponse.findMany({
      where: {
        userId: ctx.userId,
        questionId: { in: questionIds },
        correctDisplayPosition: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        questionId: true,
        correctDisplayPosition: true,
      },
    }),
  ]);

  for (const response of responses) {
    attemptCounts[response.questionId] = response._count.id;
  }
  for (const response of recentPositions) {
    if (lastCorrectDisplayPositions[response.questionId] != null) continue;
    if (response.correctDisplayPosition == null) continue;
    lastCorrectDisplayPositions[response.questionId] = response.correctDisplayPosition;
  }

  return items.map((item) => {
    if (item.type !== 'question') return item;
    const question = questionMap.get(item.id);
    if (!question) return item;
    const displayOptions = getQuestionOptions(
      {
        id: question.id,
        options: (question.options as Array<{ text: string; isCorrect: boolean; explanation?: string }>) ?? [],
        combinations: (question.combinations as OptionCombination[]) ?? null,
        correctVariants: (question.correctVariants as string[]) ?? null,
      },
      attemptCounts[question.id] ?? 0,
      {
        avoidCorrectDisplayPosition: lastCorrectDisplayPositions[question.id] ?? null,
      },
    );
    return {
      ...item,
      options: displayOptions as DisplayOption[],
    };
  });
}

/**
 * Try to serve from session cache. Returns null if no usable cache exists
 * (falls through to instant/manifold).
 */
export async function tryCachedSession(ctx: SessionContext): Promise<NextResponse | null> {
  if (ctx.hasFilters || ctx.noCache || ctx.isGuest) return null;

  const tCacheStart = performance.now();
  try {
    const cacheRow = await readSessionCache(ctx.userId, ctx.rotation);

    if (cacheRow && Array.isArray(cacheRow.items) && cacheRow.items.length > 0) {
      const now = new Date();
      const { isFresh, isTooOld, ageMs } = getCacheFreshness(cacheRow.validUntil, now);

      if (isTooOld) {
        // Cache is ancient — delete it and fall through to fresh computation
        logger.warn('Session cache expired beyond max-age, discarding', {
          userId: ctx.userId, rotation: ctx.rotation, validUntil: cacheRow.validUntil.toISOString(),
          ageMs,
        });
        after(async () => {
          try {
            await deleteSessionCache(ctx.userId, ctx.rotation);
          } catch (err) {
            logger.error('Failed to delete stale cache', { userId: ctx.userId, rotation: ctx.rotation, error: String(err) });
          }
        });
        return null; // Fall through to fresh computation
      }

      const tCacheEnd = performance.now();
      const cacheTiming = [
        `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
        `cache;dur=${(tCacheEnd - tCacheStart).toFixed(1)}`,
        `total;dur=${(tCacheEnd - ctx.t0).toFixed(1)}`,
      ].join(', ');

      let cachedItems = cacheRow.items as UnifiedItem[];
      cachedItems = await filterRightsStaleCachedVideos(ctx, cachedItems);
      cachedItems = await filterRawPublicUsmleCachedQuestions(ctx, cachedItems);
      cachedItems = await filterRawPublicUsmleCachedReinforcementCards(ctx, cachedItems);

      // Filter out items the client already has (prefetch dedup)
      if (ctx.hasClientExclusions) {
        cachedItems = filterClientExcludedCachedItems(
          cachedItems,
          ctx.clientExcludeCardSet,
          ctx.clientExcludeQuestionSet,
        );
      }

      cachedItems = await filterRecentlySeenCachedItems(ctx, cachedItems);

      // Re-resolve signed URLs before delivery bookkeeping. Cached payloads
      // carry stable imageKey values, never reusable signed URLs. Filtering
      // inaccessible prompt questions here prevents phantom ServeDecisions and
      // content-exposure events for items that are not returned to the client.
      cachedItems = await resolveCachedItemImages(ctx, cachedItems);

      // If cache is empty after filtering, fall through to instant/manifold
      if (cachedItems.length === 0) {
        logger.info('unified-session cache hit but all items excluded', {
          userId: ctx.userId, rotation: ctx.rotation,
          excludedCards: ctx.clientExcludeCardSet.size,
          excludedQuestions: ctx.clientExcludeQuestionSet.size,
        });
        if (!isFresh) {
          after(async () => {
            await runSessionCacheRefresh(ctx, { recordOutcome: true, source: 'cache-empty' });
          });
        }
        return null; // Fall through to instant/manifold paths
      }

      logger.info('unified-session cache hit', {
        userId: ctx.userId, rotation: ctx.rotation, isFresh,
        items: cachedItems.length,
        cacheMs: +(tCacheEnd - tCacheStart).toFixed(1),
      });

      if (!isFresh) {
        after(async () => {
          await runSessionCacheRefresh(ctx, { recordOutcome: false, source: 'cache-stale' });
        });
      }

      const cachePath = getCachePathLabel(isFresh);
      logSessionDiagnostic(ctx, {
        path: cachePath,
        itemCount: cachedItems.length,
        totalMs: +(tCacheEnd - ctx.t0).toFixed(1),
        cacheState: isFresh ? 'hit' : 'stale',
        exclusionCounts: {
          clientCards: ctx.clientExcludeCardSet.size,
          clientQuestions: ctx.clientExcludeQuestionSet.size,
        },
      });

      // Phase 1.5/B: strip stale walk fields (from original caching session) and
      // re-enrich with current session ordering. clusterId is preserved because
      // it's a property of the card, not the serving session. Other walk fields
      // (positionInSession, similarityToPrior, predictedRecall, difficultyTier,
      // poolSize, old servedBy) are replaced.
      const freshItems = cachedItems.map((item) => {
        const rest = { ...(item as UnifiedItem & Record<string, unknown>) };
        delete rest.servedBy;
        delete rest.positionInSession;
        delete rest.similarityToPrior;
        delete rest.predictedRecall;
        delete rest.predictedRecallModel;
        delete rest.predictedRecallSource;
        delete rest.predictedRecallStatus;
        delete rest.difficultyTier;
        delete rest.poolSize;
        return {
          ...rest,
          servedBy: 'cached' as const,
          poolSize: cachedItems.length,
          predictedRecall: null,
          predictedRecallModel: null,
          predictedRecallSource: null,
          predictedRecallStatus: null,
          difficultyTier: null,
        } as UnifiedItem;
      });

      // similarityToPrior is intentionally unset on cache reads — coherence
      // metrics for cached sessions are computed at write time, not read time.
      const enrichedCached = enrichItemsWithWalkMetadata(freshItems);

      const taggedCachedItemsRaw = enrichedCached.map((item) => ({
        ...item,
        decisionContext: {
          servedBy: 'cached' as const,
          sessionType: 'review' as const,
          sessionId: ctx.sessionId,
          embeddingType: 'none' as const,
        },
      })) as UnifiedItem[];

      // Apply the cache-delivery rule per item:
      // - Same-session: UPDATE parent in place (deliveryPath='cached', position).
      // - Cross-session: INSERT child row with parentDecisionId, returning child.id.
      // - Parent missing: drop the stale id rather than carry an orphan into the
      //   response (would cause /record to update-by-id and miss the fallback path).
      const taggedCachedItemsWithFreshQuestions = await refreshCachedQuestionOptions(
        ctx,
        taggedCachedItemsRaw,
      );
      // Option refresh can perform a second database read (or consume a static
      // build artifact). Recheck current membership after that hydration and
      // before ServeDecision/exposure writes so a concurrent cross-list change
      // cannot reintroduce an answer-bearing public-USMLE row at final egress.
      const egressSafeCachedItems = await filterRawPublicUsmleCachedQuestions(
        ctx,
        taggedCachedItemsWithFreshQuestions,
      );
      if (egressSafeCachedItems.length === 0) {
        logger.info('unified-session cache emptied by final question revalidation', {
          userId: ctx.userId,
          rotation: ctx.rotation,
        });
        return null;
      }

      const taggedCachedItemsWithDecisions = await Promise.all(
        egressSafeCachedItems.map(async (item, index) => {
          if (!item.serveDecisionId) return item;
          const { serveDecisionId } = await applyCacheDelivery({
            serveDecisionId: item.serveDecisionId,
            currentSessionId: ctx.sessionId,
            currentPosition: index,
            userId: ctx.userId,
          });
          if (!serveDecisionId) {
            const rest = { ...item };
            delete rest.serveDecisionId;
            return rest as UnifiedItem;
          }
          return { ...item, serveDecisionId } as UnifiedItem;
        }),
      );
      logExposures(taggedCachedItemsWithDecisions, {
        userId: ctx.userId,
        rotation: ctx.rotation,
        queueType: 'cached',
        batchId: ctx.batchId,
        sessionId: ctx.sessionId,
        anonymousSessionId: ctx.anonymousSessionId,
        feedMode: ctx.feedMode,
      });

      return NextResponse.json(
        buildCacheResponsePayload(taggedCachedItemsWithDecisions, isFresh, ctx.sessionId, ctx.batchId),
        { headers: { 'Server-Timing': cacheTiming } },
      );
    }
  } catch (err) {
    logger.warn('Session cache read failed, computing fresh', { userId: ctx.userId, rotation: ctx.rotation, error: String(err) });
  }

  return null;
}
