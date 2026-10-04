/**
 * ServeDecision retention, in two passes.
 *
 * ServeDecision is append-only — one row per item a scheduler pass selects,
 * per user. Left unbounded it becomes the fastest-growing table as users
 * scale. Both passes delete in bounded batches so the daily job never takes a
 * long lock or a giant single transaction.
 *
 * 1. Every row older than 180 days (`pruneServeDecisions`). The window is
 *    chosen to outlast a full study block plus its post-exam analysis: a
 *    clinical block runs ~6 weeks of study into an exam, and the exam-vs-usage
 *    analyses happen weeks-to-months later. At 90 days the run-up scheduler
 *    context was pruned before that analysis could use it; 180 days keeps a
 *    block's rich serve history available through the next-block window, and
 *    matches the longest window an audit reads (concept follow-up, 180 days at
 *    most). Rows are small metadata, so the cost of the wider window stays
 *    bounded by the batch/cap machinery as usage scales.
 *    Tunable via SERVE_DECISION_RETENTION_DAYS (default 180).
 *
 * 2. Rows nothing ever delivered, after 14 days
 *    (`pruneUndeliveredServeDecisions`). A cache build writes a row for every
 *    item it queues, with deliveryPath null, and most queued items are never
 *    served. The rule is the complement of the partial index the scheduler's
 *    history reads use (deliveryPath or exposedAt set), narrowed further: the
 *    row must also be unanswered, and no delivered child may point at it,
 *    because audits read that parent for when the scheduler chose the item.
 *    The only live reads that depend on an undelivered row are cached
 *    delivery's lookups of a queue item's parent by id, while the queue is
 *    servable (about 25 hours, below), so the window never drops below 2 days.
 *    Tunable via SERVE_DECISION_UNDELIVERED_RETENTION_DAYS (default 14).
 *
 *    The child check takes no lock, and needs none. NOT EXISTS is evaluated in
 *    the batch statement's snapshot, and parentDecisionId carries no foreign
 *    key, so a child inserted while a batch runs would be invisible to it and
 *    its parent could be deleted under it. No row old enough to prune can gain
 *    a child, though:
 *    - A child is inserted only by cached delivery (applyCacheDelivery), when
 *      the cache lane serves a queued item to a session other than the build's.
 *    - The lane serves a queue only until CACHE_STALE_SERVE_MAX_MS (24 h) past
 *      its validUntil. A build's write sets validUntil SESSION_CACHE_TTL_MS
 *      (1 h) ahead, and nothing moves it later: a grade only expires a queue
 *      earlier (session-cache-drain.integration.test.ts).
 *    - That build inserted its parent rows before the write, within one
 *      function's lifetime, and the delivering request runs within another.
 *    So a parent gains a child only while younger than about 25 hours plus two
 *    function lifetimes, and the 2-day floor keeps every such parent out of the
 *    prune. A test pins the floor above that bound using these constants. The
 *    other ids a queue can hold are delivered rows (the manifold lane caches
 *    its live rows; a pending-question resume reuses a delivered row), which
 *    the rule never deletes, and offline-pack ids, which name no row.
 *
 * Driven by /api/cron/serve-decision-retention. A backlog larger than one
 * run's cap belongs to scripts/ops/prune-undelivered-serve-decisions.mjs,
 * which runs the same statement with pauses and load checks.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION_DAYS_DEFAULT = 180;
const BATCH_SIZE_DEFAULT = 5000;
const MAX_BATCHES_DEFAULT = 200; // safety cap: ≤ 1M rows/run at default batch size

export const UNDELIVERED_RETENTION_DAYS_DEFAULT = 14;
/**
 * Above the oldest a parent can be when it gains a child (about 25 hours plus
 * two function lifetimes; see the header), so the batch snapshot's child check
 * never races a delivery. serve-decision-retention.test.ts pins it there.
 */
export const UNDELIVERED_RETENTION_DAYS_FLOOR = 2;
export const UNDELIVERED_BATCH_SIZE_DEFAULT = 2000;
// Bounds one nightly run. A backlog is the operator script's job, not the cron's.
const UNDELIVERED_MAX_BATCHES_DEFAULT = 50;

/**
 * The undelivered rule. $1 is the cutoff; $2 is a lower bound on decidedAt,
 * advanced to each batch's last deleted row so a run never re-walks the dead
 * index entries its earlier batches left behind.
 */
const UNDELIVERED_RULE = `d."deliveryPath" IS NULL
      AND d."exposedAt" IS NULL
      AND d."answeredAt" IS NULL
      AND d."decidedAt" < $1
      AND d."decidedAt" >= $2
      AND NOT EXISTS (SELECT 1 FROM "ServeDecision" c WHERE c."parentDecisionId" = d.id)`;

/**
 * One batch, oldest first ($3 rows at most). The null checks are repeated on
 * the row being deleted: a row delivered or answered after the subquery chose
 * it is then skipped, not deleted. The child check is not repeated and need not
 * be: past the floor, no row can gain a child (see the header). Returns the
 * count and the last decidedAt.
 *
 * scripts/ops/prune-undelivered-serve-decisions-lib.mjs carries a copy (a
 * plain-node script cannot import this file); a test fails if they differ.
 */
