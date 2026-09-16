import { prisma } from '@/lib/prisma';
import type { UnifiedItem } from './unified-session-types';

const SESSION_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_EPOCH_ROTATION = '__md3_cache_epoch__';

/**
 * When a grade drains a queue below one client batch (compute-fetch-slots
 * requests 15 per slot), expire it so the warm cron sees it as 'expired' and
 * rebuilds. Without this, an active session drained the queue to empty while
 * validUntil still said fresh — unusable by the cache lane, invisible to the
 * cron — and the user's next request fell to the slow lanes. The expired
 * queue keeps serving as cache-stale in the meantime, so this costs nothing.
 */
export const QUEUE_DRAIN_FLOOR_ITEMS = 15;

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

export async function upsertSessionCache(
  userId: string,
  rotation: string,
  items: UnifiedItem[],
  expectedEpoch: number,
): Promise<boolean> {
  const now = new Date();
  const validUntil = new Date(now.getTime() + SESSION_CACHE_TTL_MS);
  const itemCount = items.length;
  const dueCards = items.filter((item) => item.type === 'card').length;
  const questionCount = items.filter((item) => item.type === 'question').length;

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
    if (epochRows[0]?.itemCount !== expectedEpoch) return false;

    await tx.$executeRaw`
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (
        gen_random_uuid()::text, ${userId}, ${rotation},
        ${JSON.stringify(items)}::jsonb, ${now}, ${validUntil},
        ${itemCount}, ${dueCards}, 0, 0, ${questionCount}
      )
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET
        items = ${JSON.stringify(items)}::jsonb, "computedAt" = ${now},
        "validUntil" = ${validUntil}, "itemCount" = ${itemCount},
        "dueCards" = ${dueCards}, "weakCards" = 0, "newCards" = 0, questions = ${questionCount}
    `;
    return true;
  });
}

/** Capture this before starting an expensive cache computation. */
export async function readSessionCacheEpoch(userId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ itemCount: number }>>`
    SELECT "itemCount"
    FROM "UserStudyQueue"
    WHERE "userId" = ${userId} AND rotation = ${CACHE_EPOCH_ROTATION}
    LIMIT 1
  `;
  return rows[0]?.itemCount ?? 0;
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
 * QUEUE_DRAIN_FLOOR_ITEMS is expired (not emptied) so the warm cron rebuilds
 * it before the user's next session instead of never.
 *
 * The epoch bump is UNCHANGED and still required: it is the serialization lock
 * against upsertSessionCache, so a computation that began before this point
 * can never resurrect stale items afterward.
 */
export async function invalidateSessionCaches(
  userId: string,
  gradedItemId?: string,
): Promise<void> {
  const now = new Date();

  // No item id (bulk/unknown invalidation) — fall back to the old full wipe.
  if (!gradedItemId) {
    await prisma.$executeRaw`
      WITH bumped AS (
        INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
        VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 1, 0, 0, 0, 0)
        ON CONFLICT ("userId", rotation)
        DO UPDATE SET
          "itemCount" = "UserStudyQueue"."itemCount" + 1,
          "computedAt" = ${now},
          "validUntil" = ${now}
        RETURNING "itemCount"
      )
      UPDATE "UserStudyQueue"
      SET items = '[]'::jsonb, "computedAt" = ${now}, "validUntil" = ${now},
          "itemCount" = 0, "dueCards" = 0, "weakCards" = 0, "newCards" = 0, questions = 0
      WHERE "userId" = ${userId}
        AND rotation <> ${CACHE_EPOCH_ROTATION}
        AND EXISTS (SELECT 1 FROM bumped)
    `;
    return;
  }

  await prisma.$executeRaw`
    WITH bumped AS (
      INSERT INTO "UserStudyQueue" (id, "userId", rotation, items, "computedAt", "validUntil", "itemCount", "dueCards", "weakCards", "newCards", questions)
      VALUES (gen_random_uuid()::text, ${userId}, ${CACHE_EPOCH_ROTATION}, '[]'::jsonb, ${now}, ${now}, 1, 0, 0, 0, 0)
      ON CONFLICT ("userId", rotation)
      DO UPDATE SET
        "itemCount" = "UserStudyQueue"."itemCount" + 1,
        "computedAt" = ${now},
        "validUntil" = ${now}
      RETURNING "itemCount"
    ),
    filtered AS (
      SELECT q.id,
             COALESCE(
               (SELECT jsonb_agg(e)
                  FROM jsonb_array_elements(q.items) e
                 WHERE e->>'id' IS DISTINCT FROM ${gradedItemId}),
               '[]'::jsonb
             ) AS kept
        FROM "UserStudyQueue" q
       WHERE q."userId" = ${userId}
         AND q.rotation <> ${CACHE_EPOCH_ROTATION}
    )
    UPDATE "UserStudyQueue" q
    SET items = f.kept,
        "computedAt" = ${now},
        "itemCount" = jsonb_array_length(f.kept),
        "validUntil" = CASE WHEN jsonb_array_length(f.kept) < ${QUEUE_DRAIN_FLOOR_ITEMS}
                            THEN ${now} ELSE q."validUntil" END,
        "dueCards" = (SELECT count(*) FROM jsonb_array_elements(f.kept) e WHERE e->>'type' = 'card'),
        questions = (SELECT count(*) FROM jsonb_array_elements(f.kept) e WHERE e->>'type' = 'question')
    FROM filtered f
    WHERE q.id = f.id AND EXISTS (SELECT 1 FROM bumped)
  `;
}

export async function readSessionCache(
  userId: string,
  rotation: string,
): Promise<SessionCacheRow | null> {
  const cached = await prisma.$queryRaw<SessionCacheRow[]>`
    SELECT items, "validUntil"
    FROM "UserStudyQueue"
    WHERE "userId" = ${userId} AND rotation = ${rotation}
    LIMIT 1
  `;
  return cached[0] ?? null;
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
