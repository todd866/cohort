import { logger } from '@/lib/logger';
import { DEFAULT_BATCH_SIZE, type SessionContext } from './unified-session-types';
import { logCacheComputeOutcome } from './unified-session-diagnostics';
import { readSessionCacheEpoch, upsertSessionCache } from './unified-session-cache-store';
import { computeAndHydrateSession } from './unified-session-cache-compute';
import { beginSessionCacheRefresh } from './unified-session-cache-refresh-lock';

type CacheRefreshContext = Pick<
  SessionContext,
  'userId' | 'rotation' | 'weekFilter' | 'batchSize' | 'rotationContent' | 'imageTier' | 'commitmentLevel'
> & Partial<Pick<SessionContext, 'noveltyProgress' | 'studyTimezone'>>;

/**
 * Why a rebuild was asked for. `novelty-short` is the cache lane noticing a
 * queue built before first-sight seats existed while the learner still owes
 * first sights; it is served as-is and rebuilt here, off the request path.
 */
export type SessionCacheRefreshSource =
  | 'cache-empty'
  | 'cache-stale'
  | 'instant'
  | 'cron-warm'
  | 'novelty-short';

/**
 * A cached queue must hold enough to serve SEVERAL batches, not one.
 *
 * Both request-path callers pass the REQUEST's context straight through, so
 * before this floor existed an actively-studying user's small client batch
 * (~15) overwrote the 50-item queue the cron had just built. The effect was
 * backwards: the heaviest user ended up with the smallest buffer, lapsed the
 * cache soonest, and hit the expensive manifold rebuild most often. Measured
 * 2026-08-17: the most active user's queue held 15 items while an inactive
 * user's held 63, with a full 50 due cards available to either.
 *
 * The floor lives HERE rather than at the call sites so every caller — both
 * request paths and the cron — cannot disagree about it.
 */
export const SESSION_QUEUE_TARGET_ITEMS = DEFAULT_BATCH_SIZE;

export type SessionCacheRefreshOutcome =
  | { status: 'success'; items: number; durationMs: number }
  | { status: 'stale'; items: number; durationMs: number }
  | { status: 'empty'; items: 0; durationMs: number }
  | { status: 'error'; error: string; durationMs: number };

export async function runSessionCacheRefresh(
  ctx: CacheRefreshContext,
  options: {
    recordOutcome: boolean;
    source: SessionCacheRefreshSource;
  },
): Promise<SessionCacheRefreshOutcome> {
  return beginSessionCacheRefresh(ctx.userId, ctx.rotation, () =>
    runSessionCacheRefreshUnlocked(ctx, options),
  );
}

async function runSessionCacheRefreshUnlocked(
  ctx: CacheRefreshContext,
  options: {
    recordOutcome: boolean;
    source: SessionCacheRefreshSource;
  },
): Promise<SessionCacheRefreshOutcome> {
  const cacheBuildSessionId = `cache:${ctx.userId}:${ctx.rotation}:${new Date().toISOString()}`;
  const tBgStart = performance.now();
  try {
    const cacheEpoch = await readSessionCacheEpoch(ctx.userId);
    const result = await computeAndHydrateSession(
      ctx.userId,
      ctx.rotation,
      ctx.weekFilter,
      // Floor, not a cap: a caller asking for more than the target still gets it.
      Math.max(ctx.batchSize, SESSION_QUEUE_TARGET_ITEMS),
      ctx.rotationContent,
      ctx.imageTier,
      ctx.commitmentLevel,
      cacheBuildSessionId,
      {
        includeFailureAttribution: true,
        // Reserve first-sight seats only for a request that already carries
        // today's progress: the learners the live build reserved them for.
        // Opting every cron build in would hand about two thirds of every
        // learner's queue to unseen cards and slow due-backlog clearance,
        // a policy change for learners who never had the reservation.
        ...(ctx.noveltyProgress
          ? {
              novelty: {
                progress: ctx.noveltyProgress,
                studyTimezone: ctx.studyTimezone ?? null,
              },
            }
          : {}),
      },
    );
    const durationMs = +(performance.now() - tBgStart).toFixed(1);

    if (result.items.length > 0) {
      const written = await upsertSessionCache(ctx.userId, ctx.rotation, result.items, cacheEpoch);
      if (!written) {
        logger.info('Unified session cache refresh discarded after invalidation', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          source: options.source,
          items: result.items.length,
          durationMs,
        });
        if (options.recordOutcome) {
          await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'stale', {
            items: result.items.length,
            durationMs,
            source: options.source,
          });
        }
        return { status: 'stale', items: result.items.length, durationMs };
      }
      logger.info('Unified session cache refresh completed', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        source: options.source,
        items: result.items.length,
        durationMs,
      });
      if (options.recordOutcome) {
        await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'success', {
          items: result.items.length,
          durationMs,
          source: options.source,
        });
      }
      return { status: 'success', items: result.items.length, durationMs };
    }

    logger.warn('Unified session cache refresh returned empty session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      source: options.source,
      durationMs,
    });
    if (options.recordOutcome) {
      await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'empty', {
        durationMs,
        source: options.source,
      });
    }
    return { status: 'empty', items: 0, durationMs };
  } catch (err) {
    const durationMs = +(performance.now() - tBgStart).toFixed(1);
    const error = String(err);
    logger.error('Unified session cache refresh failed', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      source: options.source,
      error,
      durationMs,
    });
    if (options.recordOutcome) {
      await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'error', {
        durationMs,
        error,
        source: options.source,
      });
    }
    return { status: 'error', error, durationMs };
  }
}
