/**
 * Statistics page: pure aggregation over rows the database has already
 * counted (src/lib/stats/stats-query.server.ts). No Prisma, no clock: every
 * function takes `today` and plain rows, so each instrument is unit-tested.
 *
 * Definitions, Anki's where md3 has the data:
 *  - A review is an answered card (`card_reviewed`) or MCQ (`mcq_attempted`).
 *  - A card review passes unless graded Again (quality 0); Hard counts as a
 *    pass, as in Anki's true retention. An MCQ passes when answered correctly;
 *    a skipped MCQ is not scored.
 *  - Stage of a card review comes from the gap since that card's previous
 *    review: first review = new, previous grade Again = relearn, under a day
 *    = learning, under 21 days = young, otherwise mature. md3 stores no
 *    per-review interval, so the elapsed gap stands in for Anki's last interval.
 *  - Stage of a card now comes from its scheduled interval
 *    (nextDueAt − lastReview): under a day learning, under 21 days young,
 *    otherwise mature (Anki's threshold).
 *
 * No function here predicts an exam score. Exam results are shown beside md3
 * accuracy, never derived from it.
 */

import { practicePaperDisplayName } from './practice-paper-name';
import { formatCivilDate } from './civil-date';
import { displayedPracticeTotal } from './practice-denominator';

export { formatCivilDate };

export const STATS_PERIODS = ['7d', '30d', '1y', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
export const DEFAULT_PERIOD: StatsPeriod = '30d';
export const PERIOD_LABELS: Record<StatsPeriod, string> = { '7d': '7d', '30d': '30d', '1y': '1y', all: 'All' };
const PERIOD_DAYS: Record<Exclude<StatsPeriod, 'all'>, number> = { '7d': 7, '30d': 30, '1y': 365 };

export const LEARNING_MAX_DAYS = 1;
export const MATURE_MIN_DAYS = 21;
/** Anki caps a single answer's time at 60 s so a walk-away does not count. */
export const ANSWER_TIME_CAP_MS = 60_000;
export const FORECAST_DAYS = 30;

export const STAGES = ['new', 'learning', 'relearn', 'young', 'mature'] as const;
export type Stage = (typeof STAGES)[number];
export const CARD_STATES = ['new', 'learning', 'young', 'mature', 'retired'] as const;
export type CardState = (typeof CARD_STATES)[number];
export type ItemKind = 'card' | 'mcq';

/** Days, upper-exclusive edges; SQL buckets with width_bucket on the same array. */
export const INTERVAL_EDGES = [1, 2, 3, 5, 7, 10, 14, 21, 30, 60, 90, 180, 365] as const;
export const RETRIEVABILITY_BUCKETS = 10;

/** Recency buckets the stage query assigns; ranges are unions of these. */
export const RECENCY = { today: 0, yesterday: 1, week: 2, month: 3, year: 4, older: 5 } as const;
const PERIOD_MAX_BUCKET: Record<StatsPeriod, number> = { '7d': 2, '30d': 3, '1y': 4, all: 5 };

export function parsePeriod(value: unknown): StatsPeriod {
  return typeof value === 'string' && (STATS_PERIODS as readonly string[]).includes(value)
    ? (value as StatsPeriod)
    : DEFAULT_PERIOD;
}

const MS_PER_DAY = 86_400_000;
function dayMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
export function addDays(iso: string, days: number): string {
  return new Date(dayMs(iso) + days * MS_PER_DAY).toISOString().slice(0, 10);
}
/** First day inside the period, or null for all history. */
export function periodStartDay(period: StatsPeriod, today: string): string | null {
  return period === 'all' ? null : addDays(today, -(PERIOD_DAYS[period] - 1));
}

/** `YYYY-MM-DD` in Australia/Sydney. */
export function sydneyDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

const SYDNEY_TZ = 'Australia/Sydney';

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  let year = Number(pick('year'));
  let month = Number(pick('month'));
  let day = Number(pick('day'));
  let hour = Number(pick('hour'));
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  const asUtc = Date.UTC(year, month - 1, day, hour, Number(pick('minute')), Number(pick('second')));
  return asUtc - instant.getTime();
}

