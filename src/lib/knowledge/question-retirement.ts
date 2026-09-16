/**
 * question-retirement — the single source of truth for question eligibility.
 *
 * WHAT THIS REPLACED
 * ------------------
 * Until 2026-07-16 md3 retired a question PERMANENTLY once a user had 2 lifetime
 * corrects (`groupBy questionId where isCorrect having _count >= 2` — no time
 * window). That rule was inlined in FOUR places, which had already drifted (two
 * queried lifetime-wide, two scoped to a candidate id list):
 *
 *   - knowledge/exclusion-data.ts                (selection: cache refresh)
 *   - study/unified-session-manifold-exclusions.ts (selection: live manifold)
 *   - study/unified-session-instant.ts           (delivery: static/guest fast path)
 *   - study/unified-session-cache.ts             (delivery: cached queue)
 *
 * Three things were wrong with it:
 *
 * 1. It contradicts md3's own model. docs/REVIEW_SYSTEM.md:11-13 — "Questions are
 *    *probes* (MCQs). They are **not individually 'scheduled'** via per-question SRS;
 *    instead we log attempts and use concept mastery to decide what to probe next."
 *    A permanent per-question kill-switch is exactly the per-question SRS that model
 *    says does not exist.
 * 2. Recognition could earn it. A student can pattern-match a repeat encounter to a
 *    2nd correct and permanently delete a question they never learned — and the
 *    evidence leaves with it. Measured 2026-07-16 (`npm run audit:familiarity`): 408
 *    questions retired after an accelerated repeat, including items the learner
 *    had not yet mastered. Mastery is therefore a ranking signal, not a deletion rule.
 * 3. Duplicated policy diverges. It already had.
 *
 * THE REPLACEMENT
 * ---------------
 * Mastery stops being an ELIGIBILITY concept and becomes a RANKING one:
 *
 *   - Nothing is permanently excluded. The existing recency cooldown and in-session
 *     dedup are untouched and still do their job.
 *   - Mastered questions SINK (freshnessTier) beneath never-seen and seen-unmastered
 *     candidates, so they only surface when nothing fresher exists. A rank penalty
 *     degrades gracefully where an exclusion starves: a rotation with 500 unseen
 *     questions never shows a mastered one; a rotation with 3 should.
 *   - Re-entry is CAPPED per session (takeWithReentryCap), so ~885 formerly-retired
 *     questions return as a maintenance tail rather than a mid-block flood.
 *
 * Deliberately NOT a "2 corrects at least N days apart" rule: spacing improves the
 * evidence but still asserts permanent mastery, which the architecture rejects. And
 * deliberately not "discount sub-5s corrects": that punishes genuine fluency and
 * hard-codes a confounded threshold into an eligibility decision. See
 * docs/superpowers/specs/2026-07-16-mcq-answer-rotation-design.md §Stage B.
 *
 * ROLLBACK: set MD3_PERMANENT_QUESTION_RETIREMENT=1 to restore the old behaviour
 * without a code change.
 */

/** Lifetime corrects at which a question counts as mastered (the legacy threshold). */
export const MASTERY_CORRECT_THRESHOLD = 2;

/** Per-user, per-question exposure state, derived from QuestionResponse. */
export interface QuestionFamiliarity {
  /** Epoch ms of this user's most recent delivered serve or answered attempt. */
  lastSeenAtMs: number;
  /** Lifetime correct count for this user on this question. */
  corrects: number;
}

export interface RetirementPolicy {
  /** Legacy kill-switch. Default false — see module header. */
  permanentRetirementEnabled: boolean;
  /** Max mastered questions allowed to re-enter a single session. */
  masteredReentryCapPerSession: number;
}

export function resolveRetirementPolicy(env: NodeJS.ProcessEnv = process.env): RetirementPolicy {
  const cap = Number(env.MD3_MASTERED_REENTRY_CAP ?? 1);
  return {
    permanentRetirementEnabled: env.MD3_PERMANENT_QUESTION_RETIREMENT === '1',
    masteredReentryCapPerSession: Number.isFinite(cap) && cap >= 0 ? cap : 1,
  };
}

/**
 * Which questions are excluded outright for being mastered.
 *
 * Under the live policy: NONE. Callers keep the call site so the legacy behaviour
 * stays one env var away, and so there is exactly one place this decision is made.
 */
export function retiredQuestionIds(
  masteredQuestionIds: Iterable<string>,
  policy: RetirementPolicy
): Set<string> {
  if (!policy.permanentRetirementEnabled) return new Set();
  return new Set(masteredQuestionIds);
}

/** 0 = never seen (best), 1 = seen but not mastered, 2 = mastered (sinks). */
export type FreshnessTier = 0 | 1 | 2;

export function freshnessTier(familiarity: QuestionFamiliarity | undefined): FreshnessTier {
  if (!familiarity) return 0;
  return familiarity.corrects >= MASTERY_CORRECT_THRESHOLD ? 2 : 1;
}

