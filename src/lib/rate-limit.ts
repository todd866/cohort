/**
 * Cross-instance rate limiting backed by Postgres.
 *
 * Vercel functions do not share memory, so an in-process Map can only slow a
 * single warm instance. The database upsert below is atomic and keeps one
 * rolling fixed-window bucket per hashed key, making the limit consistent
 * across every serverless instance without retaining IP addresses or user IDs
 * in plaintext.
 *
 * The limiter fails closed when the store is unavailable. Routes may surface
 * that as a short 429/retry response; they must not silently fall back to a
 * per-instance limiter and turn a security/cost control into best effort.
 */

import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number; reason: 'limit_exceeded' | 'store_unavailable' };

type BucketRow = { count: number; expiresAt: Date | string };

function hashedBucketKey(key: string): string {
  return `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Atomically consume one token from a shared fixed-window bucket.
 */
async function consumeSharedRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (!key || !validPositiveInteger(limit) || !validPositiveInteger(windowMs)) {
    throw new TypeError('Rate limit key, limit, and window must be valid positive values');
  }

  const now = new Date();
  const nextExpiry = new Date(now.getTime() + windowMs);
  const bucketKey = hashedBucketKey(key);

  try {
    const rows = await prisma.$queryRaw<BucketRow[]>`
      INSERT INTO "RateLimitBucket"
        ("key", "count", "windowStartedAt", "expiresAt", "updatedAt")
      VALUES
        (${bucketKey}, 1, ${now}, ${nextExpiry}, ${now})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN 1
          ELSE "RateLimitBucket"."count" + 1
        END,
        "windowStartedAt" = CASE
          WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN ${now}
          ELSE "RateLimitBucket"."windowStartedAt"
        END,
        "expiresAt" = CASE
          WHEN "RateLimitBucket"."expiresAt" <= ${now} THEN ${nextExpiry}
          ELSE "RateLimitBucket"."expiresAt"
        END,
        "updatedAt" = ${now}
      RETURNING "count", "expiresAt"
    `;

    const bucket = rows[0];
    if (!bucket) throw new Error('rate-limit upsert returned no bucket');
    if (bucket.count <= limit) return { ok: true };

    const expiresAt = bucket.expiresAt instanceof Date
      ? bucket.expiresAt
      : new Date(bucket.expiresAt);
    const retryAfterMs = Number.isFinite(expiresAt.getTime())
      ? Math.max(1, expiresAt.getTime() - Date.now())
      : windowMs;
    return { ok: false, retryAfterMs, reason: 'limit_exceeded' };
  } catch (error) {
    logger.error('Shared rate-limit store unavailable', {
      bucketKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      retryAfterMs: Math.min(windowMs, 5_000),
      reason: 'store_unavailable',
    };
  }
}

/**
 * Public wrapper. The union keeps lightweight route-test fakes able to return a
 * value synchronously; the production implementation always returns a Promise
 * and every caller awaits it.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult | Promise<RateLimitResult> {
  return consumeSharedRateLimit(key, limit, windowMs);
}

/** Per-user helper. The raw user ID is hashed before persistence. */
export function checkUserRateLimit(
  userId: string,
  route: string,
  limit: number = 30,
  windowMs: number = 60_000,
): RateLimitResult | Promise<RateLimitResult> {
  return checkRateLimit(`user:${userId}:${route}`, limit, windowMs);
}