/**
 * UTC instant of midnight at the start of a Sydney civil day.
 * The next civil midnight is 23, 24, or 25 hours later across a DST change.
 */
export function sydneyCivilStart(day: string): Date {
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  let instant = new Date(utcMidnight.getTime() - timeZoneOffsetMs(utcMidnight, SYDNEY_TZ));
  for (let pass = 0; pass < 2; pass += 1) {
    const next = new Date(utcMidnight.getTime() - timeZoneOffsetMs(instant, SYDNEY_TZ));
    if (next.getTime() === instant.getTime()) break;
    instant = next;
  }
  return instant;
}

/** Exclusive end of a Sydney civil day: midnight at the start of the next date. */
export function sydneyCivilEnd(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  return sydneyCivilStart(next);
}

export function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

// ---------------------------------------------------------------------------
// Daily rows: today, reviews per day, cloze vs MCQ
// ---------------------------------------------------------------------------

export interface DailyRow {
  /** `YYYY-MM-DD`, Australia/Sydney. */
  day: string;
  rotation: string;
  kind: ItemKind;
  n: number;
  pass: number;
  scored: number;
  /** Answer time, each answer capped at ANSWER_TIME_CAP_MS. */
  ms: number;
}

export function rotationsIn(rows: readonly DailyRow[]): string[] {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.rotation, (totals.get(r.rotation) ?? 0) + r.n);
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([rotation]) => rotation);
}

export function filterRotation<T extends { rotation: string }>(rows: readonly T[], rotation: string | null): T[] {
  return rotation ? rows.filter((r) => r.rotation === rotation) : [...rows];
}

/** One count per day, for the calendar and the bar chart. */
export function dayCounts(rows: readonly DailyRow[]): Array<{ date: string; count: number }> {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.n);
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

/**
 * Minutes per day for the dates asked for. `ms` is already capped per answer
 * (ANSWER_TIME_CAP_MS) by the statistics query. A date with no rows is 0.
 */
export function minutesPerDay(rows: readonly DailyRow[], dates: readonly string[]): Array<{ date: string; minutes: number }> {
  const ms = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.ms) || row.ms <= 0) continue;
    ms.set(row.day, (ms.get(row.day) ?? 0) + row.ms);
  }
  return dates.map((date) => ({ date, minutes: (ms.get(date) ?? 0) / 60_000 }));
}

export interface TodaySummary {
  reviews: number;
  cards: number;
  mcqs: number;
  minutes: number;
  accuracyPct: number | null;
  /** Average seconds per answer. */
  secondsPerAnswer: number | null;
}

export function buildToday(rows: readonly DailyRow[], today: string): TodaySummary {
  let cards = 0, mcqs = 0, pass = 0, scored = 0, ms = 0;
  for (const r of rows) {
    if (r.day !== today) continue;
    if (r.kind === 'card') cards += r.n; else mcqs += r.n;
    pass += r.pass;
    scored += r.scored;
    ms += r.ms;
  }
  const reviews = cards + mcqs;
  return {
    reviews,
    cards,
    mcqs,
    minutes: Math.round(ms / 60_000),
    accuracyPct: pct(pass, scored),
    secondsPerAnswer: reviews > 0 ? ms / reviews / 1000 : null,
  };
}

export type KindWindow = 'today' | '7d' | '30d' | '1y' | 'all';
export interface KindAccuracyCell { n: number; scored: number; pct: number | null }
export interface KindAccuracyRow { kind: ItemKind; cells: Record<KindWindow, KindAccuracyCell> }

