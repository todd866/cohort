/**
 * Cross-instance single flight for background session builds.
 *
 * A study-queue rebuild or an offline-pack build is a full scheduler pass:
 * tens of seconds of database work for one learner. The in-process lock in
 * unified-session-cache-refresh-lock.ts coalesces callers inside one function
 * instance, but serverless traffic spreads one learner's requests over several
 * instances, so two devices, a cron run and a request-path refresh could each
 * start the same build at once. This lease is the shared half of that lock: a
 * row per (learner, scope) in Postgres.
 *
 * Why a row and not an advisory lock: production connects through PgBouncer
 * in transaction mode, where a session-level advisory lock belongs to whichever
 * server connection the pooler handed out and is not held across statements.
 * A transaction-level advisory lock would only guard the claim itself, not a
 * build made of many statements. Each statement here is self-contained.
 *
 * - Claim: one INSERT ... ON CONFLICT DO UPDATE that succeeds when no row
 *   exists or the existing row has expired. Under READ COMMITTED a concurrent
 *   claimant waits for the winner's insert and then sees an unexpired row, so
 *   exactly one claimant gets the row back.
 * - Release: delete the row, keyed on the owner token, so a holder that
 *   overran its lease cannot delete the row of the instance that took over.
 * - Crash: a holder that dies leaves its row behind, and the next claim after
 *   expiresAt takes it over. No cleanup job is needed.
 *
 * Correctness never depends on the lease. A late or duplicate build is still
 * refused at write time by the cache epoch and the snapshot-order check in
 * upsertSessionCache, which is what makes failing open safe.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

/**
 * Lease lifetime for a caller that passes none: the shortest function ceiling
 * a build runs under, the 60 s every API route gets from vercel.json's api
 * glob. A build cannot outlive its function, and its lease should not either:
 * one that outlived a build the platform stopped would turn away every other
 * refresh of the scope until it expired. A caller on a route allowed longer
 * (the session route, the warm cron, the offline pack: 300 s) passes its own
 * ceiling, and each route's test pins that to its configured maxDuration. A
 * lease shorter than its build only risks a duplicate build, which the
 * write-time checks make harmless.
 */
export const SESSION_REFRESH_LEASE_TTL_MS = 60_000;

/** The scope a study-queue rebuild for one rotation claims. */
export function queueRefreshScope(rotation: string): string {
  return `queue:${rotation}`;
}

/**
 * The scope an offline-pack build claims: one per learner, whatever rotations
 * the pack spans. Claimed per rotation, two requests could each win a
 * different part of one learner's pack and both answer with a partial pack.
 * It can never collide with a queue scope ('queue:<rotation>').
 */
export const OFFLINE_PACK_BUILD_SCOPE = 'offline-pack';

export interface SessionRefreshLease {
  userId: string;
  scope: string;
  ownerToken: string;
}

export type SessionRefreshLeaseClaim =
  | {
      status: 'acquired';
      lease: SessionRefreshLease;
      /** The scope's previous holder never released it: it died or overran. */
      tookOverExpired: boolean;
    }
  | {
      status: 'held';
      /** What asked for the build in progress, when that row was visible. */
      holderSource: string | null;
      holderAgeMs: number | null;
    }
  | {
      /** The claim could not run. Callers build without a lease. */
      status: 'unavailable';
      error: string;
    };

interface ClaimRow {
  claimedToken: string | null;
  priorSource: string | null;
  priorAgeMs: number | null;
  priorExpired: boolean | null;
}

export async function claimSessionRefreshLease(
  userId: string,
  scope: string,
  options: { source: string; ttlMs?: number; ownerToken?: string },
): Promise<SessionRefreshLeaseClaim> {
  const ttlMs = Math.round(options.ttlMs ?? SESSION_REFRESH_LEASE_TTL_MS);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`Session refresh lease ttl must be a positive number of milliseconds, got ${options.ttlMs}`);
  }
  const ownerToken = options.ownerToken ?? randomUUID();

  let row: ClaimRow | undefined;
  try {
    // `prior` reads this statement's snapshot, so it describes the holder this
    // claim lost to, for the log line. `claimed` is the claim itself: the data-
    // modifying CTE runs exactly once whether or not the outer query reads it.
    const rows = await prisma.$queryRaw<ClaimRow[]>`
      WITH prior AS (
        SELECT "source", "acquiredAt", "expiresAt"
        FROM "SessionRefreshLease"
        WHERE "userId" = ${userId} AND "scope" = ${scope}
      ),
      claimed AS (
        INSERT INTO "SessionRefreshLease" ("userId", "scope", "ownerToken", "source", "acquiredAt", "expiresAt")
        VALUES (
          ${userId}, ${scope}, ${ownerToken}, ${options.source},
          now(), now() + (${ttlMs}::integer * interval '1 millisecond')
        )
        ON CONFLICT ("userId", "scope") DO UPDATE
        SET "ownerToken" = EXCLUDED."ownerToken",
            "source" = EXCLUDED."source",
            "acquiredAt" = EXCLUDED."acquiredAt",
            "expiresAt" = EXCLUDED."expiresAt"
        WHERE "SessionRefreshLease"."expiresAt" <= now()
        RETURNING "ownerToken"
      )
      SELECT
        (SELECT "ownerToken" FROM claimed) AS "claimedToken",
        prior."source" AS "priorSource",
        (EXTRACT(EPOCH FROM (now() - prior."acquiredAt")) * 1000)::double precision AS "priorAgeMs",
        (prior."expiresAt" <= now()) AS "priorExpired"
      FROM (SELECT 1) AS one
      LEFT JOIN prior ON true
    `;
    row = rows[0];
  } catch (error) {
    return { status: 'unavailable', error: String(error) };
  }

  if (row?.claimedToken === ownerToken) {
    return {
      status: 'acquired',
      lease: { userId, scope, ownerToken },
      tookOverExpired: row.priorExpired === true,
    };
  }
  return {
    status: 'held',
    holderSource: row?.priorSource ?? null,
    holderAgeMs: typeof row?.priorAgeMs === 'number' ? Math.round(row.priorAgeMs) : null,
  };
}

/** Best effort. A release that never lands is covered by expiry. */
export async function releaseSessionRefreshLease(lease: SessionRefreshLease): Promise<void> {
  try {
    await prisma.$executeRaw`
      DELETE FROM "SessionRefreshLease"
      WHERE "userId" = ${lease.userId}
        AND "scope" = ${lease.scope}
        AND "ownerToken" = ${lease.ownerToken}
    `;
  } catch (error) {
    logger.warn('Session refresh lease release failed; it will expire', {
      userId: lease.userId,
      scope: lease.scope,
      error: String(error),
    });
  }
}
