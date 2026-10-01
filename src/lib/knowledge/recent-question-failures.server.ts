/** BACKGROUND USE ONLY: enrich the existing two-hour MCQ failure read. */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { LegacyQuestionFailureRow, RecentQuestionFailureSnapshot } from './scheduler-attribution';
import { ACUTE_FAILURE_WINDOW_MS } from './scheduler-attribution';

export function recentQuestionFailureQuery(
  userId: string,
  rotation: string,
  week: number | null,
  nowMs: number,
): Prisma.Sql {
  const since = new Date(nowMs - ACUTE_FAILURE_WINDOW_MS);
  const through = new Date(nowMs);
  return Prisma.sql`
    /* recent-question-failure-attribution */
    WITH failures AS (
      SELECT qr."id" AS "responseId", qr."questionId", qr."createdAt",
        (COUNT(*) OVER (PARTITION BY qr."questionId", qr."createdAt"))::int AS "responseKeyCount"
      FROM "QuestionResponse" qr
      WHERE qr."userId" = ${userId} AND qr."isCorrect" = false
        AND qr."createdAt" >= ${since} AND qr."createdAt" <= ${through}
        AND EXISTS (
          SELECT 1 FROM "QuestionConcept" qc
          JOIN "Concept" c ON c."id" = qc."conceptId"
          WHERE qc."questionId" = qr."questionId" AND c."rotation" = ${rotation}
            ${week === null ? Prisma.empty : Prisma.sql`AND c."week" = ${week}`}
        )
    )
    SELECT f.*,
      jsonb_build_object('concepts', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('conceptId', qc."conceptId")), '[]'::jsonb)
        FROM "QuestionConcept" qc WHERE qc."questionId" = f."questionId"
      )) AS "question",
      COALESCE((
        SELECT jsonb_agg(to_jsonb(e)) FROM (
          SELECT le."id", le."eventType", le."sourceType", le."sourceId",
            le."timestamp", le."isCorrect", le."conceptIds", le."metadata"
          FROM "LearningEvent" le
          WHERE le."userId" = ${userId}
            AND le."sourceType" = 'question' AND le."eventType" = 'mcq_attempted'
            AND le."sourceId" = f."questionId" AND le."timestamp" = f."createdAt"
          LIMIT 2
        ) e
      ), '[]'::jsonb) AS "eventCandidates"
    FROM failures f
  `;
}

export async function loadRecentQuestionFailures(
  userId: string,
  rotation: string,
  week: number | null,
  nowMs = Date.now(),
): Promise<RecentQuestionFailureSnapshot> {
  const rows = await prisma.$transaction(async tx => {
    // Session-local only: a slow plan must cancel, not accumulate background work.
    await tx.$executeRaw`SET LOCAL statement_timeout = '1s'`;
    return tx.$queryRaw<LegacyQuestionFailureRow[]>(
      recentQuestionFailureQuery(userId, rotation, week, nowMs),
    );
  }, { maxWait: 2_000, timeout: 5_000 });
  return { userId, rotation, week, generatedAtMs: nowMs, cutoffMs: nowMs - ACUTE_FAILURE_WINDOW_MS, rows };
}
