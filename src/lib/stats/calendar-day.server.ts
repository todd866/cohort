/**
 * The calendar popover's one read. Keyed on the signed-in learner and a
 * Sydney day range, using the (userId, timestamp) and (userId, nextDueAt)
 * indexes. Not imported by the review hot path.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { ANSWER_TIME_CAP_MS, sydneyDay } from './stats-model';
import { sydneyDayEndSql, sydneyDayStartSql } from './stats-query.server';
import type { DayGroupRow } from './calendar-day';

export type CalendarDayDb = Pick<PrismaClient, '$queryRaw'>;

const REVIEW_TYPES = ['card_reviewed', 'mcq_attempted'];

/** Grouped answer rows for [from, to] inclusive. One statement. */
export async function loadAnsweredDay(
  db: CalendarDayDb,
  userId: string,
  from: string,
  to: string,
): Promise<DayGroupRow[]> {
  return db.$queryRaw<DayGroupRow[]>(Prisma.sql`
    SELECT COALESCE(e.rotation, '') AS rotation,
           COALESCE(c.topics[1], q.topics[1], '') AS topic,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (
             WHERE (e."eventType" = 'card_reviewed' AND e.quality > 0)
                OR (e."eventType" = 'mcq_attempted' AND e."isCorrect")
           )::int AS pass,
           COUNT(*) FILTER (
             WHERE (e."eventType" = 'card_reviewed' AND e.quality IS NOT NULL)
                OR (e."eventType" = 'mcq_attempted' AND e."isCorrect" IS NOT NULL)
           )::int AS scored,
           COALESCE(SUM(LEAST(GREATEST(e."responseMs", 0), ${ANSWER_TIME_CAP_MS})), 0)::float8 AS ms
    FROM "LearningEvent" e
    LEFT JOIN "Card" c ON e."sourceType" = 'card' AND c.id = e."sourceId"
    LEFT JOIN "Question" q ON e."sourceType" = 'question' AND q.id = e."sourceId"
    WHERE e."userId" = ${userId}
      AND e."eventType" = ANY(${REVIEW_TYPES}::text[])
      AND e."timestamp" >= ${sydneyDayStartSql(from)}
      AND e."timestamp" < ${sydneyDayEndSql(to)}
    GROUP BY 1, 2
  `);
}

export interface DueSliceRow { rotation: string; n: number }

/** Cards due on the Sydney days [from, to], for this learner only. One statement. */
export async function loadDueDay(
  db: CalendarDayDb,
  userId: string,
  from: string,
  to: string,
): Promise<DueSliceRow[]> {
  return db.$queryRaw<DueSliceRow[]>(Prisma.sql`
    SELECT COALESCE(c.rotation, '') AS rotation,
           COUNT(*)::int AS n
    FROM "CardProgress" cp
    JOIN "Card" c ON c.id = cp."cardId"
    WHERE cp."userId" = ${userId}
      AND cp.status <> 'retired'
      AND NOT cp.suppressed
      AND cp."nextDueAt" >= ${sydneyDayStartSql(from)}
      AND cp."nextDueAt" < ${sydneyDayEndSql(to)}
    GROUP BY 1
  `);
}

export function calendarToday(now = new Date()): string {
  return sydneyDay(now);
}
