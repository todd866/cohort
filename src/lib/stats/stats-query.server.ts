/**
 * Statistics and Exam gaps: the database reads. Every query is keyed on one
 * learner (`"userId" = $1` first, so each uses a userId-leading index), counts
 * in Postgres, and returns grouped rows, never events. The page issues them
 * together (Promise.all), not in series.
 *
 * Optional page read, never study-session preparation: nothing here may be
 * imported by the review request path (.claude/rules/hot-path-latency.md).
 *
 * Measured cost on production is recorded in the commit that added this file.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { areaForItem, formAreas, resolveStoredArea, UNASSIGNED_AREA } from './blueprint-areas';
import { toExamResultView } from './exam-result';
import {
  ANSWER_TIME_CAP_MS,
  LEARNING_MAX_DAYS,
  MATURE_MIN_DAYS,
  INTERVAL_EDGES,
  FORECAST_DAYS,
  periodStartDay,
  sydneyDay,
  type AreaRow,
  type DailyRow,
  type ExamResultView,
  type HourRow,
  type ItemKind,
  type PracticeSitting,
  type ProgressRow,
  type ProgressSet,
  type Stage,
  type StageRow,
  type StatsPeriod,
} from './stats-model';

export type StatsDb = Pick<PrismaClient, '$queryRaw'>;

export const STATS_TZ = 'Australia/Sydney';

/** Midnight at the start of a Sydney civil day, independent of the session TimeZone. */
export function sydneyDayStartSql(day: string): Prisma.Sql {
  return Prisma.sql`(${day}::date::timestamp AT TIME ZONE ${STATS_TZ})`;
}

/**
 * Midnight at the start of the next Sydney civil date.
 * `timestamptz + interval '1 day'` is 24 hours in the session zone, so a
 * daylight-saving day (23 or 25 hours) would include or drop an hour.
 */
export function sydneyDayEndSql(day: string): Prisma.Sql {
  return Prisma.sql`((${day}::date + 1)::timestamp AT TIME ZONE ${STATS_TZ})`;
}
const REVIEW_TYPES = ['card_reviewed', 'mcq_attempted'];
/** Matches PUBLIC_PRACTICE_ATTEMPT_SCHEMA (src/lib/practice-exam/attempt-ref.ts); a test pins it. */
export const PRACTICE_SITTING_SCHEMA = 'md3.public-practice-attempt/v1';
const PRACTICE_LIMIT = 60;
const EXAM_RESULT_LIMIT = 20;

export { sydneyDay };

export interface StatsScope {
  /** Sydney day the instruments are relative to. */
  today: string;
  period: StatsPeriod;
  rotation: string | null;
  /** Count only answers on or after this Sydney day. Used for one block's coverage. */
  sinceDay?: string;
}

const KIND_SQL = Prisma.sql`CASE WHEN "eventType" = 'card_reviewed' THEN 'card' ELSE 'mcq' END`;
const PASS_SQL = Prisma.sql`COUNT(*) FILTER (WHERE ("eventType" = 'card_reviewed' AND quality > 0) OR ("eventType" = 'mcq_attempted' AND "isCorrect"))::int`;
const SCORED_WHERE = Prisma.sql`(("eventType" = 'card_reviewed' AND quality IS NOT NULL) OR ("eventType" = 'mcq_attempted' AND "isCorrect" IS NOT NULL))`;
const SCORED_SQL = Prisma.sql`COUNT(*) FILTER (WHERE ${SCORED_WHERE})::int`;
/** A revealed MCQ carries a response time but no grade; it is not an answer. */
const TIMED_SCORED_WHERE = Prisma.sql`"responseMs" IS NOT NULL AND ${SCORED_WHERE}`;
const MS_SQL = Prisma.sql`COALESCE(SUM(LEAST(GREATEST("responseMs", 0), ${ANSWER_TIME_CAP_MS})), 0)::float8`;

function sydneyMidnight(day: string): Prisma.Sql {
  return Prisma.sql`(${day}::date::timestamp AT TIME ZONE ${STATS_TZ})`;
}