export function buildKindAccuracy(rows: readonly DailyRow[], today: string): KindAccuracyRow[] {
  const ranges: Record<KindWindow, string> = {
    today,
    '7d': addDays(today, -6),
    '30d': addDays(today, -29),
    '1y': addDays(today, -364),
    all: '',
  };
  return (['card', 'mcq'] as const).map((kind) => {
    const cells = {} as KindAccuracyRow['cells'];
    for (const [key, from] of Object.entries(ranges) as Array<[KindWindow, string]>) {
      let n = 0, pass = 0, scored = 0;
      for (const r of rows) {
        if (r.kind !== kind || r.day < from || r.day > today) continue;
        n += r.n; pass += r.pass; scored += r.scored;
      }
      cells[key] = { n, scored, pct: pct(pass, scored) };
    }
    return { kind, cells };
  });
}

// ---------------------------------------------------------------------------
// Hour of day
// ---------------------------------------------------------------------------

export interface HourRow { hour: number; n: number; pass: number; scored: number }
export interface HourCell { hour: number; n: number; pct: number | null }

export function buildHourly(rows: readonly HourRow[]): HourCell[] {
  const cells: HourCell[] = Array.from({ length: 24 }, (_, hour) => ({ hour, n: 0, pct: null }));
  const pass = new Array<number>(24).fill(0);
  const scored = new Array<number>(24).fill(0);
  for (const r of rows) {
    if (!Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) continue;
    cells[r.hour].n += r.n;
    pass[r.hour] += r.pass;
    scored[r.hour] += r.scored;
  }
  for (const c of cells) c.pct = pct(pass[c.hour], scored[c.hour]);
  return cells;
}

// ---------------------------------------------------------------------------
// Card review stages: reviews by stage, answer buttons, true retention
// ---------------------------------------------------------------------------

export interface StageRow {
  stage: Stage;
  /** 0 Again, 1 Hard, 3 Good, 5 Easy (md3's quality scale); null if missing. */
  quality: number | null;
  bucket: number;
  /**
   * Spaced-review class: 'young' or 'mature' when this is the card's first
   * review of its Sydney day and the previous review was at least a day
   * earlier (mature when that gap is 21 days or more); otherwise null.
   */
  spaced: 'young' | 'mature' | null;
  n: number;
  ms: number;
}

export const GRADES = [
  { id: 'again', label: 'Again', test: (q: number) => q <= 0 },
  { id: 'hard', label: 'Hard', test: (q: number) => q > 0 && q < 3 },
  { id: 'good', label: 'Good', test: (q: number) => q >= 3 && q < 5 },
  { id: 'easy', label: 'Easy', test: (q: number) => q >= 5 },
] as const;
export type GradeId = (typeof GRADES)[number]['id'];

export function gradeOf(quality: number | null): GradeId | null {
  if (quality === null || !Number.isFinite(quality)) return null;
  return GRADES.find((g) => g.test(quality))?.id ?? null;
}

export interface StageSummary { stage: Stage; n: number; minutes: number; passPct: number | null }

export function buildStages(rows: readonly StageRow[], period: StatsPeriod): StageSummary[] {
  const max = PERIOD_MAX_BUCKET[period];
  return STAGES.map((stage) => {
    let n = 0, ms = 0, pass = 0, scored = 0;
    for (const r of rows) {
      if (r.stage !== stage || r.bucket > max) continue;
      n += r.n;
      ms += r.ms;
      if (r.quality !== null) { scored += r.n; if (r.quality > 0) pass += r.n; }
    }
    return { stage, n, minutes: Math.round(ms / 60_000), passPct: pct(pass, scored) };
  });
}

export type ButtonRow = { stage: 'learning' | 'young' | 'mature'; counts: Record<GradeId, number>; total: number };

