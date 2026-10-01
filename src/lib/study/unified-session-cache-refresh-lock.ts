/**
 * Coalesce concurrent background cache refreshes for the same user+rotation.
 *
 * Instant/cache-miss paths each schedule `runSessionCacheRefresh` in `after()`.
 * A remount during a cold start used to kick a second manifold compute while
 * the first was still holding Neon connections — live session requests then
 * tailed to 10–40s waiting on transaction start.
 */

const inflight = new Map<string, Promise<unknown>>();

function lockKey(userId: string, rotation: string): string {
  return `${userId}::${rotation}`;
}

export function beginSessionCacheRefresh<T>(
  userId: string,
  rotation: string,
  worker: () => Promise<T>,
): Promise<T> {
  const key = lockKey(userId, rotation);
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = worker().finally(() => {
    if (inflight.get(key) === pending) inflight.delete(key);
  });
  inflight.set(key, pending);
  return pending;
}

/** Test-only. */
export function clearSessionCacheRefreshLocksForTests(): void {
  inflight.clear();
}
