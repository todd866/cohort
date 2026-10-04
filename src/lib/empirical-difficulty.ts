/**
 * Empirical difficulty aggregation.
 *
 * For each Card with sufficient review history, compute:
 *   - facilityIndex: fraction of grades where quality >= 3 ("got it right")
 *   - avgResponseTimeMs: median across all CardProgress for this card
 *   - sampleSize: count of unique-user reviews
 *
 * The author-assigned `complexity` (C1/C2/C3) is a *prior*; this aggregation
 * is the *likelihood*. The combined posterior (computed at read time when
 * needed, e.g. by the scheduler or audit:complexity-calibration) tells us
 * whether an item is empirically easier or harder than the label suggests.
 *
 * Why not on-demand (per grade): Question already does this and it's a
 * write-amplification problem at scale — every grade serializes behind
 * an analytics update. A nightly batch decouples analytics from the hot
 * path and sees a full 30-day window for more stable estimates.
 *
 * Sample-size gate: items with < 10 unique-user reviews leave the columns
 * NULL. With small N the noise dominates the prior and we'd just be
 * trading author label for random sampling error.
 *
 * Coverage: includes only non-deleted, non-shelved Cards. We don't want
 * to maintain difficulty signals for cards no longer in rotation.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

/**
 * Minimum unique-user reviews before a card's empirical-difficulty fields
 * leave NULL. With 6 active users, MIN_SAMPLE_SIZE=10 would never update
 * anything; with MIN_SAMPLE_SIZE=2 we use any cross-user overlap signal
 * (two independent learners on the same card → N=2). Single-user-only history stays NULL
 * because individual difficulty isn't the same as content difficulty.
 *
 * Raise this once N ≥ 50 active users — at that point individual noise
 * dominates without a higher threshold.
 */
export const MIN_SAMPLE_SIZE = 2;

/**
 * All four counts come from the one statement that writes, so they read one snapshot and add up
 * exactly: cardsUpdated + cardsUnchanged + cardsBelowThreshold = cardsConsidered.
 */
export interface AggregationResult {
  /** Live cards with at least one graded CardProgress row. */
  cardsConsidered: number;
  /** Cards this run actually rewrote: at least one stored value changed. */
  cardsUpdated: number;
  /** Cards over the sample-size threshold that this run did not rewrite: their values already matched. */
  cardsUnchanged: number;
  /** Considered cards under the sample-size threshold (left as they are). */
  cardsBelowThreshold: number;
  durationMs: number;
  /**
   * Per-card snapshot of cards whose facility CHANGED in this run
   * (vs the previous stored value). Empty on first run; populated when
   * subsequent runs detect drift. Drives `audit/card-facility-history.jsonl`
   * so we can later answer "did this card get easier after the rewrite?"
   * — the question requires per-card trajectory, not just current state.
   */
  changedCards: Array<{
    cardId: string;
    facilityIndex: number;
    sampleSize: number;
    previousFacility: number | null;
    previousSampleSize: number | null;
  }>;
}

/**
 * Run a single batch of card empirical aggregation. Returns counts so the
 * cron route can log a summary line + decide whether to alert.
 *
 * The work is one SQL statement (via Prisma's $queryRaw) to avoid the
 * N+1 round-trip of querying each card individually — for ~6k cards that's
 * 6k DB calls vs one aggregate. The same statement returns the counts, so
 * they describe exactly the snapshot it wrote from.
 */