/** Anki groups new, learning and relearning answers together as "learning". */
export function buildButtons(rows: readonly StageRow[], period: StatsPeriod): ButtonRow[] {
  const max = PERIOD_MAX_BUCKET[period];
  const group = (s: Stage): ButtonRow['stage'] => (s === 'young' || s === 'mature' ? s : 'learning');
  const out: ButtonRow[] = (['learning', 'young', 'mature'] as const).map((stage) => ({
    stage, counts: { again: 0, hard: 0, good: 0, easy: 0 }, total: 0,
  }));
  for (const r of rows) {
    if (r.bucket > max) continue;
    const grade = gradeOf(r.quality);
    if (!grade) continue;
    const row = out.find((b) => b.stage === group(r.stage))!;
    row.counts[grade] += r.n;
    row.total += r.n;
  }
  return out;
}

export interface RetentionCell { pass: number; fail: number; pct: number | null }
export interface RetentionRow { range: string; young: RetentionCell; mature: RetentionCell; total: RetentionCell }

const RETENTION_RANGES: Array<{ range: string; buckets: number[] }> = [
  { range: 'Today', buckets: [0] },
  { range: 'Yesterday', buckets: [1] },
  { range: 'Last week', buckets: [0, 1, 2] },
  { range: 'Last month', buckets: [0, 1, 2, 3] },
  { range: 'Last year', buckets: [0, 1, 2, 3, 4] },
  { range: 'All time', buckets: [0, 1, 2, 3, 4, 5] },
];

/**
 * Spaced-review pass rate: of each card's first review on a Sydney day whose
 * previous review was at least a day earlier, the share not graded Again,
 * split young / mature by that elapsed gap (mature ≥ 21 days). A previous
 * Again does not exclude a review. This is NOT Anki's true retention: md3
 * stores no per-review scheduled interval, so the elapsed gap stands in for it.
 */
export const SPACED_REVIEW_DEFINITION =
  'First review of each card per Sydney day, previous review at least a day earlier; young under 21 days since that review, mature 21 or more; pass = not graded Again.';

export function buildRetention(rows: readonly StageRow[]): RetentionRow[] {
  return RETENTION_RANGES.map(({ range, buckets }) => {
    const cell = (classes: Array<'young' | 'mature'>): RetentionCell => {
      let pass = 0, fail = 0;
      for (const r of rows) {
        if (!r.spaced || !classes.includes(r.spaced) || !buckets.includes(r.bucket) || r.quality === null) continue;
        if (r.quality > 0) pass += r.n; else fail += r.n;
      }
      return { pass, fail, pct: pct(pass, pass + fail) };
    };
    return { range, young: cell(['young']), mature: cell(['mature']), total: cell(['young', 'mature']) };
  });
}

// ---------------------------------------------------------------------------
// Card state now: counts, forecast, interval / stability / retrievability
// ---------------------------------------------------------------------------

export type ProgressSet = 'state' | 'interval' | 'stability' | 'retrievability' | 'due';
export interface ProgressRow { set: ProgressSet; key: string; n: number }

export function buildCardCounts(rows: readonly ProgressRow[]): Record<CardState, number> {
  const out = { new: 0, learning: 0, young: 0, mature: 0, retired: 0 } as Record<CardState, number>;
  for (const r of rows) {
    if (r.set === 'state' && (CARD_STATES as readonly string[]).includes(r.key)) out[r.key as CardState] += r.n;
  }
  return out;
}

export interface Forecast {
  overdue: number;
  /** Index 0 = due later today, 1 = tomorrow … FORECAST_DAYS. */
  days: number[];
  next7: number;
  next30: number;
}

/** Whole Sydney civil days from `from` to `to` (both `YYYY-MM-DD`); DST cannot shift it. */
export function civilDayDiff(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / MS_PER_DAY);
}

/**
 * Due rows are keyed 'overdue' or by the Sydney date the card falls due
 * (the query converts with AT TIME ZONE), so the offset is a civil-date
 * difference, correct across daylight-saving changes.
 */
