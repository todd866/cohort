/**
 * Assembles the statistics page and the Exam gaps page from the grouped
 * reads in ./stats-query.server. One Promise.all per page: the reads run
 * together, and each returns at most a few hundred grouped rows.
 */
import { USYD_MD3_2026 } from '@/lib/curriculum/usyd-md3-2026';
import { buildHeatmap, dateRange, summarise, type HeatmapCell, type ReviewSummary } from '@/lib/review-stats';
import { blocksFromPeriods, calendarHistoryStart, labelBlocks, type LabeledBlock } from './calendar-grid';
import { areaForLabel, areaLabel, blueprintAreaIds, blueprintRotations, isCustomArea, UNASSIGNED_AREA } from './blueprint-areas';
import { AREA_ACCURACY_PERIOD } from './area-chart';
import { applyStatsLayout, statsLayoutFromExperience, type AppliedStatsLayout } from './stats-layout';
import {
  buildAreaTables,
  buildButtons,
  buildCardCounts,
  buildDayHistogram,
  buildForecast,
  buildHourly,
  buildKindAccuracy,
  buildPracticeList,
  minutesPerDay,
  buildRetention,
  buildRetrievabilityHistogram,
  buildStages,
  buildToday,
  dayCounts,
  filterRotation,
  periodStartDay,
  rotationsIn,
  type AreaRow,
  type AreaTable,
  type ButtonRow,
  type CardState,
  type ExamResultView,
  type Forecast,
  type HistogramBin,
  type HourCell,
  type KindAccuracyRow,
  type PracticeListRow,
  type PracticeSitting,
  type RetentionRow,
  type StageSummary,
  type StatsPeriod,
  type TodaySummary,
} from './stats-model';
import {
  loadAreaRows,
  loadAnswerTiming,
  loadDailyLoad,
  loadDailyRows,
  loadExamResults,
  loadExperience,
  loadHourRows,
  loadPracticeSittings,
  loadProgressRows,
  loadStageRows,
  sydneyDay,
  type StatsDb,
} from './stats-query.server';

export interface StatsPagePayload {
  today: string;
  period: StatsPeriod;
  rotation: string | null;
  rotations: string[];
  hasHistory: boolean;
  layout: AppliedStatsLayout;
  todaySummary: TodaySummary;
  periodSummary: ReviewSummary;
  forecast: Forecast;
  heatmap: HeatmapCell[];
  /** Teaching blocks labelled with the rotation this learner did in each. */
  calendarBlocks: LabeledBlock[];
  daily: Array<{ date: string; count: number }>;
  /** Minutes of capped answer time per day in the selected period. */
  reviewMinutes: Array<{ date: string; minutes: number }>;
  stages: StageSummary[];
  cardCounts: Record<CardState, number>;
  intervals: HistogramBin[];
  stability: HistogramBin[];
  retrievability: HistogramBin[];
  retention: RetentionRow[];
  hourly: HourCell[];
  buttons: ButtonRow[];
  kinds: KindAccuracyRow[];
  /** Median of non-null capped answer times in the selected period. */
  answerTiming: { timed: number; medianSeconds: number | null };
  /** Anki daily load from scheduled intervals, not the due histogram. */
  dailyLoad: number;
  areaTables: AreaTable[];
  /** Rotations with an exam blueprint, in course order: the area chart's tabs. */
  areaRotations: string[];
  practice: PracticeListRow[];
  exams: ExamResultView[];
}

export const HEATMAP_MAX_DAYS = 371;

/** The area taxonomy hooks buildAreaTables needs, bound to the registered blueprints. */
export const AREA_FNS = {
  blueprintAreas: (rotation: string) => blueprintAreaIds(rotation),
  areaLabel: (rotation: string, key: string) => areaLabel(rotation, key),
  practiceArea: (rotation: string, label: string) => areaForLabel(rotation, label),
  isCustom: isCustomArea,
};

/**
 * md3 accuracy per blueprint area, for Statistics and Exam gaps alike: one
 * read over one window (AREA_ACCURACY_PERIOD), whatever period the Statistics
 * page is showing, so the two pages can never print different md3 numbers for
 * the same area. Definition: AREA_ACCURACY_DEFINITION.
 */
export function loadAreaAccuracyRows(db: StatsDb, userId: string, today: string, rotation: string | null) {
  return loadAreaRows(db, userId, { today, period: AREA_ACCURACY_PERIOD, rotation });
}

export function areaTablesFor(areaRows: readonly AreaRow[], practice: readonly PracticeSitting[], exams: readonly ExamResultView[], rotation: string | null): AreaTable[] {
  return buildAreaTables({ ...AREA_FNS, areaRows, practice, exams, rotation, unassigned: UNASSIGNED_AREA });
}