function sinceSql(scope: StatsScope, column = Prisma.sql`"timestamp"`): Prisma.Sql {
  const start = scope.sinceDay ?? periodStartDay(scope.period, scope.today);
  return start ? Prisma.sql`AND ${column} >= ${sydneyMidnight(start)}` : Prisma.empty;
}

function rotationSql(rotation: string | null, column = Prisma.sql`rotation`): Prisma.Sql {
  return rotation ? Prisma.sql`AND ${column} = ${rotation}` : Prisma.empty;
}

/** All history, or one window when `scope` is set, by Sydney day × rotation × kind. */
export async function loadDailyRows(db: StatsDb, userId: string, scope?: Pick<StatsScope, 'today' | 'period' | 'sinceDay'>): Promise<DailyRow[]> {
  const since = scope ? sinceSql({ today: scope.today, period: scope.period, rotation: null, sinceDay: scope.sinceDay }) : Prisma.empty;
  return db.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT to_char(("timestamp" AT TIME ZONE ${STATS_TZ})::date, 'YYYY-MM-DD') AS day,
           COALESCE(rotation, '') AS rotation,
           ${KIND_SQL} AS kind,
           COUNT(*)::int AS n, ${PASS_SQL} AS pass, ${SCORED_SQL} AS scored, ${MS_SQL} AS ms
    FROM "LearningEvent"
    WHERE "userId" = ${userId} AND "eventType" = ANY(${REVIEW_TYPES}::text[])
      ${since}
    GROUP BY 1, 2, 3
  `);
}

/**
 * Median answer time over scored answers (reveals excluded), each capped at 60s.
 * One grouped row. No predecessor window. The caller still requires 30 timed
 * answers before treating the median as evidence.
 */
export async function loadAnswerTiming(db: StatsDb, userId: string, scope: StatsScope): Promise<{ timed: number; medianSeconds: number | null }> {
  const rows = await db.$queryRaw<Array<{ timed: number; medianMs: number | null }>>(Prisma.sql`
    SELECT COUNT(*) FILTER (WHERE ${TIMED_SCORED_WHERE})::int AS timed,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY LEAST(GREATEST("responseMs", 0), ${ANSWER_TIME_CAP_MS}))
             FILTER (WHERE ${TIMED_SCORED_WHERE}) AS "medianMs"
    FROM "LearningEvent"
    WHERE "userId" = ${userId} AND "eventType" = ANY(${REVIEW_TYPES}::text[])
      ${sinceSql(scope)} ${rotationSql(scope.rotation)}
  `);
  const timed = rows[0]?.timed ?? 0;
  const medianMs = rows[0]?.medianMs;
  return { timed, medianSeconds: medianMs == null ? null : Number(medianMs) / 1000 };
}

/**
 * Anki daily load from the scheduled interval (nextDueAt − lastReview) on
 * cards the scheduler still has in play. Not derived from the due histogram.
 */
export async function loadDailyLoad(db: StatsDb, userId: string, rotation: string | null): Promise<number> {
  const join = rotation
    ? Prisma.sql`JOIN "Card" c ON c.id = cp."cardId" AND c.rotation = ${rotation}`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ load: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(1.0 / GREATEST(EXTRACT(EPOCH FROM (cp."nextDueAt" - cp."lastReview")) / 86400.0, 1)), 0)::float8 AS load
    FROM "CardProgress" cp ${join}
    WHERE cp."userId" = ${userId}
      AND cp.status <> 'retired' AND NOT cp.suppressed
      AND cp."totalReviews" > 0
      AND cp."lastReview" IS NOT NULL
      AND cp."nextDueAt" IS NOT NULL
  `);
  return Number(rows[0]?.load ?? 0);
}

export async function loadHourRows(db: StatsDb, userId: string, scope: StatsScope): Promise<HourRow[]> {
  return db.$queryRaw<HourRow[]>(Prisma.sql`
    SELECT EXTRACT(HOUR FROM "timestamp" AT TIME ZONE ${STATS_TZ})::int AS hour,
           COUNT(*)::int AS n, ${PASS_SQL} AS pass, ${SCORED_SQL} AS scored
    FROM "LearningEvent"
    WHERE "userId" = ${userId} AND "eventType" = ANY(${REVIEW_TYPES}::text[])
      ${sinceSql(scope)} ${rotationSql(scope.rotation)}
    GROUP BY 1
  `);
}