export async function aggregateCardEmpiricalDifficulty(): Promise<AggregationResult> {
  const startedAt = Date.now();

  // We could compute median in SQL via PERCENTILE_CONT, but the unique-user
  // counting + facility calc is cleaner expressed with a CTE. Postgres handles
  // it natively.
  //
  // Why we count "unique users who graded q≥3" rather than "fraction of all
  // grade events": if one user grades the same card 5 times (q=0,0,2,3,3),
  // they're 1 "got it right" eventually — the question we care about is "do
  // students end up getting this card?" not "how often does any specific
  // attempt succeed?"
  // RETURNING gives us the cards we just touched + their OLD values (via
  // the FROM ... per_card join's snapshot of pre-UPDATE state would be
  // wrong — UPDATE sees the original row, RETURNING gives the NEW row).
  // So we capture old values in a separate sub-query and join.
  //
  // Only rows whose stored values would change are written. Most cards'
  // aggregates do not move from one night to the next, and rewriting an
  // identical row still costs a new row version, WAL and index entries.
  // `target` casts each value to its column type first, so the guard compares
  // exactly what the SET would store (a facility like 2/3 is not exact in
  // binary, but the same numeric-to-double cast always yields the same double).
  //
  // The counts are taken in the same statement, from the same CTEs, so they
  // see the snapshot the UPDATE saw. `counts` always yields one row, and the
  // written cards LEFT JOIN onto it: with nothing written the result is that
  // one row, card columns NULL, and the counts still come back.
  const rows = await prisma.$queryRaw<Array<{
    considered: bigint;
    eligible: bigint;
    card_id: string | null;
    new_facility: number | null;
    new_sample: number | null;
    old_facility: number | null;
    old_sample: number | null;
  }>>`
    WITH per_card AS (
      SELECT
        cp."cardId" AS card_id,
        COUNT(DISTINCT cp."userId") AS sample_size,
        AVG(CASE WHEN cp."lastQuality" >= 3 THEN 1.0 ELSE 0.0 END) AS facility,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cp."avgResponseTimeMs") AS median_ms
      FROM "CardProgress" cp
      INNER JOIN "Card" c ON c.id = cp."cardId"
      WHERE c."deletedAt" IS NULL
        AND c."shelvedAt" IS NULL
        AND cp."lastQuality" IS NOT NULL
        AND cp."lastReview" IS NOT NULL
      GROUP BY cp."cardId"
    ),
    target AS (
      SELECT
        card_id,
        facility::double precision AS facility,
        CASE WHEN median_ms IS NULL THEN NULL ELSE median_ms::int END AS median_ms,
        sample_size::int AS sample_size
      FROM per_card
      WHERE sample_size >= ${MIN_SAMPLE_SIZE}
    ),
    old_state AS (
      SELECT c.id, c."facilityIndex" AS old_facility, c."sampleSize" AS old_sample
      FROM "Card" c
      INNER JOIN target t ON t.card_id = c.id
    ),
    updated AS (
      UPDATE "Card" c
      SET
        "facilityIndex" = t.facility,
        "avgResponseTimeMs" = t.median_ms,
        "sampleSize" = t.sample_size
      FROM target t
      WHERE c.id = t.card_id
        AND (c."facilityIndex", c."avgResponseTimeMs", c."sampleSize")
          IS DISTINCT FROM (t.facility, t.median_ms, t.sample_size)
      RETURNING c.id, c."facilityIndex" AS new_facility, c."sampleSize" AS new_sample
    ),
    counts AS (
      SELECT
        (SELECT COUNT(*) FROM per_card)::bigint AS considered,
        (SELECT COUNT(*) FROM target)::bigint AS eligible
    )
    SELECT
      counts.considered,
      counts.eligible,
      u.id AS card_id,
      u.new_facility,
      u.new_sample,
      o.old_facility,
      o.old_sample
    FROM counts
    LEFT JOIN updated u ON true
    LEFT JOIN old_state o ON o.id = u.id
  `;

  const totalConsidered = Number(rows[0]?.considered ?? 0n);
  // `target` is per_card at the UPDATE's own threshold, and every written card
  // is a target card, so eligible = written + unchanged with no clamping.
  const eligible = Number(rows[0]?.eligible ?? 0n);
  const result = rows.flatMap((row) => (
    row.card_id === null || row.new_facility === null || row.new_sample === null
      ? []
      : [{
          card_id: row.card_id,
          new_facility: row.new_facility,
          new_sample: row.new_sample,
          old_facility: row.old_facility,
          old_sample: row.old_sample,
        }]
  ));

  // Surface only cards whose facility actually CHANGED — keeps the
  // trajectory log lean. Threshold of 0.01 = ignore floating-point noise.
  const changedCards = result
    .filter((row) => {
      if (row.old_facility == null) return true; // first time seeing this card
      if (row.old_sample !== row.new_sample) return true; // sample size grew
      return Math.abs(row.new_facility - row.old_facility) >= 0.01;
    })
    .map((row) => ({
      cardId: row.card_id,
      facilityIndex: row.new_facility,
      sampleSize: row.new_sample,
      previousFacility: row.old_facility,
      previousSampleSize: row.old_sample,
    }));

  const durationMs = Date.now() - startedAt;
  const out: AggregationResult = {
    cardsConsidered: totalConsidered,
    cardsUpdated: result.length,
    cardsUnchanged: eligible - result.length,
    cardsBelowThreshold: totalConsidered - eligible,
    durationMs,
    changedCards,
  };

  logger.info('empirical-difficulty aggregation', {
    cardsConsidered: out.cardsConsidered,
    cardsUpdated: out.cardsUpdated,
    cardsUnchanged: out.cardsUnchanged,
    cardsBelowThreshold: out.cardsBelowThreshold,
    changedCount: out.changedCards.length,
    durationMs,
  });
  return out;
}
