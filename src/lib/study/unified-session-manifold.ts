import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { constructUnifiedSession } from '@/lib/knowledge/unified-scheduler';
import { ensureCardProgressExists } from '@/lib/stats';
import type { SessionContext } from './unified-session-types';
import { fetchGroupItems, interleaveGroups } from './unified-session-helpers';
import { breakModalityRuns } from '@/lib/knowledge/modality-guard';
import { readSessionCacheEpoch, upsertSessionCache } from './unified-session-cache-store';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import { loadManifoldExclusionState } from './unified-session-manifold-exclusions';
import {
  applyManifoldFilters,
  buildErrorFallbackItems,
  buildManifoldExposureEvents,
  collectAvailableFilters,
  collectItemComposition,
  ensureNonEmptyManifoldSession,
} from './unified-session-manifold-items';
import {
  hydrateScheduledItems,
  loadScheduledItemHydrationData,
} from './unified-session-hydration';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import {
  scoreOrderedPairwiseDistances,
  type EmbeddingItemTable,
  type EmbeddingItemIdColumn,
} from '@/lib/manifold/scoring';
import {
  buildServableCardWhere,
  buildServableQuestionWhere,
  loadServablePoolFilters,
  type ServablePoolFilters,
} from './servable-pool';
import { writeLiveServeDecisions } from './serve-decision-write';
import { appendDueBacklog } from './due-backlog';
import { appendRelearnLane } from './relearn';

/**
 * Count cards/questions in the user's primary rotation that they have never
 * seen, using the same filters the scheduler applies when serving items.
 * Used by feedMode='new-only' to power the "X new remaining" UI counter.
 *
 * Both where-clauses come from the shared servable-pool predicate so the
 * counter cannot drift from the scheduler — when the scheduler filters out
 * a card via getOpenIssueExclusions, this counter must filter it too.
 */
async function computeNewRemaining(
  ctx: SessionContext,
  poolFilters: ServablePoolFilters,
): Promise<{ cards: number; questions: number }> {
  const cardWhere = buildServableCardWhere({
    rotation: ctx.rotation,
    week: ctx.weekFilter,
    newOnlyForUserId: ctx.userId,
    openIssueCardIds: poolFilters.openIssueCardIds,
  });
  const questionWhere = buildServableQuestionWhere({
    rotation: ctx.rotation,
    week: ctx.weekFilter,
    newOnlyForUserId: ctx.userId,
    openIssueQuestionIds: poolFilters.openIssueQuestionIds,
    globallyExcludedQuestionIds: poolFilters.globallyExcludedQuestionIds,
    allowPrivateSources: poolFilters.allowPrivateSources,
  });

  const [cards, questions] = await Promise.all([
    prisma.card.count({ where: cardWhere }),
    prisma.question.count({ where: questionWhere }),
  ]);
  return { cards, questions };
}

/**
 * Full manifold/scheduler path. Queries recent exposures, runs the concept scheduler,
 * hydrates content, interleaves groups, applies filters, and returns the session.
 * This is the most complete (and slowest) path — used when cache misses and filters are active.
 */