/**
 * Card reviews by stage, grade, spaced-review class and recency bucket. The
 * stage needs each review's predecessor on the same card, so the window runs
 * over the learner's whole card history (index: userId, sourceType,
 * sourceId); the rotation filter applies after it so a card's earlier reviews
 * still count. Recency is a Sydney civil-day difference, so daylight saving
 * cannot move a review between buckets.
 *
 * `spaced` marks the reviews the spaced-review pass rate counts: the card's
 * first review of its Sydney day whose previous review was at least a day
 * earlier, young or mature by that elapsed gap. A previous Again does not
 * exclude it (unlike the `relearn` stage). md3 stores no per-review scheduled
 * interval, so Anki's interval-based true retention cannot be reproduced.
 */
export async function loadStageRows(db: StatsDb, userId: string, scope: Pick<StatsScope, 'today' | 'rotation'>): Promise<StageRow[]> {
  return db.$queryRaw<StageRow[]>(Prisma.sql`
    WITH ev AS (
      SELECT "timestamp" AS ts, quality, "responseMs" AS ms, rotation,
             ("timestamp" AT TIME ZONE ${STATS_TZ})::date AS local_day,
             LAG("timestamp") OVER w AS prev_ts, LAG(quality) OVER w AS prev_q,
             ROW_NUMBER() OVER (PARTITION BY "sourceId", ("timestamp" AT TIME ZONE ${STATS_TZ})::date ORDER BY "timestamp", id) AS day_rank
      FROM "LearningEvent"
      WHERE "userId" = ${userId} AND "eventType" = 'card_reviewed' AND "sourceType" = 'card'
      WINDOW w AS (PARTITION BY "sourceId" ORDER BY "timestamp", id)
    )
    SELECT CASE
             WHEN prev_ts IS NULL THEN 'new'
             WHEN prev_q = 0 THEN 'relearn'
             WHEN ts - prev_ts < make_interval(days => ${LEARNING_MAX_DAYS}) THEN 'learning'
             WHEN ts - prev_ts < make_interval(days => ${MATURE_MIN_DAYS}) THEN 'young'
             ELSE 'mature'
           END AS stage,
           quality,
           CASE
             WHEN day_rank <> 1 OR prev_ts IS NULL OR ts - prev_ts < make_interval(days => ${LEARNING_MAX_DAYS}) THEN NULL
             WHEN ts - prev_ts < make_interval(days => ${MATURE_MIN_DAYS}) THEN 'young'
             ELSE 'mature'
           END AS spaced,
           CASE
             WHEN ${scope.today}::date - local_day <= 0 THEN 0
             WHEN ${scope.today}::date - local_day = 1 THEN 1
             WHEN ${scope.today}::date - local_day <= 6 THEN 2
             WHEN ${scope.today}::date - local_day <= 29 THEN 3
             WHEN ${scope.today}::date - local_day <= 364 THEN 4
             ELSE 5
           END AS bucket,
           COUNT(*)::int AS n,
           COALESCE(SUM(LEAST(GREATEST(ms, 0), ${ANSWER_TIME_CAP_MS})), 0)::float8 AS ms
    FROM ev
    WHERE TRUE ${rotationSql(scope.rotation)}
    GROUP BY 1, 2, 3, 4
  `);
}