export async function loadStatsPage(
  db: StatsDb,
  userId: string,
  options: { period: StatsPeriod; rotation: string | null; now: Date },
): Promise<StatsPagePayload> {
  const today = sydneyDay(options.now);
  const scope = { today, period: options.period, rotation: options.rotation };
  const [dailyRows, hourRows, stageRows, areaRows, progressRows, sittings, exams, experience, answerTiming, scheduledLoad] = await Promise.all([
    loadDailyRows(db, userId),
    loadHourRows(db, userId, scope),
    loadStageRows(db, userId, scope),
    loadAreaAccuracyRows(db, userId, today, options.rotation),
    loadProgressRows(db, userId, scope),
    loadPracticeSittings(db, userId),
    loadExamResults(db, userId),
    // A layout read that fails (an instance without the column) renders the default layout.
    loadExperience(db, userId).catch(() => null),
    loadAnswerTiming(db, userId, scope),
    loadDailyLoad(db, userId, options.rotation),
  ]);

  const rotations = rotationsIn(dailyRows).filter(Boolean);
  const rotation = options.rotation;
  const scoped = filterRotation(dailyRows, rotation);
  const counts = dayCounts(scoped);
  const firstEver = dayCounts(dailyRows)[0]?.date ?? today;
  const firstDay = counts[0]?.date ?? firstEver;
  // The calendar starts at the first review, not the period selector. A rotation
  // filter changes the counts, not how far back the squares go.
  const heatStart = calendarHistoryStart(firstEver, today, HEATMAP_MAX_DAYS);
  const periodStart = periodStartDay(options.period, today) ?? firstDay;
  const periodDays = counts.filter((d) => d.date >= periodStart && d.date <= today);
  const byDate = new Map(periodDays.map((d) => [d.date, d.count]));
  const dates = dateRange(periodStart <= today ? periodStart : today, today);
  const retrievability = buildRetrievabilityHistogram(progressRows);

  return {
    today,
    period: options.period,
    rotation,
    rotations,
    hasHistory: dailyRows.length > 0 || sittings.length > 0 || exams.length > 0,
    layout: statsLayoutFromExperience(experience),
    todaySummary: buildToday(scoped, today),
    periodSummary: summarise(periodDays, periodStart <= today ? periodStart : today, today),
    forecast: buildForecast(progressRows, today),
    heatmap: buildHeatmap(counts.filter((d) => d.date >= heatStart), heatStart, today),
    calendarBlocks: labelBlocks(
      blocksFromPeriods(USYD_MD3_2026.assessmentPeriods),
      dailyRows.map((row) => ({ day: row.day, rotation: row.rotation, n: row.n })),
      exams.map((exam) => ({ block: exam.block, rotation: exam.rotation, examDate: exam.examDate })),
    ),
    daily: dates.map((date) => ({ date, count: byDate.get(date) ?? 0 })),
    reviewMinutes: minutesPerDay(scoped, dates),
    stages: buildStages(stageRows, options.period),
    cardCounts: buildCardCounts(progressRows),
    intervals: buildDayHistogram(progressRows, 'interval'),
    stability: buildDayHistogram(progressRows, 'stability'),
    retrievability,
    retention: buildRetention(stageRows),
    hourly: buildHourly(hourRows),
    buttons: buildButtons(stageRows, options.period),
    kinds: buildKindAccuracy(scoped, today),
    answerTiming,
    dailyLoad: scheduledLoad,
    areaTables: areaTablesFor(areaRows, sittings, exams, rotation),
    areaRotations: blueprintRotations(),
    practice: buildPracticeList(sittings, rotation),
    exams,
  };
}

export interface ExamGapsPayload {
  today: string;
  areaTables: AreaTable[];
  areaRotations: string[];
  exams: ExamResultView[];
  practice: PracticeListRow[];
}

/** md3 area accuracy (loadAreaAccuracyRows), beside practice papers and each recorded exam. */
export async function loadExamGaps(db: StatsDb, userId: string, now: Date): Promise<ExamGapsPayload> {
  const today = sydneyDay(now);
  const [areaRows, sittings, exams] = await Promise.all([
    loadAreaAccuracyRows(db, userId, today, null),
    loadPracticeSittings(db, userId),
    loadExamResults(db, userId),
  ]);
  return {
    today,
    areaTables: areaTablesFor(areaRows, sittings, exams, null),
    areaRotations: blueprintRotations(),
    exams,
    practice: buildPracticeList(sittings, null, 20),
  };
}

export { applyStatsLayout };