export function buildForecast(rows: readonly ProgressRow[], today: string): Forecast {
  const days = new Array<number>(FORECAST_DAYS + 1).fill(0);
  let overdue = 0;
  for (const r of rows) {
    if (r.set !== 'due') continue;
    if (r.key === 'overdue') { overdue += r.n; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.key)) continue;
    const k = civilDayDiff(today, r.key);
    if (k < 0) overdue += r.n;
    else if (k <= FORECAST_DAYS) days[k] += r.n;
  }
  const sum = (to: number) => days.slice(0, to + 1).reduce((a, b) => a + b, 0);
  return { overdue, days, next7: sum(7), next30: sum(FORECAST_DAYS) };
}

/**
 * Anki's daily load: sum over eligible scheduled cards of 1/max(intervalDays, 1).
 * `intervalDays` is the scheduler interval (next due minus last review), not a
 * count of cards on a due-date histogram. An interval under a day counts as one
 * day, so a stack of cards due tomorrow is the size of the stack.
 */
export function dailyLoad(intervalDays: readonly number[]): number {
  let sum = 0;
  for (const days of intervalDays) {
    if (!Number.isFinite(days)) continue;
    sum += 1 / Math.max(days, 1);
  }
  return sum;
}

export interface HistogramBin { label: string; n: number }

export function intervalLabel(index: number): string {
  if (index <= 0) return '<1d';
  if (index >= INTERVAL_EDGES.length) return `${INTERVAL_EDGES[INTERVAL_EDGES.length - 1]}d+`;
  return `${INTERVAL_EDGES[index - 1]}d`;
}

/** width_bucket returns 0 below the first edge and N at or above the last. */
export function buildDayHistogram(rows: readonly ProgressRow[], set: 'interval' | 'stability'): HistogramBin[] {
  const bins = Array.from({ length: INTERVAL_EDGES.length + 1 }, (_, i) => ({ label: intervalLabel(i), n: 0 }));
  for (const r of rows) {
    if (r.set !== set) continue;
    const i = Number(r.key);
    if (Number.isInteger(i) && i >= 0 && i < bins.length) bins[i].n += r.n;
  }
  return bins;
}

export function buildRetrievabilityHistogram(rows: readonly ProgressRow[]): HistogramBin[] {
  const bins = Array.from({ length: RETRIEVABILITY_BUCKETS }, (_, i) => ({ label: `${i * 10}%`, n: 0 }));
  for (const r of rows) {
    if (r.set !== 'retrievability') continue;
    const i = Math.min(RETRIEVABILITY_BUCKETS - 1, Number(r.key));
    if (Number.isInteger(i) && i >= 0) bins[i].n += r.n;
  }
  return bins;
}

/** Weighted mean of a bucketed histogram, using each bucket's midpoint in %. */
export function meanRetrievability(bins: readonly HistogramBin[]): number | null {
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (total === 0) return null;
  return bins.reduce((a, b, i) => a + b.n * (i * 10 + 5), 0) / total;
}

/**
 * Estimated total knowledge: how many of the scheduled cards the learner would
 * recall today, Anki's sum of current retrievability. The statistics page
 * holds retrievability as deciles, so each card counts as its bucket midpoint
 * (5%, 15%, … 95%). 100% is folded into the top decile, the same way
 * meanRetrievability does. Null when no scheduled card is in the histogram.
 */
export function estimatedKnowledgeFromHistogram(bins: readonly HistogramBin[]): number | null {
  const cards = bins.reduce((sum, bin) => sum + bin.n, 0);
  const mean = meanRetrievability(bins);
  if (cards === 0 || mean == null) return null;
  return (mean / 100) * cards;
}

/** Last 30 finite daily estimates. Null until two points exist — no trend to draw. */
export function knowledgeSparkline(series: readonly number[] | null | undefined): number[] | null {
  if (!series) return null;
  const points = series.filter((value) => Number.isFinite(value)).slice(-30);
  return points.length >= 2 ? points : null;
}

