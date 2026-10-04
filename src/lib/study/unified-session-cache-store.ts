import { prisma } from '@/lib/prisma';
import { QUEUE_DRAIN_FLOOR_ITEMS, type UnifiedItem } from './unified-session-types';
import {
  cacheItemsMatchReviewChallenge,
  normalizeReviewChallengePreference,
  type ReviewChallengePreference,
} from './review-challenge-preference';
import { REVIEW_CHALLENGE_POLICY_VERSION } from './review-challenge';

/** Bump the shared epoch and clear every prepared rotation in one transaction. */
export async function invalidateAllSessionCachesInTransaction(
  tx: Pick<typeof prisma, '$executeRaw'>,
  userId: string,
  now = new Date(),
): Promise<void> {
  await tx.$executeRaw`
    WITH bumped AS (
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 1, 0, 0, 0, 0)
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET "itemCount" = "UserStudyQueue"."itemCount" + 1,
        "computedAt" = ${now}, "validUntil" = ${now}
      RETURNING "itemCount"
    )
    UPDATE "UserStudyQueue"
    SET items = '[]'::jsonb, "computedAt" = clock_timestamp(), "validUntil" = ${now},
        "itemCount" = 0, "dueCards" = 0, "weakCards" = 0, "newCards" = 0, questions = 0
    WHERE "userId" = ${userId}
      AND rotation <> ${CACHE_EPOCH_ROTATION}
      AND EXISTS (SELECT 1 FROM bumped)
  `;
}

/**
 * How long a written queue counts as fresh: a build's write sets validUntil
 * this far ahead, and nothing else moves it later. The cache lane serves it
 * stale for CACHE_STALE_SERVE_MAX_MS more, and the undelivered ServeDecision
 * prune's floor depends on the sum (serve-decision-retention.ts).
 */
export const SESSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_EPOCH_ROTATION = '__md3_cache_epoch__';

/**
 * When a grade drains a queue below one client batch (compute-fetch-slots
 * requests 15 per slot), expire it, and report the rotation so the grade's
 * own request rebuilds it in the background. (Defined in unified-session-types
 * so the warm planner can share it without loading the database client.) Without the expiry, an active
 * session drained the queue to empty while validUntil still said fresh,
 * unusable by the cache lane, and the next request fell to the slow lanes.
 * The expired queue keeps serving as cache-stale in the meantime, and the
 * next request for it refreshes it too, so this costs nothing.
 *
 * Expiring only ever moves validUntil earlier, never later. The cache lane
 * serves a queue for a day past validUntil, so resetting an already-expired
 * queue's validUntil to now restarted that day, and every grade, in any
 * rotation, did it to every queue below the floor. Such a queue stayed
 * servable for as long as the learner kept answering, with cache-build
 * decision ids older than the undelivered-decision prune's floor assumes
 * (see serve-decision-retention.ts). Only a build's write sets validUntil.
 */
export { QUEUE_DRAIN_FLOOR_ITEMS };

/**
 * The epoch row shares the UserStudyQueue table but is a serialization lock,
 * not a queue: its itemCount is the invalidation epoch. Diagnostics that
 * enumerate queues must skip it or they report a phantom "empty" rotation.
 */
export function isCacheEpochRotation(rotation: string): boolean {
  return rotation === CACHE_EPOCH_ROTATION;
}

export interface SessionCacheRow {
  items: unknown;
  validUntil: Date;
}

/**
 * What became of a finished build's write.
 * - `stale`: the epoch moved while it ran (a grade or an invalidation).
 * - `superseded`: the stored queue was built from a newer snapshot.
 */
export type SessionCacheWriteResult = 'written' | 'stale' | 'superseded';

/**
 * A build's view of the learner's cache epoch, and the moment it took it by
 * the database clock. Read both in one statement before the build starts.
 */
