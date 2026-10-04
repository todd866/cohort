/**
 * Building a learner's study queue when no request is waiting for it: the
 * warm cron's builds of queues that cannot fill a batch, and the rebuild a
 * grade starts when it leaves a queue below the floor.
 *
 * Both start from the context the learner's own request would carry, minus
 * what only a request has. The warm cron used to pass the 'browser' commitment
 * level whatever the learner's, so a queue it built could differ from the one
 * the learner's next request would have built.
 * - Week filter: none. A background queue serves the whole rotation.
 * - First-sight progress: none. It needs the request's study timezone, and the
 *   reservation is deliberately kept to learners whose requests carry today's
 *   progress. For them the cache lane rebuilds such a queue once, with
 *   progress, the first time it serves it fresh (cachedQueueOwesNoveltyRebuild).
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { getCommitmentProfile } from '@/lib/commitment';
import { getRotationContent } from './rotation-content-map';
import {
  runSessionCacheRefresh,
  SESSION_QUEUE_TARGET_ITEMS,
  type CacheRefreshContext,
} from './unified-session-cache-refresh';

export async function loadBackgroundRefreshContext(
  userId: string,
  rotation: string,
): Promise<CacheRefreshContext> {
  const [user, commitmentLevel, rotationContent] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { imageTier: true } }),
    // The request path's fallback, so both agree when the profile is unreadable.
    getCommitmentProfile(userId)
      .then((profile) => profile.level)
      .catch(() => 'browser' as const),
    getRotationContent(rotation),
  ]);
  return {
    userId,
    rotation,
    weekFilter: null,
    batchSize: SESSION_QUEUE_TARGET_ITEMS,
    rotationContent,
    imageTier: user?.imageTier === 'copyright' ? 'copyright' : 'standard',
    commitmentLevel,
  };
}

/**
 * Rebuild the queues a grade just left below the floor, one at a time: each
 * build is already heavily parallel against the database.
 *
 * It runs in the grading request's after(), so that route's function ceiling
 * bounds it. `leaseTtlMs` must not exceed the ceiling, or a build the platform
 * stops would keep the learner's refresh lease, and every other refresh of
 * the queue would be turned away, until it expired.
 *
 * A grade landing while this runs moves the epoch and the result is refused,
 * as for any background build. That grade asks again if it leaves the queue
 * below the floor, and the lease makes the ask a no-op while a rebuild is
 * running, so one lands when the learner pauses. A queue left drained when the
 * learner stops is the warm cron's.
 */
export async function refreshDrainedQueues(
  userId: string,
  rotations: readonly string[],
  options: { leaseTtlMs: number },
): Promise<void> {
  for (const rotation of rotations) {
    try {
      const ctx = await loadBackgroundRefreshContext(userId, rotation);
      await runSessionCacheRefresh(ctx, {
        recordOutcome: true,
        source: 'grade-drain',
        leaseTtlMs: options.leaseTtlMs,
      });
    } catch (error) {
      logger.error('Drained queue refresh failed', {
        userId,
        rotation,
        error: String(error),
      });
    }
  }
}