// ---------------------------------------------------------------------------
// Blueprint areas: md3 accuracy, practice papers, the real exam
// ---------------------------------------------------------------------------

export interface AreaRow { rotation: string; area: string; kind: ItemKind; n: number; pass: number; scored: number }
export interface AreaScore { area: string; correct: number; total: number }
export interface PracticeSitting {
  id: string;
  rotation: string;
  title: string;
  /** ISO timestamp. */
  submittedAt: string;
  correct: number;
  total: number;
  answered: number;
  byArea: AreaScore[];
}
export interface ExamResultView {
  id: string;
  rotation: string;
  block: number;
  /** `YYYY-MM-DD`. */
  examDate: string;
  score: number;
  correct: number | null;
  total: number | null;
  areas: AreaScore[];
  recalled: string | null;
  source: string;
}

export interface Fraction { correct: number; total: number; pct: number | null }
export interface AreaTableRow {
  /** Canonical area ID, or `custom:<label>` for a learner-entered area. */
  area: string;
  /** Display label: code-owned for canonical areas, learner text when custom. */
  label: string;
  custom: boolean;
  /** n: answer events (skips included); scored: answered items, the md3 % denominator. */
  md3: { n: number; scored: number; pct: number | null; cardPct: number | null; mcqPct: number | null };
  practice: Fraction | null;
  exam: Fraction | null;
  /** exam% − md3% in percentage points, when both exist. */
  gap: number | null;
}
export interface AreaTable {
  rotation: string;
  exam: ExamResultView | null;
  rows: AreaTableRow[];
  /** Blueprint areas with no md3, practice or exam data, in blueprint order. */
  missing: Array<{ area: string; label: string }>;
  /** md3 accuracy over every scored answer in the rotation. */
  md3Overall: number | null;
}

const frac = (correct: number, total: number): Fraction => ({ correct, total, pct: pct(correct, total) });

/**
 * One table per rotation with any md3 answers, practice sittings or a recorded
 * exam. Rows follow the blueprint's order, then any other area, Unassigned last.
 */
