import { logger } from '@/lib/logger';
import type { SessionContext } from './unified-session-types';
import { logCacheComputeOutcome } from './unified-session-diagnostics';
import { readSessionCacheEpoch, upsertSessionCache } from './unified-session-cache-store';
import { computeAndHydrateSession } from './unified-session-cache-compute';

type CacheRefreshContext = Pick<
  SessionContext,
  'userId' | 'rotation' | 'weekFilter' | 'batchSize' | 'rotationContent' | 'imageTier' | 'commitmentLevel'
>;

export async function runSessionCacheRefresh(
  ctx: CacheRefreshContext,
  options: {
    recordOutcome: boolean;
    source: 'cache-empty' | 'cache-stale' | 'instant';
  },
): Promise<void> {
  const cacheBuildSessionId = `cache:${ctx.userId}:${ctx.rotation}:${new Date().toISOString()}`;
  const tBgStart = performance.now();
  try {
    const cacheEpoch = await readSessionCacheEpoch(ctx.userId);
    const result = await computeAndHydrateSession(
      ctx.userId,
      ctx.rotation,
      ctx.weekFilter,
      ctx.batchSize,
      ctx.rotationContent,
      ctx.imageTier,
      ctx.commitmentLevel,
      cacheBuildSessionId,
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
          });
        }
        return;
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
        });
      }
      return;
    }

    logger.warn('Unified session cache refresh returned empty session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      source: options.source,
      durationMs,
    });
    if (options.recordOutcome) {
      await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'empty', { durationMs });
    }
  } catch (err) {
    const durationMs = +(performance.now() - tBgStart).toFixed(1);
    logger.error('Unified session cache refresh failed', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      source: options.source,
      error: String(err),
      durationMs,
    });
    if (options.recordOutcome) {
      await logCacheComputeOutcome(ctx.userId, ctx.rotation, 'error', {
        durationMs,
        error: String(err),
      });
    }
  }
}