export interface SessionCacheSnapshot {
  epoch: number;
  /**
   * clock_timestamp() during the epoch read, rounded to the millisecond as
   * computedAt stores it. Every computedAt on a queue row comes from the same
   * clock (grades stamp clock_timestamp() too), so instances agree on the
   * order whatever their own clocks say. clock_timestamp() rather than now()
   * or statement_timestamp(): it is read after the statement's snapshot, so
   * any grade visible in that epoch committed, and stamped, before it.
   * Rounding preserves order, so a stamp never rounds past a later token.
   */
  snapshotAt: Date;
  reviewChallenge?: ReviewChallengePreference;
}

/** Capture this before starting an expensive cache computation. */
export async function readSessionCacheSnapshot(userId: string): Promise<SessionCacheSnapshot> {
  const rows = await prisma.$queryRaw<Array<{
    epoch: number | null;
    snapshotAt: Date;
    reviewChallenge: number | null;
    reviewChallengeRevision: number | null;
  }>>`
    SELECT (
             SELECT "itemCount"
             FROM "UserStudyQueue"
             WHERE "userId" = ${userId} AND rotation = ${CACHE_EPOCH_ROTATION}
           ) AS epoch,
           clock_timestamp()::timestamptz(3) AS "snapshotAt",
           u."reviewChallenge",
           u."reviewChallengeRevision"
      FROM "User" u
     WHERE u.id = ${userId}
  `;
  const row = rows[0];
  if (!(row?.snapshotAt instanceof Date)) {
    throw new Error('Session cache snapshot read returned no database time');
  }
  return {
    epoch: row.epoch ?? 0,
    snapshotAt: row.snapshotAt,
    reviewChallenge: normalizeReviewChallengePreference({
      level: row.reviewChallenge,
      revision: row.reviewChallengeRevision,
      policy: REVIEW_CHALLENGE_POLICY_VERSION,
    }),
  };
}

/**
 * Write a finished build's queue, unless it is out of date.
 *
 * `snapshot` is what readSessionCacheSnapshot returned before the build read
 * anything. Its epoch must still be current ('stale' otherwise: a grade or an
 * invalidation landed while it ran). Its token is stored as computedAt, and a
 * stored queue with a later computedAt wins ('superseded'): the epoch only
 * moves on a grade, so two builds racing with no grade between them both
 * match it, and without the order check the one that FINISHED last would
 * overwrite a queue read from fresher data. Grades also stamp computedAt, but
 * a grade after the snapshot has already moved the epoch. Every writer passes
 * a snapshot, so none can skip either check.
 */
export async function upsertSessionCache(
  userId: string,
  rotation: string,
  items: UnifiedItem[],
  snapshot: SessionCacheSnapshot,
): Promise<SessionCacheWriteResult> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + SESSION_CACHE_TTL_MS);
  const itemCount = items.length;
  const dueCards = items.filter((item) => item.type === 'card').length;
  const questionCount = items.filter((item) => item.type === 'question').length;
  const reviewChallenge = normalizeReviewChallengePreference(snapshot.reviewChallenge);
  if (!cacheItemsMatchReviewChallenge(items as unknown as Array<Record<string, unknown>>, reviewChallenge)) {
    return 'stale';
  }

  return prisma.$transaction(async (tx) => {
    // The epoch row is also the serialization lock for cache writes versus a
    // grade invalidation. If this is the first cache operation for the user,
    // create epoch zero while holding the transaction open.
    await tx.$executeRaw`
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 0, 0, 0, 0, 0)
      ON CONFLICT ("userId", rotation) DO NOTHING
    `;
    const epochRows = await tx.$queryRaw<Array<{ itemCount: number }>>`
      SELECT "itemCount"
      FROM "UserStudyQueue"
      WHERE "userId" = ${userId} AND rotation = ${CACHE_EPOCH_ROTATION}
      FOR UPDATE
    `;
    if (epochRows[0]?.itemCount !== snapshot.epoch) return 'stale';

    // Every queue write takes the epoch row lock first, so this read sees the
    // last committed writer's computedAt.
    const stored = await tx.$queryRaw<Array<{ computedAt: Date }>>`
      SELECT "computedAt"
      FROM "UserStudyQueue"
      WHERE "userId" = ${userId} AND rotation = ${rotation}
    `;
    const storedAt = stored[0]?.computedAt;
    if (storedAt && storedAt.getTime() > snapshot.snapshotAt.getTime()) return 'superseded';

    await tx.$executeRaw`
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (
        gen_random_uuid()::text, ${userId}, ${rotation},
        ${JSON.stringify(items)}::jsonb, ${snapshot.snapshotAt}, ${validUntil},
        ${itemCount}, ${dueCards}, 0, 0, ${questionCount}
      )
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET
        items = EXCLUDED.items, "computedAt" = EXCLUDED."computedAt",
        "validUntil" = EXCLUDED."validUntil", "itemCount" = EXCLUDED."itemCount",
        "dueCards" = EXCLUDED."dueCards", "weakCards" = 0, "newCards" = 0, questions = EXCLUDED.questions
    `;
    return 'written';
  });
}

