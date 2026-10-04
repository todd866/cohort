/**
 * Choosing whose session cache to rebuild ahead of them needing it.
 *
 * 2026-08-17: `db:seed` invalidated every session cache. With no cache, each
 * request fell through to a full live build — 33.7s and 385 queries for a
 * 116-concept rotation — which exceeded the function limit and was killed. The
 * background refresh that would have repopulated the cache runs INSIDE that
 * request, so it died with it, and the next request repeated the same doomed
 * build. The site was down until the limit was raised.
 *
 * The missing piece was a warm path that does not depend on a user request
 * surviving. Every other expensive job here has a cron; this one did not.
 *
 * Selection is deliberately conservative: a rebuild is expensive, the run has a
 * fixed budget, and warming a cache nobody will use wastes it. So candidates are
 * ranked by how recently the user actually studied, and only a queue that
 * cannot serve them is rebuilt.
 *
 * 2026-09-30: it was not conservative enough. Refreshing every queue of anyone
 * seen in the last 14 days, each hour, kept the budget saturated around the
 * clock: this cron made ~74% of the concept top-K scheduler passes, and those
 * passes were ~74% of all database time. The window for refreshing an existing
 * queue was cut to 3 hours.
 *
 * 2026-10-02: queues are now rebuilt by events, so this timer refreshes none
 * that can still serve. A session that opens on an expired queue is served it
 * (for up to 24 h past expiry) and rebuilds it behind the response; a grade
 * that leaves a queue below one batch rebuilds it from its own request; a
 * cross-instance lease stops those triggers duplicating each other. What is
 * left for the timer is a queue that cannot fill a batch: no row at all, a
 * row an invalidation emptied, or one drained below one batch whose grade-
 * driven rebuild was refused by a later grade (any grade landing while it runs
 * refuses it) and never retried because the learner stopped. Each would leave
 * the learner's next visit short or in the slow instant lane, so it is built
 * for anyone seen in the last 2 days.
 */

import { QUEUE_DRAIN_FLOOR_ITEMS } from './unified-session-types';

export interface WarmCandidate {
  userId: string;
  rotation: string;
  /** When their cache expires (or expired). Null when there is no cache row. */
  validUntil: Date | null;
  /**
   * How many items the stored queue holds. Zero is a row an invalidation
   * emptied, which serves nothing; fewer than QUEUE_DRAIN_FLOOR_ITEMS cannot
   * fill a batch. Null or absent means unknown and is treated as a queue that
   * can serve.
   */
  itemCount?: number | null;
  /** Their most recent delivered serve, used to rank who is actually active. */
  lastActiveAt: Date | null;
  /**
   * Guests can never read the session cache (tryCachedSession refuses
   * ctx.isGuest), so warming a guest queue spends budget on a row nobody can
   * be served. Guest traffic also outranks registered users on recency —
   * measured 2026-08-21: 38 of 53 candidates were guests.
   */
  isGuest: boolean;
  /**
   * The learner's enrolled rotations, canonicalised. Optional: when undefined
   * the candidate warms as before, so missing enrolment data degrades to the
   * old behaviour rather than silently halting every rebuild.
   */
  enrolledRotations?: readonly string[];
}

export interface WarmPlan {
  userId: string;
  rotation: string;
  /**
   * No queue row at all, a row an invalidation emptied, or a row drained
   * below one client batch.
   */
  reason: 'missing' | 'empty' | 'drained';
}

/** A queue that cannot fill a batch is built for learners active within this. */
export const WARM_MISSING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Users quiet for longer than this are never pre-warmed, so it is also how far
 * back the cron's activity scan reads.
 */
export const WARM_ACTIVE_WINDOW_MS = WARM_MISSING_WINDOW_MS;

/**
 * Pure selection: which caches to rebuild, most-recently-active user first.
 *
 * `budget` caps the number of rebuilds so a run cannot overrun its function
 * limit — each rebuild can take the better part of a minute.
 */
export function planCacheWarming(
  candidates: readonly WarmCandidate[],
  nowMs: number,
  budget: number,
): WarmPlan[] {
  const due: Array<{ plan: WarmPlan; lastActiveMs: number }> = [];

  for (const c of candidates) {
    if (c.isGuest) continue;
    // Serve history is not enrolment. A pre-enrolment default delivery mints
    // ServeDecisions for whatever rotation the anonymous chooser fell through
    // to, and warming from history alone pins that rotation for good.
    if (c.enrolledRotations && !c.enrolledRotations.includes(c.rotation)) continue;
    if (!c.lastActiveAt) continue;
    const lastActiveMs = c.lastActiveAt.getTime();
    if (nowMs - lastActiveMs > WARM_MISSING_WINDOW_MS) continue;

    // A queue that can fill a batch is the request path's to refresh, however
    // old it is.
    const reason: WarmPlan['reason'] | null = !c.validUntil
      ? 'missing'
      : c.itemCount === 0
        ? 'empty'
        : typeof c.itemCount === 'number' && c.itemCount < QUEUE_DRAIN_FLOOR_ITEMS ? 'drained' : null;
    if (!reason) continue;

    due.push({ plan: { userId: c.userId, rotation: c.rotation, reason }, lastActiveMs });
  }

  // Most recently active first: if the budget runs out, the people about to
  // open the app are the ones already warmed.
  due.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return due.slice(0, Math.max(0, budget)).map((d) => d.plan);
}
