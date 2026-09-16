import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { UnifiedItem, SessionContext } from './unified-session-types';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import {
  buildCacheResponsePayload,
  filterClientExcludedCachedItems,
  filterDuplicateCardVariantGroups,
  getCacheFreshness,
  getCachePathLabel,
} from './unified-session-cache-helpers';
import {
  deleteSessionCache,
  readSessionCache,
} from './unified-session-cache-store';
import { runSessionCacheRefresh } from './unified-session-cache-refresh';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import { questionImageIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { resolveImageAlternatives } from '@/lib/figures/resolve-alternatives';
import {
  applyCacheDelivery,
  loadSessionDeliveries,
  loadDeliveryParents,
} from './serve-decision-write';
import { getQuestionOptions, type DisplayOption } from '@/lib/question-bank';
import type { OptionCombination } from '@/lib/question-bank/types';
import {
  filterCardsAtDueEgress,
  logExposures,
} from './unified-session-helpers';
import { meetsRequiredTier } from '@/lib/content-access';
import {
  MASTERY_CORRECT_THRESHOLD,
  resolveRetirementPolicy,
  retiredQuestionIds as computeRetiredQuestionIds,
} from '@/lib/knowledge/question-retirement';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import {
  ownerPrivateOrSharedCardScope,
} from '@/lib/cards/read-repository.server';
import { breakModalityRuns } from '@/lib/knowledge/modality-guard';
import { isUsableQuestion } from '@/lib/question-validation';
import { loadCurrentSessionContent, sessionSourceKey as sourceKey, withCurrentSessionBody, type CurrentSessionSource } from './current-session-content';

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
    cardReadScope: ownerPrivateOrSharedCardScope(ctx.userId),
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

type CachedSourceFingerprints = Map<string, string>;
function sourceFingerprint(source: CurrentSessionSource): string {
  return JSON.stringify(source);
}

async function invalidateChangedCachedSources(
  ctx: SessionContext,
  reason: string,
  details: Record<string, unknown>,
): Promise<void> {
  logger.warn(reason, { userId: ctx.userId, rotation: ctx.rotation, ...details });
  try {
    await deleteSessionCache(ctx.userId, ctx.rotation);
  } catch (error) {
    logger.error('Failed to invalidate source-stale session cache', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Treat queue JSON as an untrusted hint. Current database rows provide the
 * authorization, routing, ownership and media contract. At final egress the
 * expected fingerprint closes races introduced by option/static hydration.
 */
async function revalidateCachedItemSources(
  ctx: SessionContext,
  items: UnifiedItem[],
  expectedFingerprints?: CachedSourceFingerprints,
): Promise<{ items: UnifiedItem[]; fingerprints: CachedSourceFingerprints; sources: Map<string, CurrentSessionSource> }> {
  const sources = await loadCurrentSessionContent(ctx, items);
  const fingerprints: CachedSourceFingerprints = new Map();
  let deniedCount = 0;
  let persistentDriftCount = 0;

  const patched = items.flatMap((item): UnifiedItem[] => {
    if (item.type !== 'question' && item.type !== 'card') return [item];
    const key = sourceKey(item.type, item.id);
    const source = sources.get(key);
    if (!source || (source.type === 'question' && !isUsableQuestion(source))) {
      deniedCount += 1;
      return [];
    }
    const fingerprint = sourceFingerprint(source);
    if (expectedFingerprints && expectedFingerprints.get(key) !== fingerprint) {
      deniedCount += 1;
      return [];
    }
    fingerprints.set(key, fingerprint);

    const currentImageKey = source.imageUrl ?? null;
    const currentCaption = source.imageCaption ?? null;
    const currentRole = source.imageRole ?? null;
    if (!expectedFingerprints && (
      item.rotation !== source.rotation
      || (item.week ?? null) !== (source.week ?? null)
      || (item.imageKey ?? null) !== currentImageKey
      || (item.imageCaption ?? null) !== currentCaption
      || (item.imageRole ?? null) !== currentRole
      || (source.type === 'card'
        && item.sourceComponent != null
        && item.sourceComponent !== source.sourceComponent)
    )) {
      persistentDriftCount += 1;
    }

    return [{
      ...withCurrentSessionBody(item, source),
      rotation: source.rotation,
      week: source.week,
      ...(source.type === 'card' ? { sourceComponent: source.sourceComponent } : {}),
      imageKey: currentImageKey,
      // Signed URLs and client metadata are deliberately ephemeral. Refreshing
      // them is not persistent cache drift and must not invalidate healthy rows.
      imageUrl: null,
      imageCaption: currentCaption,
      imageRole: currentRole,
      imageMeta: undefined,
    } as UnifiedItem];
  });

  if (deniedCount > 0 || persistentDriftCount > 0) {
    await invalidateChangedCachedSources(
      ctx,
      'Dropped or repaired source-stale cached study items',
      { deniedCount, persistentDriftCount, finalPass: Boolean(expectedFingerprints) },
    );
  }
  return { items: patched, fingerprints, sources };
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
  sources: Map<string, CurrentSessionSource>,
): Promise<UnifiedItem[]> {

  const trustOverride = ctx.imageTier === 'copyright'
    ? 'copyright-required' as const
    : 'auth-required' as const;
  const resolvedItems = await Promise.all(
    items.map(async (item) => {
      const key = item.imageKey ?? null;
      const source = item.type === 'card' || item.type === 'question'
        ? sources.get(sourceKey(item.type, item.id)) : undefined;

      const required = questionImageIsPrompt(item.imageRole, key);
      let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
      try {
        resolved = await resolveImage(key, null, trustOverride);
      } catch (error) {
        logger.warn('cache: image re-resolution failed', { itemId: item.id, error: String(error) });
      }
      if (required && !resolved) {
        return null;
      }

      return {
        ...item,
        imageUrl: resolved?.imageUrl ?? null,
        imageMeta: resolved?.imageMeta,
        imageKey: resolved?.imageKey ?? null,
        imageAlternatives: source
          ? await resolveImageAlternatives(source, source.imageUrl, null, trustOverride)
          : undefined,
      } as UnifiedItem;
    }),
  );

  return resolvedItems.filter((item): item is UnifiedItem => item !== null);
}

async function refreshCachedQuestionOptions(
  ctx: SessionContext,
  items: UnifiedItem[],
  sources: Map<string, CurrentSessionSource>,
): Promise<UnifiedItem[]> {
  const questionIds = items
    .filter((item) => item.type === 'question')
    .map((item) => item.id);
  if (questionIds.length === 0 || ctx.isGuest) return items;

  const questionMap = new Map<string, CachedQuestionSource>(questionIds.flatMap(id => {
    const source = sources.get(sourceKey('question', id));
    return source?.type === 'question' ? [[id, source] as const] : [];
  }));
  if (questionMap.size === 0) return [];

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
  if (
    ctx.hasFilters
    || ctx.noCache
    || ctx.isGuest
  ) return null;
  // Cross-source requests are NOT refused here. Refusing meant a user with
  // another source blended in could never read their own precomputed queue —
  // so warming it did nothing for them and every cache miss went to the full
  // manifold build, which cannot finish inside the function limit. Serving the
  // queue we have beats serving nothing; the background refresh keeps it
  // blended.


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

      let cachedItems = cacheRow.items as UnifiedItem[];
      cachedItems = await filterRightsStaleCachedVideos(ctx, cachedItems);
      const initialSourceValidation = await revalidateCachedItemSources(ctx, cachedItems);
      cachedItems = initialSourceValidation.items;
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
      const preVariantDedupeCount = cachedItems.length;
      cachedItems = filterDuplicateCardVariantGroups(cachedItems);
      const droppedSiblingCount = preVariantDedupeCount - cachedItems.length;
      if (droppedSiblingCount > 0) {
        logger.warn('Dropped cached card variant siblings before walk enrichment', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          droppedSiblingCount,
        });
      }

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


      // Phase 1.5/B: strip stale walk fields (from original caching session) and
      // re-enrich with current session ordering. clusterId is preserved because
      // it's a property of the card, not the serving session. Other walk fields
      // (positionInSession, similarityToPrior, predictedRecall, difficultyTier,
      // challenge/novelty policy context, poolSize, old servedBy) are replaced.
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
        delete rest.challengePolicyVersion;
        delete rest.challengeTargetTier;
        delete rest.challengeDistance;
        delete rest.challengePolicyApplied;
        delete rest.noveltyPolicyVersion;
        delete rest.recentNeighborSimilarity;
        delete rest.noveltyPenalty;
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
        initialSourceValidation.sources,
      );
      // UserStudyQueue is a serialized snapshot. Re-read current Question/Card
      // media before minting any URL, then resolve from that current key. This
      // covers legacy queue rows written before imageRole existed and clears
      // stale signed URLs before any ServeDecision/exposure bookkeeping.
      const finalSourceValidation = await revalidateCachedItemSources(
        ctx,
        taggedCachedItemsWithFreshQuestions,
        initialSourceValidation.fingerprints,
      );
      const cachedItemsForFinalChecks = finalSourceValidation.items;
      const [reinforcementSafeCachedItems, cachedCardDue] = await Promise.all([
        filterRawPublicUsmleCachedReinforcementCards(
          ctx,
          cachedItemsForFinalChecks,
        ),
        filterCardsAtDueEgress(cachedItemsForFinalChecks, {
          userId: ctx.userId,
          rotation: ctx.rotation,
          path: 'cache',
          isGuest: ctx.isGuest,
        }),
      ]);
      const imageResolvedCachedItems = await resolveCachedItemImages(
        ctx,
        reinforcementSafeCachedItems,
        finalSourceValidation.sources,
      );
      const egressSafeCachedItems = imageResolvedCachedItems.filter(
        (item) => item.type !== 'card' || cachedCardDue.eligibleCardIds.has(item.id),
      );
      // Invalidate on every card rejected by the due read, including one that
      // a concurrent reinforcement/media boundary also removed. Computing the
      // delta only after those filters let a parked row linger in the stored
      // queue and be reconsidered on every later hit.
      const notDueCardCount = cachedCardDue.droppedCardCount;
      if (notDueCardCount > 0) {
        logger.info('Dropped not-due cards before cached-session delivery', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          notDueCardCount,
        });
        after(async () => {
          try {
            await deleteSessionCache(ctx.userId, ctx.rotation);
          } catch (error) {
            logger.error('Failed to invalidate cache containing not-due cards', {
              userId: ctx.userId,
              rotation: ctx.rotation,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }
      if (egressSafeCachedItems.length === 0) {
        logger.info('unified-session cache emptied by final question revalidation', {
          userId: ctx.userId,
          rotation: ctx.rotation,
        });
        return null;
      }

      // Client exclusions, current-source checks, image gating and exact due
      // clocks can remove the separators that made the cached walk modality-
      // safe when it was built. Re-run the existing order-only guard at the
      // final egress boundary, once eligibility is settled. A one-sided queue
      // is intentionally left untouched because no valid separator exists.
      const hasCachedCard = egressSafeCachedItems.some((item) => item.type === 'card');
      const hasCachedQuestion = egressSafeCachedItems.some((item) => item.type === 'question');
      const modalityOrderedCachedItems = hasCachedCard && hasCachedQuestion
        ? breakModalityRuns(egressSafeCachedItems)
        : egressSafeCachedItems;
      // Even when only one modality survives, a final filter may have left
      // gaps in the positions assigned before media/due revalidation.
      const modalitySafeCachedItems = enrichItemsWithWalkMetadata(modalityOrderedCachedItems);

      // One query for the batch: which items has this session already been
      // delivered? Empty on a first attempt; populated when the client retried.
      // Two queries for the whole batch instead of two PER ITEM.
      const tValidationEnd = performance.now();
      const [deliveredInSession, parents] = await Promise.all([
        loadSessionDeliveries(ctx.userId, ctx.sessionId),
        loadDeliveryParents(
          modalitySafeCachedItems.map((item) => item.serveDecisionId).filter(Boolean) as string[],
        ),
      ]);
      const taggedCachedItemsWithDecisions = await Promise.all(
        modalitySafeCachedItems.map(async (item, index) => {
          if (!item.serveDecisionId) return item;
          const { serveDecisionId } = await applyCacheDelivery({
            serveDecisionId: item.serveDecisionId,
            currentSessionId: ctx.sessionId,
            currentPosition: index,
            userId: ctx.userId,
            deliveredInSession,
            parents: parents ?? undefined,
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
        cardDueAudit: cachedCardDue.audit,
      });

      const tResponse = performance.now();
      const totalMs = +(tResponse - ctx.t0).toFixed(1);
      const cacheTiming = [
        `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
        `identity;dur=${ctx.tIdentityMs.toFixed(1)}`,
        `contentmap;dur=${ctx.tContentMapMs.toFixed(1)}`,
        `cache;dur=${(tCacheEnd - tCacheStart).toFixed(1)}`,
        `validation;dur=${(tValidationEnd - tCacheEnd).toFixed(1)}`,
        `delivery;dur=${(tResponse - tValidationEnd).toFixed(1)}`,
        `total;dur=${totalMs.toFixed(1)}`,
      ].join(', ');
      logSessionDiagnostic(ctx, {
        path: cachePath,
        itemCount: taggedCachedItemsWithDecisions.length,
        totalMs,
        cacheState: isFresh ? 'hit' : 'stale',
        exclusionCounts: {
          clientCards: ctx.clientExcludeCardSet.size,
          clientQuestions: ctx.clientExcludeQuestionSet.size,
        },
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
