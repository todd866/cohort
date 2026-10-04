/**
 * Single flight for background session builds: a study-queue rebuild or an
 * offline-pack build for one learner and one scope, in two layers.
 *
 * In process: concurrent callers for the same learner and scope share one
 * promise. Instant/cache-miss paths each schedule `runSessionCacheRefresh` in
 * `after()`. A remount during a cold start used to kick a second manifold
 * compute while the first was still holding Neon connections — live session
 * requests then tailed to 10–40s waiting on transaction start.
 *
 * Across instances: the first caller in a process claims the learner's
 * SessionRefreshLease for the scope (session-refresh-lease.ts). When another
 * instance holds it, the build is skipped and every caller gets the `deduped`
 * value. When the claim cannot run at all, the build goes ahead without it: the
 * epoch and snapshot-order checks at write time, not the lease, are what keep a
 * learner's queue correct.
 */

import { logger } from '@/lib/logger';
import { claimSessionRefreshLease, releaseSessionRefreshLease } from './session-refresh-lease';

export interface SessionBuildRequest {
  userId: string;
  /** queueRefreshScope(rotation), or OFFLINE_PACK_BUILD_SCOPE for a whole pack. */
  scope: string;
  /** What asked for the build: kept on the lease row and in the skip log. */
  source: string;
  /**
   * Lease lifetime: the function ceiling of the route this build runs in.
   * Defaults to the shortest (SESSION_REFRESH_LEASE_TTL_MS).
   */
  leaseTtlMs?: number;
  /**
   * Builds of one scope that cannot stand in for each other (an offline pack
   * of a different size) never share a promise in process. The lease scope is
   * the same, so the second is turned away rather than run twice.
   */
  variant?: string;
}

export interface SessionBuildHolder {
  holderSource: string | null;
  holderAgeMs: number | null;
}

const inflight = new Map<string, Promise<unknown>>();

function inflightKey(request: SessionBuildRequest): string {
  return `${request.userId}::${request.scope}::${request.variant ?? ''}`;
}

/**
 * Run `handlers.run` unless the same build is already under way, here or on
 * another instance. Same-process callers share the first caller's promise, so
 * a skipped build calls `handlers.deduped` once and everyone gets its value.
 */
export function coordinateSessionBuild<T>(
  request: SessionBuildRequest,
  handlers: {
    run: () => Promise<T>;
    deduped: (holder: SessionBuildHolder) => T | Promise<T>;
  },
): Promise<T> {
  const key = inflightKey(request);
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = runUnderLease(request, handlers).finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

async function runUnderLease<T>(
  request: SessionBuildRequest,
  handlers: {
    run: () => Promise<T>;
    deduped: (holder: SessionBuildHolder) => T | Promise<T>;
  },
): Promise<T> {
  const claim = await claimSessionRefreshLease(request.userId, request.scope, {
    source: request.source,
    ttlMs: request.leaseTtlMs,
  });

  if (claim.status === 'held') {
    const holder = { holderSource: claim.holderSource, holderAgeMs: claim.holderAgeMs };
    logger.info('Session build skipped: another instance holds the refresh lease', {
      userId: request.userId,
      scope: request.scope,
      source: request.source,
      ...holder,
    });
    return handlers.deduped(holder);
  }

  if (claim.status === 'unavailable') {
    logger.warn('Session refresh lease unavailable; building without it', {
      userId: request.userId,
      scope: request.scope,
      source: request.source,
      error: claim.error,
    });
  } else if (claim.tookOverExpired) {
    // The previous holder died or ran past its lease: worth seeing, because a
    // build that routinely overruns would mean the ttl is too short.
    logger.warn('Session refresh lease taken over after expiry', {
      userId: request.userId,
      scope: request.scope,
      source: request.source,
    });
  }

  try {
    return await handlers.run();
  } finally {
    if (claim.status === 'acquired') await releaseSessionRefreshLease(claim.lease);
  }
}

/** Test-only. */
export function clearSessionCacheRefreshLocksForTests(): void {
  inflight.clear();
}
