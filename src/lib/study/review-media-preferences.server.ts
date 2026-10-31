/**
 * Writes "No videos" / "No images" into `User.experience.review` with one
 * statement, leaving every other experience key as it was, then discards the
 * learner's prepared queues so none built under the old choice is served.
 *
 * Writes are ordered by the client's revision (as the stats layout's are): a
 * request that lands late can never overwrite a newer choice.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { invalidateAllSessionCachesInTransaction } from './unified-session-cache-store';
import type { StoredReviewMediaPreferences } from './review-media-preferences';

export type ReviewMediaPreferencesDb = Pick<PrismaClient, '$executeRaw'>;

const preferenceSchema = z.object({ hideVideos: z.boolean(), hideImages: z.boolean() }).strict();

export async function writeReviewMediaPreferences(
  db: ReviewMediaPreferencesDb,
  userId: string,
  input: unknown,
  revision: number,
  now: Date,
): Promise<{ ok: true; applied: boolean; preferences: StoredReviewMediaPreferences } | { ok: false; error: string }> {
  const parsed = preferenceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid preference' };
  if (!Number.isSafeInteger(revision) || revision <= 0) return { ok: false, error: 'Invalid revision' };
  const value = JSON.stringify({ ...parsed.data, rev: revision });
  const updated = await db.$executeRaw(Prisma.sql`
    UPDATE "User"
    SET experience = COALESCE(experience, '{}'::jsonb)
      || jsonb_build_object('v', 1, 'review', ${value}::jsonb, 'updatedAt', ${now.toISOString()}::text)
    WHERE id = ${userId}
      AND COALESCE((experience #>> '{review,rev}')::numeric, 0) < ${revision}::numeric
  `);
  if (updated === 1) await invalidateAllSessionCachesInTransaction(db, userId, now);
  return { ok: true, applied: updated === 1, preferences: { ...parsed.data, rev: revision } };
}
