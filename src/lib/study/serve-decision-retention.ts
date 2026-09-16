/**
 * ServeDecision retention.
 *
 * ServeDecision is append-only — one row per served item per user, written on
 * every serve, with no consumer reading further back than ~10 days (flag-health
 * is the deepest; morning-check diagnostics default to 1–7 days). Left
 * unbounded it becomes the fastest-growing table as users scale. This prunes
 * rows older than a retention window, in bounded batches so the daily job never
 * takes a long lock or a giant single transaction.
 *
 * The window (180 days) is chosen to outlast a full study block plus its
 * post-exam analysis: a clinical block runs ~6 weeks of study into an exam, and the
 * exam-vs-usage analyses happen weeks-to-months later. At 90 days the run-up
 * scheduler context was pruned before that analysis could use it; 180 days keeps
 * a block's rich serve history available through the next-block window. Rows are
 * small metadata, so the cost of the wider window is negligible and stays
 * bounded by the batch/cap machinery as usage scales.
 *
 * Driven by /api/cron/serve-decision-retention. Tunable via
 * SERVE_DECISION_RETENTION_DAYS (default 180).
 */

export const RETENTION_DAYS_DEFAULT = 180;
const BATCH_SIZE_DEFAULT = 5000;
const MAX_BATCHES_DEFAULT = 200; // safety cap: ≤ 1M rows/run at default batch size

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
