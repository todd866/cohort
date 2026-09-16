import { computeTrackProjection } from './track-projection';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StudyEvent {
  itemId: string;
  occurredAt: Date;
}

export interface DailyHistoryInput {
  events: StudyEvent[];
  asOf: Date;
  completedLookbackDays: number;
}

export interface ProjectionBacktestInput {
  totalItems: number;
  events: StudyEvent[];
  asOf: Date;
  examDate: Date;
  consolidationDays?: number;
  completedLookbackDays?: number;
}

export interface ProjectionBacktest {
  totalItems: number;
  asOf: string;
  examDate: string;
  daysToExam: number;
  targetDay: number;
  requiredPerDay: number | null;
  seenAtAsOf: number;
  actualSeenByExam: number;
  actualFinalPercent: number;
  newUniqueHistory: number[];
  touchedHistory: number[];
  newUniqueDailyAverage: number;
  touchedDailyAverage: number;
  projectedFinalNewUnique: number;
  projectedFinalTouched: number;
  projectedFinalNewUniquePercent: number;
  projectedFinalTouchedPercent: number;
  newUniqueErrorItems: number;
  touchedErrorItems: number;
  repeatLoadShare: number;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(items: number, totalItems: number): number {
  if (totalItems <= 0) return 0;
  return roundTenth(Math.min(100, Math.max(0, (items / totalItems) * 100)));
}

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function studyDayBucketIndex(occurredAt: Date, asOf: Date, completedLookbackDays: number): number {
  if (occurredAt.getTime() >= asOf.getTime()) return 0;

  const elapsed = asOf.getTime() - occurredAt.getTime();
  const index = Math.floor((elapsed - 1) / DAY_MS) + 1;
  return index >= 1 && index <= completedLookbackDays ? index : -1;
}

export function toFirstSeenEvents(events: StudyEvent[]): StudyEvent[] {
  const firstByItem = new Map<string, Date>();

  for (const event of events) {
    const previous = firstByItem.get(event.itemId);
    if (!previous || event.occurredAt.getTime() < previous.getTime()) {
      firstByItem.set(event.itemId, event.occurredAt);
    }
  }

  return [...firstByItem.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([itemId, occurredAt]) => ({ itemId, occurredAt }));
}

export function buildDistinctDailyHistory(input: DailyHistoryInput): number[] {
  const completedLookbackDays = Math.max(0, Math.floor(input.completedLookbackDays));
  const buckets = Array.from({ length: completedLookbackDays + 1 }, () => new Set<string>());

  for (const event of input.events) {
    const index = studyDayBucketIndex(event.occurredAt, input.asOf, completedLookbackDays);
    if (index >= 0) buckets[index].add(event.itemId);
  }

  return buckets.map((bucket) => bucket.size);
}

export function countSeenBy(firstSeenEvents: StudyEvent[], cutoff: Date): number {
  return firstSeenEvents.filter((event) => event.occurredAt.getTime() < cutoff.getTime()).length;
}

export function computeProjectionBacktest(input: ProjectionBacktestInput): ProjectionBacktest {
  const totalItems = Math.max(0, input.totalItems);
  const completedLookbackDays = input.completedLookbackDays ?? 14;
  const consolidationDays = Math.max(0, input.consolidationDays ?? 5);
  const firstSeenEvents = toFirstSeenEvents(input.events);
  const historicalEvents = input.events.filter((event) => event.occurredAt.getTime() < input.asOf.getTime());
  const historicalFirstSeenEvents = firstSeenEvents.filter((event) => event.occurredAt.getTime() < input.asOf.getTime());
  const seenAtAsOf = countSeenBy(firstSeenEvents, input.asOf);
  const actualSeenByExam = countSeenBy(firstSeenEvents, input.examDate);
  const daysToExam = Math.max(0, Math.ceil((input.examDate.getTime() - input.asOf.getTime()) / DAY_MS));

  const newUniqueHistory = buildDistinctDailyHistory({
    events: historicalFirstSeenEvents,
    asOf: input.asOf,
    completedLookbackDays,
  });
  const touchedHistory = buildDistinctDailyHistory({
    events: historicalEvents,
    asOf: input.asOf,
    completedLookbackDays,
  });

  const newUniqueProjection = computeTrackProjection({
    totalItems,
    seenItems: seenAtAsOf,
    daysToExam,
    consolidationDays,
    recentFirstSeenHistory: newUniqueHistory,
    recentTotalHistory: newUniqueHistory,
    dailyTarget: null,
    todayNewItems: 0,
    todayTotalItems: 0,
  });
  const touchedProjection = computeTrackProjection({
    totalItems,
    seenItems: seenAtAsOf,
    daysToExam,
    consolidationDays,
    recentFirstSeenHistory: touchedHistory,
    recentTotalHistory: touchedHistory,
    dailyTarget: null,
    todayNewItems: 0,
    todayTotalItems: 0,
  });

  const targetDay = newUniqueProjection.targetDay ?? Math.max(daysToExam - consolidationDays, 1);
  const requiredPerDay = targetDay > 0
    ? roundTenth(Math.max(0, totalItems - seenAtAsOf) / targetDay)
    : null;
  const projectedFinalNewUnique = Math.min(
    totalItems,
    roundTenth(seenAtAsOf + newUniqueProjection.recentNewPerDay * targetDay),
  );
  const projectedFinalTouched = Math.min(
    totalItems,
    roundTenth(seenAtAsOf + touchedProjection.recentNewPerDay * targetDay),
  );

  const firstTimeInLookback = newUniqueHistory.slice(1).reduce((sum, value) => sum + value, 0);
  const touchedInLookback = touchedHistory.slice(1).reduce((sum, value) => sum + value, 0);
  const repeatLoadShare = touchedInLookback > 0
    ? roundTenth((1 - firstTimeInLookback / touchedInLookback) * 100) / 100
    : 0;

  return {
    totalItems,
    asOf: toIsoDay(input.asOf),
    examDate: toIsoDay(input.examDate),
    daysToExam,
    targetDay,
    requiredPerDay,
    seenAtAsOf,
    actualSeenByExam,
    actualFinalPercent: percent(actualSeenByExam, totalItems),
    newUniqueHistory,
    touchedHistory,
    newUniqueDailyAverage: newUniqueProjection.recentNewPerDay,
    touchedDailyAverage: touchedProjection.recentNewPerDay,
    projectedFinalNewUnique,
    projectedFinalTouched,
    projectedFinalNewUniquePercent: percent(projectedFinalNewUnique, totalItems),
    projectedFinalTouchedPercent: percent(projectedFinalTouched, totalItems),
    newUniqueErrorItems: roundTenth(projectedFinalNewUnique - actualSeenByExam),
    touchedErrorItems: roundTenth(projectedFinalTouched - actualSeenByExam),
    repeatLoadShare,
  };
}
