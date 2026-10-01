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
 * ranked by how recently the user actually studied, and only genuinely
 * cold-or-stale entries are rebuilt.
 *
 * 2026-09-30: it was not conservative enough. Refreshing every queue of anyone
 * seen in the last 14 days, each hour, kept the budget saturated around the
 * clock: this cron made ~74% of the concept top-K scheduler passes, and those
 * passes were ~74% of all database time. The request path already serves an
 * expired queue for up to 24 h and refreshes it in the background, so a queue
 * that exists is refreshed only for someone mid-session or just finished. Only
 * a queue that does not exist at all, which would leave the next visit to a
 * slow build, is still built for anyone seen in the last 2 days.
 */

export interface WarmCandidate {
  userId: string;
  rotation: string;
  /** When their cache expires (or expired). Null when there is no cache row. */
  validUntil: Date | null;
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
  reason: 'missing' | 'expired' | 'expiring-soon';
}

/**
 * How far ahead of expiry to rebuild. A cache that lapses between cron runs
 * would leave the next request to do the slow build, which is the failure this
 * exists to prevent.
 */
export const WARM_LEAD_MS = 20 * 60 * 1000;

/**
 * An existing queue (expired, or expiring within WARM_LEAD_MS) is refreshed
 * only for learners active within this. Anyone quieter meets the stale queue on
 * return, which the request path serves and refreshes in the background.
 */
export const WARM_REFRESH_WINDOW_MS = 3 * 60 * 60 * 1000;

/** A missing queue (no row at all) is built for learners active within this. */
export const WARM_MISSING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Users quiet for longer than this are never pre-warmed, so it is also how far
 * back the cron's activity scan reads.
 */
export const WARM_ACTIVE_WINDOW_MS = Math.max(WARM_REFRESH_WINDOW_MS, WARM_MISSING_WINDOW_MS);

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
    const quietMs = nowMs - lastActiveMs;

    let reason: WarmPlan['reason'] | null = null;
    if (!c.validUntil) {
      if (quietMs <= WARM_MISSING_WINDOW_MS) reason = 'missing';
    } else if (quietMs <= WARM_REFRESH_WINDOW_MS) {
      if (c.validUntil.getTime() <= nowMs) reason = 'expired';
      else if (c.validUntil.getTime() - nowMs <= WARM_LEAD_MS) reason = 'expiring-soon';
    }
    if (!reason) continue;

    due.push({ plan: { userId: c.userId, rotation: c.rotation, reason }, lastActiveMs });
  }

  // Most recently active first: if the budget runs out, the people about to
  // open the app are the ones already warmed.
  due.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return due.slice(0, Math.max(0, budget)).map((d) => d.plan);
}
