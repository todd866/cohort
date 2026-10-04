/**
 * Per-isolate cache of the user-independent candidate data a scheduler pass
 * reads: a rotation's card and question metadata and its concept links
 * (docs/designs/2026-10-02-neon-scale.md). Videos are not cached: no trigger
 * watches their publish or rights state.
 *
 * Every pass used to read all of it again for every learner. The cached pools
 * are SUPERSETS: the caller still applies each learner's own filters (their
 * progress, their exclusions) in memory. The cache key carries every
 * learner-independent input of the shared query (image tier, private-source
 * access, rotation scope, locale), and owner-private cards are never cached.
 * A shared card cannot later become someone's private card: Card.ownerUserId
 * is immutable (trigger "Card_private_identity_immutable").
 *
 * Freshness, two ways:
 * - the epoch tag (the trigger-maintained change log behind the precomputed
 *   concept top-K) moves when any column the cached card or question queries
 *   filter on changes (a test in candidate-pool-invalidation.test.ts holds the
 *   triggers to those queries), so a warm isolate sees an eligibility change
 *   within the epoch memo's 30 s;
 * - a TTL bounds drift in what the triggers do not watch: ranking inputs
 *   (facilityIndex, examRelevance, similarCards) that change nightly or on
 *   seed, and the concept-link pools, which are safe to serve stale because
 *   every link is intersected downstream with freshly filtered items.
 *
 * Only the returned array is frozen. The row objects inside it, and their
 * nested arrays, are shared by every caller and are NOT frozen: a caller must
 * hand each learner copies, never the cached objects (bulk-candidates
 * structuredClones what it returns).
 */

export const CANDIDATE_POOL_TTL_MS = 10 * 60_000;
/** Across all pools in this isolate; the largest rotation is ~40k cards. */
export const CANDIDATE_POOL_MAX_ROWS = 150_000;

interface Entry {
  rows: readonly unknown[];
  loadedAt: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<readonly unknown[]>>();
let cachedRows = 0;

/** Test seam: forget every pool in this isolate. */
export function resetCandidatePoolCache(): void {
  entries.clear();
  inFlight.clear();
  cachedRows = 0;
}

function enabled(): boolean {
  return process.env.MD3_CANDIDATE_CACHE?.trim().toLowerCase() !== 'off';
}

function forget(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  cachedRows -= entry.rows.length;
  entries.delete(key);
}

function remember(key: string, rows: readonly unknown[], now: number): void {
  forget(key);
  if (rows.length > CANDIDATE_POOL_MAX_ROWS) return;
  while (cachedRows + rows.length > CANDIDATE_POOL_MAX_ROWS && entries.size > 0) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest);
  }
  entries.set(key, { rows, loadedAt: now });
  cachedRows += rows.length;
}

/**
 * The pool for (kind, key) under the current epoch tag, loading it at most
 * once per TTL. Concurrent callers share one load; a failed load is not
 * cached.
 */
export async function cachedCandidatePool<T>(
  kind: string,
  key: string,
  epochTag: string,
  load: () => Promise<T[]>,
): Promise<readonly T[]> {
  if (!enabled()) return load();
  const fullKey = `${kind}\u0000${key}\u0000${epochTag}`;
  const now = Date.now();
  const hit = entries.get(fullKey);
  if (hit && now - hit.loadedAt <= CANDIDATE_POOL_TTL_MS) {
    // Re-insert so eviction drops the least recently used pool first.
    entries.delete(fullKey);
    entries.set(fullKey, hit);
    return hit.rows as readonly T[];
  }
  const pending = inFlight.get(fullKey);
  if (pending) return pending as Promise<readonly T[]>;
  const loading = (async () => {
    try {
      const rows = Object.freeze(await load()) as readonly T[];
      remember(fullKey, rows, Date.now());
      return rows;
    } finally {
      inFlight.delete(fullKey);
    }
  })();
  inFlight.set(fullKey, loading);
  return loading;
}