export function buildAreaTables(input: {
  areaRows: readonly AreaRow[];
  practice: readonly PracticeSitting[];
  exams: readonly ExamResultView[];
  /** Area IDs in blueprint order. */
  blueprintAreas: (rotation: string) => string[];
  areaLabel: (rotation: string, key: string) => string;
  /** Normalises a practice scorer's byArea label (e.g. a PAAM leaf domain) to an area ID. */
  practiceArea: (rotation: string, label: string) => string;
  isCustom: (key: string) => boolean;
  rotation: string | null;
  unassigned: string;
}): AreaTable[] {
  const rotations = new Set<string>();
  for (const r of input.areaRows) rotations.add(r.rotation);
  for (const p of input.practice) rotations.add(p.rotation);
  for (const e of input.exams) rotations.add(e.rotation);
  const wanted = [...rotations].filter((r) => !input.rotation || r === input.rotation).sort();

  return wanted.map((rotation) => {
    const exam = [...input.exams]
      .filter((e) => e.rotation === rotation)
      .sort((a, b) => b.examDate.localeCompare(a.examDate))[0] ?? null;
    const md3 = new Map<string, { n: number; pass: number; scored: number; cp: number; cs: number; mp: number; ms: number }>();
    for (const r of input.areaRows) {
      if (r.rotation !== rotation) continue;
      const m = md3.get(r.area) ?? { n: 0, pass: 0, scored: 0, cp: 0, cs: 0, mp: 0, ms: 0 };
      m.n += r.n; m.pass += r.pass; m.scored += r.scored;
      if (r.kind === 'card') { m.cp += r.pass; m.cs += r.scored; } else { m.mp += r.pass; m.ms += r.scored; }
      md3.set(r.area, m);
    }
    const practice = new Map<string, { correct: number; total: number }>();
    for (const s of input.practice) {
      if (s.rotation !== rotation || !isCompleteSitting(s.answered, s.total)) continue;
      for (const a of s.byArea) {
        const key = input.practiceArea(rotation, a.area);
        const p = practice.get(key) ?? { correct: 0, total: 0 };
        p.correct += a.correct; p.total += a.total;
        practice.set(key, p);
      }
    }
    const examByArea = new Map((exam?.areas ?? []).map((a) => [a.area, a]));

    const order = input.blueprintAreas(rotation);
    const seen = new Set<string>([...order, ...md3.keys(), ...practice.keys(), ...examByArea.keys()]);
    const rest = [...seen].filter((a) => !order.includes(a) && a !== input.unassigned).sort();
    const areas = [...order, ...rest, ...(seen.has(input.unassigned) ? [input.unassigned] : [])]
      .filter((a) => md3.has(a) || practice.has(a) || examByArea.has(a));

    const rows = areas.map((area): AreaTableRow => {
      const m = md3.get(area);
      const p = practice.get(area);
      const e = examByArea.get(area);
      const md3Pct = m ? pct(m.pass, m.scored) : null;
      const examFrac = e ? frac(e.correct, e.total) : null;
      return {
        area,
        label: input.areaLabel(rotation, area),
        custom: input.isCustom(area),
        md3: { n: m?.n ?? 0, scored: m?.scored ?? 0, pct: md3Pct, cardPct: m ? pct(m.cp, m.cs) : null, mcqPct: m ? pct(m.mp, m.ms) : null },
        practice: p ? frac(p.correct, p.total) : null,
        exam: examFrac,
        gap: examFrac?.pct != null && md3Pct != null ? examFrac.pct - md3Pct : null,
      };
    });
    let pass = 0, scored = 0;
    for (const m of md3.values()) { pass += m.pass; scored += m.scored; }
    const missing = order.filter((a) => !areas.includes(a)).map((area) => ({ area, label: input.areaLabel(rotation, area) }));
    return { rotation, exam, rows, missing, md3Overall: pct(pass, scored) };
  });
}

/** A sitting counts as a score once this share of the paper has an answer. */
export const COMPLETE_SITTING_MIN_FRACTION = 0.8;

export function isCompleteSitting(answered: number, total: number): boolean {
  return total > 0 && answered / total >= COMPLETE_SITTING_MIN_FRACTION;
}

export function partialSittingNote(answered: number, total: number): string {
  return `${answered} of ${total} answered`;
}

export interface PracticeListRow {
  id: string;
  rotation: string;
  title: string;
  /** Sydney civil day, `YYYY-MM-DD`. */
  date: string;
  correct: number;
  total: number;
  answered: number;
  /** Denominator shown beside the score (displayedPracticeTotal). */
  outOf: number;
  complete: boolean;
  /** Set when any question was left blank; the only text on a too-short sitting. */
  note: string | null;
  pct: number | null;
}

export function buildPracticeList(sittings: readonly PracticeSitting[], rotation: string | null, limit = 12): PracticeListRow[] {
  return [...sittings]
    .filter((s) => !rotation || s.rotation === rotation)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .slice(0, limit)
    .map((s) => {
      const complete = isCompleteSitting(s.answered, s.total);
      // Same denominator as the practice results screen: answered questions
      // when some were left blank, with the blank count kept in the note.
      const outOf = displayedPracticeTotal({ total: s.total, answered: s.answered });
      return {
        id: s.id,
        rotation: s.rotation,
        title: practicePaperDisplayName({ title: s.title, rotation: s.rotation }),
        date: sydneyDay(new Date(s.submittedAt)),
        correct: s.correct,
        total: s.total,
        answered: s.answered,
        outOf,
        complete,
        note: s.answered < s.total ? partialSittingNote(s.answered, s.total) : null,
        pct: complete ? pct(s.correct, outOf) : null,
      };
    });
}