/** Phase changes invalidate this rotation in the same answer transaction.
 * Bumping the shared epoch also rejects a background build begun before the
 * change, while keeping every unrelated rotation's prepared queue warm.
 */
export async function invalidateRotationSessionCache(
  tx: Pick<typeof prisma, '$executeRaw'>,
  userId: string,
  rotation: string,
  now = new Date(),
): Promise<void> {
  if (rotation === CACHE_EPOCH_ROTATION) throw new Error('Cannot invalidate the cache epoch as a rotation');
  await tx.$executeRaw`
    WITH bumped AS (
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 1, 0, 0, 0, 0)
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET "itemCount" = "UserStudyQueue"."itemCount" + 1,
        "computedAt" = ${now}, "validUntil" = ${now}
      RETURNING "itemCount"
    )
    UPDATE "UserStudyQueue"
    SET items = '[]'::jsonb, "computedAt" = clock_timestamp(), "validUntil" = ${now},
      "itemCount" = 0, "dueCards" = 0, "weakCards" = 0, "newCards" = 0, questions = 0
    WHERE "userId" = ${userId} AND rotation = ${rotation}
      AND EXISTS (SELECT 1 FROM bumped)
  `;
}

/**
 * Advance the epoch and drop the graded item from every cached queue.
 *
 * Previously this emptied EVERY rotation's queue on every graded card. Grading
 * one CAH card therefore threw away the precomputed batches for anking, pwh,
 * mnd, critical-care and paam as well — work those rotations then had to redo
 * live. Production traces showed the active queue remained populated while
 * unrelated queues were repeatedly discarded.
 *
 * against a batch size of ~15-20, so essentially every batch computed live: a
 * full manifold walk per rotation. That is why Review was the slowest tab.
 *
 * Removing just the graded item is both faster AND more correct than a wipe:
 * the one thing a grade genuinely invalidates is the item you graded, and
 * grading a CAH card does not change what is due in PWH. The other ~19 of 20
 * precomputed items stay warm. The one exception: a queue drained below
 * QUEUE_DRAIN_FLOOR_ITEMS is expired (not emptied), and its rotation is
 * returned so the caller can rebuild it now rather than at the next request.
 *
 * The epoch bump is UNCHANGED and still required: it is the serialization lock
 * against upsertSessionCache, so a computation that began before this point
 * can never resurrect stale items afterward.
 *
 * The queue is read AFTER the bump, in a later statement of the same
 * transaction, never in the bump's own statement. A statement reads one
 * snapshot, taken when it starts. Two quick grades on two instances both start
 * before either commits; the second waits on the first's epoch row, but a
 * queue read in that same statement would still come from its starting
 * snapshot, and its update would write the first grade's item back. Under READ
 * COMMITTED a later statement takes a fresh snapshot, so once the bump has been
 * granted the lock, the queue rows are locked (in id order, so two lockers
 * cannot deadlock) and filtered as the previous grade committed them. That
 * also keeps beforeCount, and so the drain report, true.
 *
 * Returns the rotations whose queue this grade changed (it held the graded
 * item) and left below the floor: the grade that crosses it and every later
 * grade that drains it further. The crossing grade's rebuild is refused if
 * another grade lands while it runs, so reporting only the crossing left a
 * busy learner's queue short until their next visit. Repeating the ask is
 * cheap: the refresh lease turns it away while a rebuild for the queue is
 * running anywhere, so at most one runs at a time. A queue this grade did not
 * touch is not reported; the request path and the warm cron rebuild it.
 */
