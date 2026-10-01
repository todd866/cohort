/**
 * Per-invocation DB query counter.
 *
 * Why this exists: the scheduler (`constructUnifiedSession`) issues a growing
 * number of DB queries as new heuristics are layered on. Latency is already
 * logged (`schedulerMs`), but query *count* is the early-warning signal for
 * N+1 regressions and per-session cost creep — the scaling axis that bites
 * (cost = queries × sessions × users), not raw table size.
 *
 * Counting uses AsyncLocalStorage so a count is scoped to one logical
 * invocation and is NOT corrupted by concurrent requests sharing the same
 * Node instance (Fluid Compute reuses instances across concurrent requests).
 *
 * Wiring: `src/lib/prisma.ts` calls `incrementQueryCount()` from a Prisma
 * `$allOperations` extension, so every model op and raw query inside an active
 * `withQueryCounting(...)` scope is tallied. Outside a scope it's a no-op.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

interface QueryCountStore {
  count: number;
}

const storage = new AsyncLocalStorage<QueryCountStore>();

/**
 * Increment the query count for the currently active counting scope.
 * No-op (does not throw) when called outside `withQueryCounting`.
 */
export function incrementQueryCount(): void {
  const store = storage.getStore();
  if (store) store.count += 1;
}

/**
 * The live count for the active scope, or null if not inside one.
 * Exposed mainly for assertions/diagnostics.
 */
export function getActiveQueryCount(): number | null {
  return storage.getStore()?.count ?? null;
}

export interface TrackedResult<T> {
  result: T;
  queryCount: number;
  durationMs: number;
}

/**
 * Run `fn` inside a fresh counting scope. Returns the result plus the number
 * of queries issued and wall-clock duration. Nested scopes are independent —
 * an inner scope's increments do not bleed into the outer count.
 */
export async function withQueryCounting<T>(
  fn: () => Promise<T>
): Promise<TrackedResult<T>> {
  const store: QueryCountStore = { count: 0 };
  const start = performance.now();
  const result = await storage.run(store, fn);
  return {
    result,
    queryCount: store.count,
    durationMs: +(performance.now() - start).toFixed(1),
  };
}