export const UNDELIVERED_PRUNE_BATCH_SQL = `WITH deleted AS (
  DELETE FROM "ServeDecision" t
  WHERE t.id IN (
    SELECT d.id
    FROM "ServeDecision" d
    WHERE ${UNDELIVERED_RULE}
    ORDER BY d."decidedAt"
    LIMIT $3
  )
    AND t."deliveryPath" IS NULL
    AND t."exposedAt" IS NULL
    AND t."answeredAt" IS NULL
  RETURNING t."decidedAt"
)
SELECT count(*)::int AS deleted, max("decidedAt") AS "lastDecidedAt" FROM deleted`;

/** Whether any eligible row is left at or after the lower bound. Never a count. */
export const UNDELIVERED_REMAINING_SQL = `SELECT 1 AS remaining
FROM "ServeDecision" d
WHERE ${UNDELIVERED_RULE}
LIMIT 1`;

/** Minimal slice of the Prisma client this function needs (keeps it testable). */
interface ServeDecisionDelegate {
  serveDecision: {
    findMany(args: {
      where: { decidedAt: { lt: Date } };
      select: { id: true };
      orderBy: { decidedAt: 'asc' };
      take: number;
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
}

export interface PruneOptions {
  /** Rows older than this many days are deleted. Must be > 0. */
  retentionDays?: number;
  /** Rows deleted per batch. */
  batchSize?: number;
  /** Hard cap on batches per run (defence against a runaway loop). */
  maxBatches?: number;
}

export interface PruneResult {
  deleted: number;
  batches: number;
  cutoff: Date;
  /** True if maxBatches was hit before the backlog was cleared. */
  cappedOut: boolean;
  retentionDays: number;
}

export async function pruneServeDecisions(
  client: ServeDecisionDelegate,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const retentionDays = options.retentionDays ?? RETENTION_DAYS_DEFAULT;
  const batchSize = options.batchSize ?? BATCH_SIZE_DEFAULT;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_DEFAULT;

  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    // A zero/negative window would delete the entire table. Refuse loudly.
    throw new Error(`pruneServeDecisions: retentionDays must be > 0 (got ${retentionDays})`);
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let batches = 0;
  let cappedOut = false;

  while (true) {
    if (batches >= maxBatches) {
      // More may remain; next run continues. Surface so the caller can alert.
      const stillOld = await client.serveDecision.findMany({
        where: { decidedAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { decidedAt: 'asc' },
        take: 1,
      });
      cappedOut = stillOld.length > 0;
      break;
    }

    const rows = await client.serveDecision.findMany({
      where: { decidedAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { decidedAt: 'asc' },
      take: batchSize,
    });

    if (rows.length === 0) break;

    const res = await client.serveDecision.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    deleted += res.count;
    batches += 1;

    if (rows.length < batchSize) break;
  }

  return { deleted, batches, cutoff, cappedOut, retentionDays };
}

/** The one Prisma method the undelivered pass needs (keeps it testable). */
export interface UndeliveredPruneClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

/**
 * Delete undelivered rows older than the window. `retentionDays` is floored
 * at UNDELIVERED_RETENTION_DAYS_FLOOR; the result reports the window used.
 */
export async function pruneUndeliveredServeDecisions(
  client: UndeliveredPruneClient,
  options: PruneOptions = {},
): Promise<PruneResult> {
  const requestedDays = options.retentionDays ?? UNDELIVERED_RETENTION_DAYS_DEFAULT;
  const batchSize = options.batchSize ?? UNDELIVERED_BATCH_SIZE_DEFAULT;
  const maxBatches = options.maxBatches ?? UNDELIVERED_MAX_BATCHES_DEFAULT;

  if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
    // A zero/negative window is a misconfiguration, not a request for the floor.
    throw new Error(
      `pruneUndeliveredServeDecisions: retentionDays must be > 0 (got ${requestedDays})`,
    );
  }
  const retentionDays = Math.max(UNDELIVERED_RETENTION_DAYS_FLOOR, requestedDays);
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

  let deleted = 0;
  let batches = 0;
  let cappedOut = false;
  let after = new Date(0);

  while (true) {
    if (batches >= maxBatches) {
      // More may remain; next run continues. Surface so the caller can alert.
      const left = await client.$queryRawUnsafe(UNDELIVERED_REMAINING_SQL, cutoff, after);
      cappedOut = Array.isArray(left) && left.length > 0;
      break;
    }

    const batch = readUndeliveredBatch(
      await client.$queryRawUnsafe(UNDELIVERED_PRUNE_BATCH_SQL, cutoff, after, batchSize),
    );
    if (batch.deleted === 0) break;
    deleted += batch.deleted;
    batches += 1;
    if (batch.lastDecidedAt) after = batch.lastDecidedAt;

    if (batch.deleted < batchSize) break;
  }

  return { deleted, batches, cutoff, cappedOut, retentionDays };
}

function readUndeliveredBatch(rows: unknown): { deleted: number; lastDecidedAt: Date | null } {
  const row = (Array.isArray(rows) ? rows[0] : undefined) as
    | { deleted?: unknown; lastDecidedAt?: unknown }
    | undefined;
  const deleted = Number(row?.deleted ?? 0);
  if (!Number.isSafeInteger(deleted) || deleted < 0) {
    throw new Error(`pruneUndeliveredServeDecisions: unreadable batch count (${String(row?.deleted)})`);
  }
  const raw = row?.lastDecidedAt;
  const lastDecidedAt = raw instanceof Date
    ? raw
    : typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null;
  return {
    deleted,
    lastDecidedAt: lastDecidedAt && Number.isFinite(lastDecidedAt.getTime()) ? lastDecidedAt : null,
  };
}