/**
 * Reorder candidates by freshness: never-seen, then seen-unmastered, then mastered;
 * least-recently-seen first within a tier.
 *
 * STABLE within a tier — upstream has already ordered these by (concept, question)
 * vector similarity, exam-target boost and bank preference. Freshness reorders ACROSS
 * tiers only; it must not discard that work.
 */
export function partitionByFreshness<T>(
  items: T[],
  getId: (item: T) => string,
  familiarity: Map<string, QuestionFamiliarity>
): T[] {
  if (items.length <= 1 || familiarity.size === 0) return items;

  const tiers: T[][] = [[], [], []];
  for (const item of items) tiers[freshnessTier(familiarity.get(getId(item)))].push(item);

  // Tier 0 is never-seen: no lastSeenAt to sort by, and upstream order is meaningful.
  for (const tier of [1, 2] as const) {
    tiers[tier] = tiers[tier]
      .map((item, i) => ({ item, i, seen: familiarity.get(getId(item))!.lastSeenAtMs }))
      // Least-recently-seen first; original index breaks ties so it stays stable.
      .sort((a, b) => a.seen - b.seen || a.i - b.i)
      .map((x) => x.item);
  }

  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

/** Mutable per-session counter, shared across per-concept calls. */
export interface ReentryCounter {
  masteredServed: number;
}

/** How many of these items are mastered — what a lane reports it actually served. */
export function countMastered<T>(
  items: T[],
  getId: (item: T) => string,
  familiarity: Map<string, QuestionFamiliarity>
): number {
  return items.filter((item) => freshnessTier(familiarity.get(getId(item))) === 2).length;
}

/**
 * Gate a candidate pool for a lane that has NO ranking stage.
 *
 * WHY THIS EXISTS (adversarial review, 2026-07-16)
 * -----------------------------------------------
 * The first cut of Stage B put freshness + the cap inside `getQuestionsFromBulk`
 * only. But three other lanes emit questions and never touch it:
 *   - unified-session-instant.ts   — `shuffle(pool).slice(0, n)`, uniform random.
 *     It runs on EVERY cache miss, and the cache is invalidated on EVERY grade
 *     (api/study/record/route.ts:81), so it is a hot path during active study —
 *     not the "guests and new users" path an earlier comment here claimed.
 *   - getQuestionsForRotation (topup + cluster) — `selectVariantAwareQuestions` is
 *     never-answered-first only WITHIN a variant group; solo questions are keyed
 *     `__single:${id}` (question-variants.ts:55) so that filter is vacuous for them,
 *     and the cross-group pick is `shuffle(selected)` (:97). It is NOT freshness-first.
 *   - the 8d orphan-question rescue loop.
 * With mastery no longer excluded upstream, each of those would draw mastered and
 * fresh questions with equal probability — the exact flood the cap exists to stop.
 *
 * THE CONTRACT
 * ------------
 * Keep every fresh/seen-unmastered candidate. Admit mastered ones ONLY when the
 * unmastered pool cannot fill `limit`, and never more than the session's remaining
 * budget. Does NOT mutate the counter: admission is not service, and a lane may
 * select fewer than it admits — burning budget here would leak it. The lane calls
 * `countMastered` on what it actually returns and increments then.
 */
export function admitMasteredWithinBudget<T>(
  candidates: T[],
  getId: (item: T) => string,
  familiarity: Map<string, QuestionFamiliarity>,
  limit: number,
  policy: RetirementPolicy,
  counter: ReentryCounter
): T[] {
  // Under the legacy flag, mastered ids were already excluded upstream; nothing to do.
  if (policy.permanentRetirementEnabled) return candidates;

  const unmastered: T[] = [];
  const mastered: T[] = [];
  for (const item of candidates) {
    (freshnessTier(familiarity.get(getId(item))) === 2 ? mastered : unmastered).push(item);
  }
  if (mastered.length === 0 || unmastered.length >= limit) return unmastered;

  const budget = Math.max(0, policy.masteredReentryCapPerSession - counter.masteredServed);
  const room = Math.min(budget, limit - unmastered.length);
  return room <= 0 ? unmastered : [...unmastered, ...mastered.slice(0, room)];
}

/**
 * Gate one candidate against the mastered re-entry cap.
 *
 * Returns true if it may be served. Only mastered candidates are capped, and the
 * counter only increments when one is actually admitted — a rejected candidate must
 * not consume budget.
 */
export function takeWithReentryCap(
  questionId: string,
  familiarity: Map<string, QuestionFamiliarity>,
  policy: RetirementPolicy,
  counter: ReentryCounter
): boolean {
  if (freshnessTier(familiarity.get(questionId)) !== 2) return true;
  if (counter.masteredServed >= policy.masteredReentryCapPerSession) return false;
  counter.masteredServed += 1;
  return true;
}
