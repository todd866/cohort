import { logger } from '@/lib/logger';
import { DEFAULT_BATCH_SIZE, type SessionContext } from './unified-session-types';
import { logCacheComputeOutcome } from './unified-session-diagnostics';
import { readSessionCacheSnapshot, upsertSessionCache } from './unified-session-cache-store';
import { computeAndHydrateSession } from './unified-session-cache-compute';
import { coordinateSessionBuild } from './unified-session-cache-refresh-lock';
import { queueRefreshScope } from './session-refresh-lease';

export type CacheRefreshContext = Pick<
  SessionContext,
  'userId' | 'rotation' | 'weekFilter' | 'batchSize' | 'rotationContent' | 'imageTier' | 'commitmentLevel'
> & Partial<Pick<SessionContext, 'noveltyProgress' | 'studyTimezone' | 'reviewChallenge'>>;

/**
 * Why a rebuild was asked for. `novelty-short` is the cache lane noticing a
 * queue built before first-sight seats existed while the learner still owes
 * first sights; it is served as-is and rebuilt here, off the request path.
 * `grade-drain` is the grade that took a queue below the drain floor
 * rebuilding it from its own request, in the background.
 */
export type SessionCacheRefreshSource =
  | 'cache-empty'
  | 'cache-stale'
  | 'instant'
  | 'cron-warm'
  | 'novelty-short'
  | 'grade-drain';

/**
 * A cached queue must hold enough to serve SEVERAL batches, not one.
 *
 * Both request-path callers pass the REQUEST's context straight through, so
 * before this floor existed an actively-studying user's small client batch
 * (~15) overwrote the 50-item queue the cron had just built. The effect was
 * backwards: the heaviest user ended up with the smallest buffer, lapsed the
 * cache soonest, and hit the expensive manifold rebuild most often, even with
 * plenty of due cards available.
 *
 * The floor lives HERE rather than at the call sites so every caller — both
 * request paths and the cron — cannot disagree about it.
 */
export const SESSION_QUEUE_TARGET_ITEMS = DEFAULT_BATCH_SIZE;

export type SessionCacheRefreshOutcome =
  | { status: 'success'; items: number; durationMs: number }
  /** Not written: the epoch moved while it ran (a grade or an invalidation). */
  | { status: 'stale'; items: number; durationMs: number }
  /** Not written: a queue built from a newer snapshot was already stored. */
  | { status: 'superseded'; items: number; durationMs: number }
  /** Not run: another instance holds this learner's refresh lease for the rotation. */
  | { status: 'deduped'; durationMs: number }
  | { status: 'empty'; items: 0; durationMs: number }
  | { status: 'error'; error: string; durationMs: number };

export interface SessionCacheRefreshOptions {
  recordOutcome: boolean;
  source: SessionCacheRefreshSource;
  /**
   * Lease lifetime: the function ceiling of the route this build runs in (a
   * request's background refresh runs in that request's after()). Omitted, it
   * is the shortest ceiling, SESSION_REFRESH_LEASE_TTL_MS.
   */
  leaseTtlMs?: number;
}

export async function runSessionCacheRefresh(
  ctx: CacheRefreshContext,
  options: SessionCacheRefreshOptions,
): Promise<SessionCacheRefreshOutcome> {
  const tStart = performance.now();
  return coordinateSessionBuild<SessionCacheRefreshOutcome>(
    {
      userId: ctx.userId,
      scope: queueRefreshScope(ctx.rotation),
      source: options.source,
      leaseTtlMs: options.leaseTtlMs,
    },
    {
      run: () => runSessionCacheRefreshUnlocked(ctx, options),
      // Recorded once per skipped attempt, whatever its trigger, so the share
      // of duplicate builds the lease absorbs can be counted before deciding
      // whether it earns its keep.
      deduped: async () => {
        const durationMs = +(performance.now() - tStart).toFixed(1);
        if (options.recordOutcome) {
          await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'deduped', {
            durationMs,
            source: options.source,
          });
        }
        return { status: 'deduped', durationMs };
      },
    },
  );
}

async function runSessionCacheRefreshUnlocked(
  ctx: CacheRefreshContext,
  options: SessionCacheRefreshOptions,
): Promise<SessionCacheRefreshOutcome> {
  const cacheBuildSessionId = `cache:${ctx.userId}:${ctx.rotation}:${new Date().toISOString()}`;
  const tBgStart = performance.now();
  try {
    // The epoch and the ordering token come from one statement, on the
    // database clock: a grade visible in this epoch is then always stamped
    // earlier than the token, and no instance's own clock decides the order.
    const snapshot = await readSessionCacheSnapshot(ctx.userId);
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
        reviewChallenge: snapshot.reviewChallenge,
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
      const write = await upsertSessionCache(ctx.userId, ctx.rotation, result.items, snapshot);
      if (write === 'superseded') {
        logger.info('Unified session cache refresh superseded by a newer queue', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          source: options.source,
          items: result.items.length,
          durationMs,
        });
        if (options.recordOutcome) {
          await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'superseded', {
            items: result.items.length,
            durationMs,
            source: options.source,
          });
        }
        return { status: 'superseded', items: result.items.length, durationMs };
      }
      if (write === 'stale') {
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