export async function invalidateSessionCaches(
  userId: string,
  gradedItemId?: string,
): Promise<string[]> {
  const now = new Date();

  // No item id (bulk/unknown invalidation) — fall back to the old full wipe.
  if (!gradedItemId) {
    await invalidateAllSessionCachesInTransaction(prisma, userId, now);
    return [];
  }

  // One transaction of three statements, run in order. The first is the
  // serialization point; the second and third each read a snapshot taken after
  // it, so they see every grade that committed before this one.
  const [, , changed] = await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 1, 0, 0, 0, 0)
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET
        "itemCount" = "UserStudyQueue"."itemCount" + 1,
        "computedAt" = ${now},
        "validUntil" = ${now}
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "UserStudyQueue"
      WHERE "userId" = ${userId} AND rotation <> ${CACHE_EPOCH_ROTATION}
      ORDER BY id
      FOR UPDATE
    `,
    prisma.$queryRaw<Array<{ rotation: string; beforeCount: number; afterCount: number }>>`
      UPDATE "UserStudyQueue" q
      SET items = f.kept,
          "computedAt" = clock_timestamp(),
          "itemCount" = jsonb_array_length(f.kept),
          "validUntil" = CASE WHEN jsonb_array_length(f.kept) < ${QUEUE_DRAIN_FLOOR_ITEMS}
                              THEN LEAST(q."validUntil", ${now}) ELSE q."validUntil" END,
          "dueCards" = (SELECT count(*) FROM jsonb_array_elements(f.kept) e WHERE e->>'type' = 'card'),
          questions = (SELECT count(*) FROM jsonb_array_elements(f.kept) e WHERE e->>'type' = 'question')
      FROM (
        SELECT c.id,
               jsonb_array_length(c.items) AS before_count,
               COALESCE(
                 (SELECT jsonb_agg(e.value ORDER BY e.ordinality)
                    FROM jsonb_array_elements(c.items) WITH ORDINALITY AS e(value, ordinality)
                   WHERE e.value->>'id' IS DISTINCT FROM ${gradedItemId}),
                 '[]'::jsonb
               ) AS kept
          FROM "UserStudyQueue" c
         WHERE c."userId" = ${userId}
           AND c.rotation <> ${CACHE_EPOCH_ROTATION}
      ) f
      WHERE q.id = f.id
      RETURNING q.rotation AS rotation,
                f.before_count AS "beforeCount",
                jsonb_array_length(f.kept) AS "afterCount"
    `,
  ]);
  return changed
    .filter((row) => row.afterCount < row.beforeCount && row.afterCount < QUEUE_DRAIN_FLOOR_ITEMS)
    .map((row) => row.rotation);
}

export async function readSessionCache(
  userId: string,
  rotation: string,
  reviewChallenge: ReviewChallengePreference,
): Promise<SessionCacheRow | null> {
  const cached = await prisma.$queryRaw<SessionCacheRow[]>`
    SELECT items, "validUntil"
    FROM "UserStudyQueue"
    WHERE "userId" = ${userId} AND rotation = ${rotation}
    LIMIT 1
  `;
  const row = cached[0];
  if (!row || !Array.isArray(row.items)) return row ?? null;
  return cacheItemsMatchReviewChallenge(
    row.items as Array<Record<string, unknown>>,
    normalizeReviewChallengePreference(reviewChallenge),
  ) ? row : null;
}

export async function deleteSessionCache(
  userId: string,
  rotation: string,
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "UserStudyQueue"
    WHERE "userId" = ${userId} AND rotation = ${rotation}
  `;
}