/** Answers in the period by rotation × exam domain × kind; domains roll up into areas here. */
export async function loadAreaRows(db: StatsDb, userId: string, scope: StatsScope): Promise<AreaRow[]> {
  // An event written without a rotation belongs to its item's rotation; without
  // this fallback every such answer fell into one blank ("—") table.
  const rotation = Prisma.sql`COALESCE(NULLIF(e.rotation, ''), c.rotation, q.rotation, '')`;
  const rows = await db.$queryRaw<Array<{ rotation: string; domain: string | null; kind: ItemKind; n: number; pass: number; scored: number }>>(Prisma.sql`
    SELECT ${rotation} AS rotation,
           COALESCE(c."examDomain", q."examDomain") AS domain,
           CASE WHEN e."eventType" = 'card_reviewed' THEN 'card' ELSE 'mcq' END AS kind,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE (e."eventType" = 'card_reviewed' AND e.quality > 0) OR (e."eventType" = 'mcq_attempted' AND e."isCorrect"))::int AS pass,
           COUNT(*) FILTER (WHERE (e."eventType" = 'card_reviewed' AND e.quality IS NOT NULL) OR (e."eventType" = 'mcq_attempted' AND e."isCorrect" IS NOT NULL))::int AS scored
    FROM "LearningEvent" e
    LEFT JOIN "Card" c ON e."sourceType" = 'card' AND c.id = e."sourceId"
    LEFT JOIN "Question" q ON e."sourceType" = 'question' AND q.id = e."sourceId"
    WHERE e."userId" = ${userId} AND e."eventType" = ANY(${REVIEW_TYPES}::text[])
      ${sinceSql(scope, Prisma.sql`e."timestamp"`)} ${rotationSql(scope.rotation, rotation)}
    GROUP BY 1, 2, 3
  `);
  return rollUpAreas(rows);
}