export async function buildManifoldSession(ctx: SessionContext): Promise<NextResponse> {
  let newRemaining: { cards: number; questions: number } | undefined;
  let poolFilters: ServablePoolFilters | undefined;
  let cacheEpoch: number | null = null;
  try {
    if (!ctx.hasFilters && !ctx.noCache && !ctx.isGuest) {
      try {
        cacheEpoch = await readSessionCacheEpoch(ctx.userId);
      } catch (error) {
        // Cache coordination must never demote an otherwise healthy scheduler
        // request into the emergency fallback path. Skip this cache write.
        logger.warn('Failed to read session cache epoch; serving without cache write', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(error),
        });
      }
    }
    const tExposureStart = performance.now();
    const [exclusionState, loadedPoolFilters] = await Promise.all([
      loadManifoldExclusionState(ctx),
      loadServablePoolFilters(ctx.userId),
    ]);
    poolFilters = loadedPoolFilters;
    const tExposureEnd = performance.now();

    // Open-issue card IDs must be visible to both the scheduler (which
    // already unions them via its own getOpenIssueExclusions call) and the
    // rescue path (which only sees exclusionState.excludedCardIds). Union
    // them in once here so the rescue path matches the scheduler's pool.
    for (const id of poolFilters.openIssueCardIds) exclusionState.excludedCardIds.add(id);
    for (const id of poolFilters.openIssueQuestionIds) exclusionState.excludedQuestionIds.add(id);

    if (ctx.feedMode === 'new-only') {
      // Counter is best-effort. If counts fail we still serve items; we just
      // omit newRemaining from the response rather than lying with 0/0.
      try {
        newRemaining = await computeNewRemaining(ctx, poolFilters);
      } catch (counterError) {
        logger.warn('computeNewRemaining failed; continuing without newRemaining', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(counterError),
        });
      }
    }

    // Start group queries early — they only need rotation, weekFilter,
    // enabledGroupTypes, and excludedGroupIds (all available now).
    // Runs in parallel with the scheduler below.
    const groupQueryPromise = fetchGroupItems(
      ctx.rotation,
      ctx.weekFilter,
      exclusionState.enabledGroupTypes,
      exclusionState.excludedGroupIds,
    );

    const tSchedulerStart = performance.now();
    let sessionResult = await constructUnifiedSession(ctx.userId, {
      rotation: ctx.rotation,
      week: ctx.weekFilter ?? undefined,
      size: ctx.batchSize,
      ...(ctx.mode ? { mode: ctx.mode } : {}),
      excludeCardIds: [...exclusionState.excludedCardIds],
      excludeQuestionIds: [...exclusionState.excludedQuestionIds],
      recentTopicExposures: exclusionState.recentTopicExposures,
      commitmentLevel: ctx.commitmentLevel,
      imageTier: ctx.imageTier,
      // new-only is an explicit user opt-in to surface unseen content. The
      // scheduler's exam-pressure default would set maxNewCards=0 inside ~14
      // days of an exam, silently zeroing the candidate pool (seen cards are
      // already excluded by allTimeSeenCardIds). Override at the manifold
      // layer — the only layer that knows about feedMode.
      ...(ctx.feedMode === 'new-only' ? { maxNewCards: Number.POSITIVE_INFINITY } : {}),
    });
    const tSchedulerEnd = performance.now();

    // Relearn lane: re-serve cards the user failed earlier today (past a short
    // cooldown, under a daily view cap) so a lapse is followed by a real second
    // look this session — every other lane excludes them via the 24h recent-
    // exposure cutoff, so without this a failed card vanishes until tomorrow.
    // Leads the batch; trims concept overflow. Skipped for new-only.
    // Fail-safe: a lane-query hiccup must never collapse the whole session into
    // the error-fallback path — log and serve the un-augmented batch instead.
    if (ctx.feedMode !== 'new-only') {
      try {
        const withRelearn = await appendRelearnLane(prisma, sessionResult.items, {
          batchSize: ctx.batchSize,
          userId: ctx.userId,
          rotation: ctx.rotation,
          weekFilter: ctx.weekFilter,
          now: new Date(),
        });
        if (withRelearn !== sessionResult.items) {
          sessionResult = { ...sessionResult, items: withRelearn };
        }
      } catch (err) {
        logger.warn('relearn lane failed; serving without it', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(err),
        });
      }
    }

    // Due-backlog lane: the concept scheduler paces by exam-day recall, not by
    // per-card nextDueAt, so a heavy user's spaced-repetition backlog is never
    // drained — sessions end early with "you've reviewed all available cards"
    // while reviews pile up weeks overdue. When the concept pool under-fills the
    // batch, backfill the open slots with the most-overdue review cards. Skipped
    // for new-only (which must surface unseen content, never seen reviews).
    if (ctx.feedMode !== 'new-only') {
      try {
        const withBacklog = await appendDueBacklog(prisma, sessionResult.items, {
          batchSize: ctx.batchSize,
          userId: ctx.userId,
          rotation: ctx.rotation,
          weekFilter: ctx.weekFilter,
          excludedCardIds: exclusionState.excludedCardIds,
          now: new Date(),
        });
        if (withBacklog !== sessionResult.items) {
          sessionResult = { ...sessionResult, items: withBacklog };
        }
      } catch (err) {
        logger.warn('due-backlog lane failed; serving without it', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(err),
        });
      }
    }

    // For new-only sessions, empty really means empty — never resurface
    // cards via the static-rotation rescue path. The rescue pool can include
    // cards the user has already seen (if recent-exposure cutoffs miss them)
    // or cards that other policy gates would normally exclude.
    // Runs after the due-backlog lane: the backlog is the preferred source
    // (real overdue DB cards); the static rescue is only a last resort.
    if (ctx.feedMode !== 'new-only') {
      sessionResult = ensureNonEmptyManifoldSession(
        ctx,
        sessionResult,
        exclusionState.excludedCardIds,
      ) ?? sessionResult;
    }
    if (sessionResult.items.length === 0) {
      logger.info('unified-session-empty-pool', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        sessionId: ctx.sessionId,
        feedMode: ctx.feedMode ?? 'mixed',
        ...(newRemaining
          ? { newRemainingCards: newRemaining.cards, newRemainingQuestions: newRemaining.questions }
          : {}),
      });
      return NextResponse.json({
        items: [],
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
        ...(newRemaining ? { newRemaining } : {}),
      });
    }

    const tHydrationStart = performance.now();
    const hydrationData = await loadScheduledItemHydrationData({
      userId: ctx.userId,
      rotationContent: ctx.rotationContent,
      scheduledItems: sessionResult.items,
    });
    // Construct a minimal synthetic session for resolveImage trust check.
    const hydrateSession = ctx.isGuest
      ? null
      : ({ user: { id: ctx.userId, imageTier: ctx.imageTier } } as import('next-auth').Session);
    const baseItems = await hydrateScheduledItems(sessionResult.items, hydrationData, {
      rotation: ctx.rotation,
    }, hydrateSession);
    const tHydrationEnd = performance.now();

    // Await group queries (started before the scheduler for parallelism)
    const tGroupsStart = performance.now();
    const groupItems = await groupQueryPromise;
    const tGroupsEnd = performance.now();

    // interleaveGroups inserts a group item every `gap` positions in baseItems.
    // When groupItems share modality with the trailing baseItems (e.g. all cards),
    // the inserted item can extend a same-type run past the modality cap that
    // constructUnifiedSession had bounded. Re-apply the guard at this boundary
    // so the queue we hand to the user always honours the modality contract.
    const mergedItems = breakModalityRuns(interleaveGroups(baseItems, groupItems));
    const availableFilters = collectAvailableFilters(mergedItems);
    const preDedupItems = applyManifoldFilters(mergedItems, ctx);

    // Defensive in-session dedup: if any (type, id) repeats inside one response,
    // keep the first and warn. Upstream pipelines (interleaveGroups, the
    // scheduler, group hydration) all *should* produce unique items, but a
    // user-visible repeat in a single feed batch is the worst possible
    // experience for new-only mode, so guard it at the boundary.
    const filteredItems: typeof preDedupItems = [];
    const seenKeys = new Set<string>();
    let duplicates = 0;
    for (const item of preDedupItems) {
      const key = `${item.type}:${item.id}`;
      if (seenKeys.has(key)) { duplicates++; continue; }
      seenKeys.add(key);
      filteredItems.push(item);
    }
    if (duplicates > 0) {
      logger.warn('unified-session in-session dedup dropped duplicates', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        sessionId: ctx.sessionId,
        feedMode: ctx.feedMode ?? 'mixed',
        duplicatesDropped: duplicates,
        served: filteredItems.length,
      });
    }

    // Tag items with walk context, then enrich with position + similarity-to-prior.
    // poolSize is the post-interleave, pre-filter pool size — includes all items the
    // manifold assembled before user-applied UI filters reduce it. Used by Phase 2
    // to compute a pool-reduction ratio signal. Not the served count.
    const poolSize = mergedItems.length;

    // SQL-side similarityToPrior: send the ordered (id, table, column) tuples
    // to Postgres and receive Map<itemId, similarity>. No 3072-dim embeddings
    // cross the wire. See @/lib/manifold/scoring.ts.
    const orderedForPairwise = filteredItems.map((it) => {
      const table: EmbeddingItemTable =
        it.type === 'question' ? 'question_embeddings'
        : it.type === 'card' ? 'card_embeddings'
        : 'video_embeddings';
      const column: EmbeddingItemIdColumn =
        it.type === 'question' ? 'question_id'
        : it.type === 'card' ? 'card_id'
        : 'video_id';
      return { id: it.id, table, column };
    });
    const similarityToPriorMap = await scoreOrderedPairwiseDistances(orderedForPairwise);

    const walkTagged = filteredItems.map((it) => ({
      ...it,
      servedBy: 'manifold-walk' as const,
      clusterId: it.clusterId ?? null,
      poolSize,
      predictedRecall: it.predictedRecall ?? null,
      difficultyTier: it.difficultyTier ?? null,
    }));
    const enrichedItems = enrichItemsWithWalkMetadata(walkTagged, similarityToPriorMap);

    if (enrichedItems.length > 0) {
      const returnedCardIds = enrichedItems
        .filter((item) => item.type === 'card')
        .map((item) => item.id);

      if (returnedCardIds.length > 0) {
        after(async () => {
          try {
            await ensureCardProgressExists(ctx.userId, returnedCardIds);
          } catch (err) {
            logger.error('Failed to ensure card progress (manifold)', {
              userId: ctx.userId,
              cardCount: returnedCardIds.length,
              error: String(err),
            });
          }
        });
      }

      const exposureEvents = buildManifoldExposureEvents(enrichedItems, ctx);
      after(async () => {
        try {
          await prisma.learningEvent.createMany({ data: exposureEvents });
        } catch (err) {
          logger.error('Failed to log manifold queue exposures', {
            userId: ctx.userId,
            rotation: ctx.rotation,
            error: String(err),
          });
        }
      });
    }

    const tTotal = performance.now();
    const timing = [
      `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
      `exposure;dur=${(tExposureEnd - tExposureStart).toFixed(1)}`,
      `scheduler;dur=${(tSchedulerEnd - tSchedulerStart).toFixed(1)}`,
      `hydration;dur=${(tHydrationEnd - tHydrationStart).toFixed(1)}`,
      `groups;dur=${(tGroupsEnd - tGroupsStart).toFixed(1)}`,
      `total;dur=${(tTotal - ctx.t0).toFixed(1)}`,
    ].join(', ');

    logger.info('unified-session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      sessionId: ctx.sessionId,
      version: 'manifold',
      items: enrichedItems.length,
      // feedMode + remaining-pool counts so we can answer "is new-only being
      // used?" and "is the pool actually shrinking over a session?" via Vercel logs.
      feedMode: ctx.feedMode ?? 'mixed',
      ...(newRemaining
        ? { newRemainingCards: newRemaining.cards, newRemainingQuestions: newRemaining.questions }
        : {}),
      authMs: +(ctx.tAuthEnd - ctx.t0).toFixed(1),
      exposureMs: +(tExposureEnd - tExposureStart).toFixed(1),
      schedulerMs: +(tSchedulerEnd - tSchedulerStart).toFixed(1),
      hydrationMs: +(tHydrationEnd - tHydrationStart).toFixed(1),
      groupsMs: +(tGroupsEnd - tGroupsStart).toFixed(1),
      totalMs: +(tTotal - ctx.t0).toFixed(1),
    });

    logSessionDiagnostic(ctx, {
      path: 'manifold',
      itemCount: enrichedItems.length,
      totalMs: +(tTotal - ctx.t0).toFixed(1),
      exclusionCounts: {
        recentCards: exclusionState.excludedCardIds.size,
        recentQuestions: exclusionState.excludedQuestionIds.size,
        clientCards: ctx.clientExcludeCardSet.size,
        clientQuestions: ctx.clientExcludeQuestionSet.size,
      },
    });

    // Set both top-level servedBy (walk audit) and decisionContext (existing consumers).
    // Embeddings are no longer carried on items, so no stripping is needed.
    const itemsForResponse = enrichedItems.map((item) => ({
      ...item,
      decisionContext: {
        servedBy: 'manifold-walk' as const,
        sessionType: 'review' as const,
        sessionId: ctx.sessionId,
        embeddingType: 'concept-embedding' as const,
      },
    }));

    // Persist a ServeDecision row per served item (live path) and stamp each
    // item with its serveDecisionId. The helper is fail-safe — if the DB write
    // throws we get back the original items and the response shape is preserved.
    const itemsWithDecisions = await writeLiveServeDecisions(itemsForResponse, {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
      rotation: ctx.rotation,
      decisionPath: 'manifold-walk',
      queueReason: 'manifold-walk',
    });

    // Write session cache for next request (background, non-blocking).
    // Embeddings are no longer attached to items (similarityToPrior now comes
    // from SQL via scoreOrderedPairwiseDistances), so no stripping is needed.
    // Cache the items *with* serveDecisionIds so cache-served items can attribute
    // back to the original decision row.
    const cacheItems = itemsWithDecisions;
    if (!ctx.hasFilters && !ctx.noCache && !ctx.isGuest && cacheItems.length > 0 && cacheEpoch != null) {
      const expectedCacheEpoch = cacheEpoch;
      after(async () => {
        try {
          const written = await upsertSessionCache(
            ctx.userId,
            ctx.rotation,
            cacheItems,
            expectedCacheEpoch,
          );
          if (!written) {
            logger.info('Skipped stale manifold cache write after invalidation', {
              userId: ctx.userId,
              rotation: ctx.rotation,
            });
          }
        } catch (err) {
          logger.error('Failed to write session cache', {
            userId: ctx.userId,
            rotation: ctx.rotation,
            error: String(err),
          });
        }
      });
    }

    return NextResponse.json(
      {
        items: itemsWithDecisions,
        stats: {
          totalItems: itemsWithDecisions.length,
          version: 'manifold',
          composition: collectItemComposition(itemsWithDecisions),
          conceptStats: sessionResult.stats,
        },
        availableFilters,
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
        ...(newRemaining ? { newRemaining } : {}),
      },
      { headers: { 'Server-Timing': timing } },
    );
  } catch (error) {
    const totalMs = +(performance.now() - ctx.t0).toFixed(1);
    const errorDetail = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error('Error getting study session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      totalMs,
      error: errorDetail,
      stack: errorStack,
    });

    // New-only mode: do not fall back. The fallback path ignores all-time
    // exclusions and could surface seen items, breaking the new-only promise.
    if (ctx.feedMode === 'new-only') {
      return NextResponse.json({
        items: [],
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
        // Only emit newRemaining if we actually computed it. A 0/0 fallback
        // would tell the user "you're done" when really we just hit an error.
        ...(newRemaining ? { newRemaining } : {}),
      });
    }

    // Pass the open-issue card IDs (loaded before the exception, if we got that
    // far) so the error-fallback pool also drops flagged cards — matching the
    // EXCLUDED_POOL_TOPICS filter buildErrorFallbackItems now applies.
    const fallbackItems = buildErrorFallbackItems(ctx, new Set(poolFilters?.openIssueCardIds ?? []));
    if (fallbackItems.length > 0) {
      logger.warn('Serving fallback cards after manifold error', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        totalMs,
        items: fallbackItems.length,
        error: errorDetail,
      });
      logSessionDiagnostic(ctx, {
        path: 'fallback-error',
        itemCount: fallbackItems.length,
        totalMs,
        extra: { error: errorDetail.slice(0, 200) },
      });
      const taggedFallbackItems = fallbackItems.map((item) => ({
        ...item,
        decisionContext: {
          servedBy: 'manifold-walk' as const,
          sessionType: 'review' as const,
          sessionId: ctx.sessionId,
          embeddingType: 'concept-embedding' as const,
        },
      }));

      // Stamp serveDecisionId on fallback items too so /record can attribute.
      const taggedFallbackItemsWithDecisions = await writeLiveServeDecisions(
        taggedFallbackItems,
        {
          userId: ctx.userId,
          sessionId: ctx.sessionId,
          batchId: ctx.batchId,
          rotation: ctx.rotation,
          decisionPath: 'manifold-walk',
          queueReason: 'fallback-error',
        },
      );

      return NextResponse.json(
        {
          items: taggedFallbackItemsWithDecisions,
          stats: {
            totalItems: taggedFallbackItemsWithDecisions.length,
            version: 'fallback-error',
            composition: collectItemComposition(taggedFallbackItemsWithDecisions),
          },
          availableFilters: { types: [], difficulties: [], topics: [] },
          sessionId: ctx.sessionId,
          batchId: ctx.batchId,
        },
        {
          headers: {
            'Server-Timing': `total;dur=${totalMs},error;desc="${errorDetail.slice(0, 50)}"`,
          },
        },
      );
    }

    return NextResponse.json(
      { error: 'Failed to get session', detail: errorDetail },
      { status: 500 },
    );
  }
}
