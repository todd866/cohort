/**
 * Synthetic DB write probe — the canary shared by the write-health and
 * smoke-write crons.
 *
 * Cold serverless functions + cold Neon pooler connections occasionally exceed
 * Prisma's default 2s transaction-acquisition window ("Unable to start a
 * transaction in the given time") on the FIRST request after an idle gap, while
 * the database is perfectly healthy — the very next (warm) request succeeds.
 * That cold-start artifact was paging `smoke-write: probe-threw` on quiet
 * mornings (confirmed in Vercel logs, 2026-07-11). A generous maxWait plus a
 * single retry absorbs the transient; a genuine write outage still fails every
 * attempt, so real failures page and cold starts do not.
 *
 * The row-missing-after-commit case (a committed row that a fresh read can't
 * see — the 2026-04-28 transaction-poisoning signature) is NOT retry-masked: it
 * fails immediately, because retrying could hide exactly the bug the probe
 * exists to catch.
 */

const SENTINEL_TARGET_ID = '__smoke_write_probe__';
const TX_MAX_WAIT_MS = 10_000;
const TX_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;

export interface WriteProbeResult {
  ok: boolean;
  attempts: number;
  latencyMs: number;
  /** On failure: the error message or 'row-missing-after-commit'. */
  detail?: string;
  /** Set when a committed write could not be read back (poisoning signature). */
  rowMissing?: boolean;
}

// Minimal surface so tests can pass a light mock. The extended PrismaNeon
// client's $transaction/$queryRaw carry overloaded signatures that resist a
// precise structural type; the helper only needs these three members and is
// unit-tested, so they are accepted loosely.
type ProbeClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw: any;
  contentIssue: { delete: (args: { where: { id: string } }) => Promise<unknown> };
};

export async function probeDbWrite(
  prisma: ProbeClient,
  opts: { attempts?: number; now?: () => number } = {},
): Promise<WriteProbeResult> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
  const now = opts.now ?? Date.now;
  const start = now();
  let detail = 'unknown';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const created = (await prisma.$transaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (tx: any) => {
          await tx.contentIssue.deleteMany({ where: { targetId: SENTINEL_TARGET_ID } });
          return tx.contentIssue.create({
            data: {
              targetType: 'card',
              targetId: SENTINEL_TARGET_ID,
              issueType: 'other',
              status: 'open',
              priority: 'low',
              reportTrustState: 'trusted',
              reportCount: 1,
              metadata: { smoke: true },
            },
          });
        },
        { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
      )) as { id: string };

      // Read back on a (potentially different) pooled connection — the layer the
      // 2026-04-28 poisoning bug hid in.
      const rows = (await prisma.$queryRaw`
        SELECT id FROM "ContentIssue" WHERE id = ${created.id}
      `) as Array<{ id: string }>;

      if (rows.length === 0) {
        // Committed but unreadable — do NOT retry-mask, and do NOT delete: the
        // row may land on a delayed connection and surface on the next probe,
        // which is itself a useful signal. This is the real thing to catch.
        return { ok: false, attempts: attempt, latencyMs: now() - start, detail: 'row-missing-after-commit', rowMissing: true };
      }
      await prisma.contentIssue.delete({ where: { id: created.id } }).catch(() => {});
      return { ok: true, attempts: attempt, latencyMs: now() - start };
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
      // Transient (cold connection / acquisition timeout) — fall through to retry.
    }
  }
  return { ok: false, attempts, latencyMs: now() - start, detail };
}