export function rollUpAreas(rows: ReadonlyArray<{ rotation: string; domain: string | null; kind: ItemKind; n: number; pass: number; scored: number }>): AreaRow[] {
  const byKey = new Map<string, AreaRow>();
  for (const r of rows) {
    const area = areaForItem(r.rotation, r.domain);
    const key = `${r.rotation}\u0000${area}\u0000${r.kind}`;
    const row = byKey.get(key) ?? { rotation: r.rotation, area, kind: r.kind, n: 0, pass: 0, scored: 0 };
    row.n += r.n; row.pass += r.pass; row.scored += r.scored;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

/**
 * Card state now, as five histograms in one pass (GROUPING SETS): state,
 * scheduled interval, stability, retrievability now and due day.
 * Retrievability follows md3's decay model, R = R0 · (1 + t/S)^-0.5
 * (docs/MATH_MODEL.md §3).
 */
export async function loadProgressRows(db: StatsDb, userId: string, scope: Pick<StatsScope, 'today' | 'rotation'>): Promise<ProgressRow[]> {
  // Code constants, not input: inlined so the array has a type without a parameter cast.
  const edges = Prisma.raw(`ARRAY[${INTERVAL_EDGES.join(', ')}]::float8[]`);
  const join = scope.rotation
    ? Prisma.sql`JOIN "Card" c ON c.id = cp."cardId" AND c.rotation = ${scope.rotation}`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ set: ProgressSet; key: string | null; n: number }>>(Prisma.sql`
    WITH p AS (
      SELECT cp."totalReviews" AS tr, cp.suppressed, cp.status, cp."stabilityDays" AS s,
             cp."nextDueAt" AS due, cp."lastReview" AS lr, cp."retrievalStrength" AS r0
      FROM "CardProgress" cp ${join}
      WHERE cp."userId" = ${userId}
    ), st AS (
      SELECT *, CASE
                  WHEN status = 'retired' OR suppressed THEN 'retired'
                  WHEN tr = 0 OR lr IS NULL THEN 'new'
                  WHEN due - lr < make_interval(days => ${LEARNING_MAX_DAYS}) THEN 'learning'
                  WHEN due - lr < make_interval(days => ${MATURE_MIN_DAYS}) THEN 'young'
                  ELSE 'mature'
                END AS state
      FROM p
    ), q AS (
      SELECT state,
             CASE WHEN state IN ('learning', 'young', 'mature')
                  THEN width_bucket(EXTRACT(EPOCH FROM (due - lr)) / 86400.0, ${edges}) END AS ivl_b,
             CASE WHEN state IN ('learning', 'young', 'mature')
                  THEN width_bucket(s::float8, ${edges}) END AS stab_b,
             CASE WHEN state IN ('learning', 'young', 'mature')
                  THEN LEAST(10, GREATEST(0, floor(10 * r0 * power(1 + GREATEST(0, EXTRACT(EPOCH FROM (now() - lr)) / 86400.0) / GREATEST(s, 0.01), -0.5))))::int END AS r_b,
             CASE WHEN state IN ('learning', 'young', 'mature')
                  THEN CASE
                         WHEN due < now() THEN 'overdue'
                         -- Sydney civil date, not elapsed seconds: DST-safe.
                         WHEN (due AT TIME ZONE ${STATS_TZ})::date - ${scope.today}::date <= ${FORECAST_DAYS}
                           THEN to_char((due AT TIME ZONE ${STATS_TZ})::date, 'YYYY-MM-DD')
                       END END AS due_d
      FROM st
    )
    SELECT CASE
             WHEN GROUPING(state) = 0 THEN 'state'
             WHEN GROUPING(ivl_b) = 0 THEN 'interval'
             WHEN GROUPING(stab_b) = 0 THEN 'stability'
             WHEN GROUPING(r_b) = 0 THEN 'retrievability'
             ELSE 'due'
           END AS set,
           COALESCE(state, ivl_b::text, stab_b::text, r_b::text, due_d) AS key,
           COUNT(*)::int AS n
    FROM q
    GROUP BY GROUPING SETS ((state), (ivl_b), (stab_b), (r_b), (due_d))
  `);
  return rows.filter((r): r is ProgressRow => r.key !== null);
}

interface ScoreJson { correct?: unknown; total?: unknown }
function readByArea(value: unknown): PracticeSitting['byArea'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out: PracticeSitting['byArea'] = [];
  for (const [area, raw] of Object.entries(value as Record<string, ScoreJson>)) {
    const correct = Number(raw?.correct);
    const total = Number(raw?.total);
    if (Number.isInteger(correct) && Number.isInteger(total) && total > 0 && correct >= 0 && correct <= total) {
      out.push({ area, correct, total });
    }
  }
  return out;
}

/** Submitted public practice-paper sittings, newest first, scored as the server recorded them. */
export async function loadPracticeSittings(db: StatsDb, userId: string): Promise<PracticeSitting[]> {
  const rows = await db.$queryRaw<Array<{ id: string; rotation: string; title: string; submittedAt: Date; result: unknown }>>(Prisma.sql`
    SELECT id, rotation,
           COALESCE(paper->>'paperTitle', paper->>'paperId', 'Practice paper') AS title,
           "submittedAt", result
    FROM "ExamPaperSession"
    WHERE "userId" = ${userId} AND "submittedAt" IS NOT NULL AND paper->>'schema' = ${PRACTICE_SITTING_SCHEMA}
    ORDER BY "submittedAt" DESC
    LIMIT ${PRACTICE_LIMIT}
  `);
  return rows.flatMap((r): PracticeSitting[] => {
    const result = (r.result && typeof r.result === 'object' ? r.result : {}) as Record<string, unknown>;
    const correct = Number(result.correct);
    const total = Number(result.total);
    if (!Number.isInteger(correct) || !Number.isInteger(total) || total <= 0) return [];
    const answered = Number.isInteger(Number(result.answered)) ? Number(result.answered) : total;
    return [{
      id: r.id,
      rotation: r.rotation,
      title: r.title,
      submittedAt: new Date(r.submittedAt).toISOString(),
      correct,
      total,
      answered,
      byArea: readByArea(result.byArea),
    }];
  });
}

export async function loadExamResults(db: StatsDb, userId: string): Promise<ExamResultView[]> {
  const rows = await db.$queryRaw<Array<Parameters<typeof toExamResultView>[0]>>(Prisma.sql`
    SELECT id, rotation, block, "examDate", score, correct, total, areas, recalled, source
    FROM "ExamResult"
    WHERE "userId" = ${userId}
    ORDER BY "examDate" DESC
    LIMIT ${EXAM_RESULT_LIMIT}
  `);
  return rows.map((row) => toExamResultView(row, resolveStoredArea));
}

export async function loadExperience(db: StatsDb, userId: string): Promise<unknown> {
  const rows = await db.$queryRaw<Array<{ experience: unknown }>>(Prisma.sql`
    SELECT experience FROM "User" WHERE id = ${userId} LIMIT 1
  `);
  return rows[0]?.experience ?? null;
}

export { formAreas, UNASSIGNED_AREA };
export type { Stage };
