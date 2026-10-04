/**
 * ContentGap retention.
 *
 * ContentGap rows are demand diagnostics with one reader: scaffold:needs,
 * which looks back SCAFFOLD_NEEDS_WINDOW_DAYS. Nothing reads older rows (the
 * resolve and list helpers in content-gaps.ts have no callers), so they are
 * deleted in bounded batches, oldest first, by the detectedAt index. The
 * window keeps a margin past the reader's, and the job refuses one shorter
 * than the reader's.
 *
 * Bounded by batch count AND a wall-clock deadline, so a large backlog (the
 * per-pass flood that preceded gap dedupe) drains over several nights inside
 * the function limit instead of timing out halfway.
 *
 * Driven by /api/cron/content-gap-retention. Tunable via
 * CONTENT_GAP_RETENTION_DAYS (default 45).
 */

import { SCAFFOLD_NEEDS_WINDOW_DAYS } from './scaffold-gap-types';

export const CONTENT_GAP_RETENTION_DAYS_DEFAULT = 45;
const BATCH_SIZE_DEFAULT = 5000;
const MAX_BATCHES_DEFAULT = 100; // safety cap: ≤ 500k rows/run at default batch size
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal slice of the Prisma client this function needs (keeps it testable). */
interface ContentGapDelegate {
  contentGap: {
    findMany(args: {
      where: { detectedAt: { lt: Date } };
      select: { id: true };
      orderBy: { detectedAt: 'asc' };
      take: number;
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: { where: { id: { in: string[] } } }): Promise<{ count: number }>;
  };
}

export interface ContentGapPruneOptions {
  /** Rows older than this many days are deleted. At least the reader's window. */
  retentionDays?: number;
  /** Rows deleted per batch. */
  batchSize?: number;
  /** Hard cap on batches per run (defence against a runaway loop). */
  maxBatches?: number;
  /** Epoch ms after which no new batch starts. */
  deadlineMs?: number;
}

export interface ContentGapPruneResult {
  deleted: number;
  batches: number;
  cutoff: Date;
  /** True if the cap or the deadline stopped the run with old rows left. */
  cappedOut: boolean;
  retentionDays: number;
}

export async function pruneContentGaps(
  client: ContentGapDelegate,
  options: ContentGapPruneOptions = {},
): Promise<ContentGapPruneResult> {
  const retentionDays = options.retentionDays ?? CONTENT_GAP_RETENTION_DAYS_DEFAULT;
  const batchSize = options.batchSize ?? BATCH_SIZE_DEFAULT;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_DEFAULT;
  const deadlineMs = options.deadlineMs ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(retentionDays) || retentionDays < SCAFFOLD_NEEDS_WINDOW_DAYS) {
    // A shorter window would delete rows scaffold:needs still counts, and zero
    // would delete the table. Refuse loudly.
    throw new Error(
      `pruneContentGaps: retentionDays must be at least ${SCAFFOLD_NEEDS_WINDOW_DAYS} (got ${retentionDays})`,
    );
  }

  const cutoff = new Date(Date.now() - retentionDays * DAY_MS);
  const oldestFirst = (take: number) => client.contentGap.findMany({
    where: { detectedAt: { lt: cutoff } },
    select: { id: true },
    orderBy: { detectedAt: 'asc' },
    take,
  });

  let deleted = 0;
  let batches = 0;
  let cappedOut = false;

  while (true) {
    if (batches >= maxBatches || Date.now() >= deadlineMs) {
      // More may remain; the next run continues. Surface it so the caller can log it.
      cappedOut = (await oldestFirst(1)).length > 0;
      break;
    }

    const rows = await oldestFirst(batchSize);
    if (rows.length === 0) break;

    const res = await client.contentGap.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deleted += res.count;
    batches += 1;

    if (rows.length < batchSize) break;
  }

  return { deleted, batches, cutoff, cappedOut, retentionDays };
}
