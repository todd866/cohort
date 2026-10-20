/**
 * The review calendar as data: one Sydney civil day per cell, Monday-first
 * month grids, and three zooms (month, teaching block, year).
 *
 * No clock and no database. Callers pass `today` and the rows they already
 * have. Block dates come from the curriculum module, never from literals here.
 */
import { dateRange } from '@/lib/review-stats';
import { formatCivilDate } from './civil-date';
import { addDays } from './stats-model';

export const CALENDAR_ZOOMS = ['month', 'block', 'year'] as const;
export type CalendarZoom = (typeof CALENDAR_ZOOMS)[number];

/** Matches HEATMAP_MAX_DAYS in stats-page.server.ts. */
export const CALENDAR_MAX_DAYS = 371;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ROTATION_SHORT: Record<string, string> = {
  'critical-care': 'CC',
  cah: 'CAH',
  paam: 'PAAM',
  pwh: 'PWH',
};

export function rotationShortLabel(rotation: string): string {
  return ROTATION_SHORT[rotation] ?? (rotation ? rotation.toUpperCase() : '—');
}

/** First day the grid may start: the learner's first review, never more than `maxDays` before today. */
export function calendarHistoryStart(firstReview: string, today: string, maxDays = CALENDAR_MAX_DAYS): string {
  const cap = addDays(today, -maxDays);
  return firstReview < cap ? cap : firstReview;
}

export function isCalendarZoom(value: unknown): value is CalendarZoom {
  return value === 'month' || value === 'block' || value === 'year';
}

export interface TeachingBlock {
  id: string;
  /** 1-based, from the period id `blockN` when it matches. */
  number: number;
  start: string;
  exam: string;
}

export function blocksFromPeriods(
  periods: readonly { id: string; startDate?: string; examDate: string }[],
): TeachingBlock[] {
  const blocks: TeachingBlock[] = [];
  for (const period of periods) {
    if (!period.startDate || !period.examDate || period.startDate > period.examDate) continue;
    const match = /^block(\d+)$/.exec(period.id);
    blocks.push({
      id: period.id,
      number: match ? Number(match[1]) : blocks.length + 1,
      start: period.startDate,
      exam: period.examDate,
    });
  }
  return blocks.sort((a, b) => a.start.localeCompare(b.start));
}

export function daysInBlock(block: Pick<TeachingBlock, 'start' | 'exam'>): string[] {
  return dateRange(block.start, block.exam);
}

/** The block that contains `today`, else the next one, else the last. */
export function blockOn(blocks: readonly TeachingBlock[], today: string): TeachingBlock | null {
  if (blocks.length === 0) return null;
  const current = blocks.find((block) => block.start <= today && today <= block.exam);
  if (current) return current;
  return blocks.find((block) => block.start > today) ?? blocks[blocks.length - 1];
}

export interface ActivityRow {
  day: string;
  rotation: string;
  n: number;
}

/**
 * The rotation this learner actually did in the block: the one with the most
 * answered items on dates from the block start through the exam. Ties break
 * toward the recorded exam rotation, then the rotation code. With no answers,
 * the exam rotation stands.
 */
export function rotationForBlock(
  rows: readonly ActivityRow[],
  block: Pick<TeachingBlock, 'start' | 'exam'>,
  examRotation: string | null,
): string | null {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.rotation || row.day < block.start || row.day > block.exam || row.n <= 0) continue;
    totals.set(row.rotation, (totals.get(row.rotation) ?? 0) + row.n);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return examRotation;
  const top = ranked[0][1];
  const tied = ranked.filter(([, n]) => n === top).map(([rotation]) => rotation);
  if (examRotation && tied.includes(examRotation)) return examRotation;
  return tied[0] ?? examRotation;
}

export interface LabeledBlock extends TeachingBlock {
  rotation: string | null;
  label: string;
}

export function labelBlocks(
  blocks: readonly TeachingBlock[],
  rows: readonly ActivityRow[],
  exams: readonly { block?: number | null; rotation: string; examDate?: string }[],
): LabeledBlock[] {
  return blocks.map((block) => {
    const recorded = exams.find((exam) => exam.block === block.number)
      ?? exams.find((exam) => exam.examDate === block.exam);
    const rotation = rotationForBlock(rows, block, recorded?.rotation ?? null);
    return { ...block, rotation, label: rotation ? rotationShortLabel(rotation) : `Block ${block.number}` };
  });
}

export interface CalendarExam {
  date: string;
  label: string;
  rotation: string;
  score: number | null;
  resultId: string | null;
}

export function assembleExamMarkers(input: {
  today: string;
  results: readonly { date: string; rotation: string; score: number | null; resultId: string | null }[];
  scheduled: readonly { date: string; rotation: string }[];
}): CalendarExam[] {
  const markers: CalendarExam[] = input.results
    .filter((result) => result.date && result.rotation)
    .map((result) => ({
      date: result.date,
      rotation: result.rotation,
      label: rotationShortLabel(result.rotation),
      score: result.score,
      resultId: result.resultId,
    }));
  const sat = new Set(markers.map((marker) => marker.rotation));
  const seen = new Set(markers.map((marker) => `${marker.date}|${marker.rotation}`));
  for (const item of input.scheduled) {
    if (!item.date || !item.rotation || item.date < input.today) continue;
    if (sat.has(item.rotation)) continue;
    const key = `${item.date}|${item.rotation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({
      date: item.date,
      rotation: item.rotation,
      label: rotationShortLabel(item.rotation),
      score: null,
      resultId: null,
    });
  }
  return markers.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
}

/** "CAH 2 Oct · 74%" — the score is omitted when the exam has not been sat. */
export function formatExamMarker(exam: Pick<CalendarExam, 'label' | 'date' | 'score'>, today?: string): string {
  const when = formatCivilDate(exam.date, today);
  const score = typeof exam.score === 'number' ? ` · ${Math.round(exam.score)}%` : '';
  return `${exam.label} ${when}${score}`;
}

export function examLegend(exams: readonly CalendarExam[], today?: string): string {
  return [...exams]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((exam) => formatExamMarker(exam, today))
    .join(' · ');
}

export function daysInMonth(year: number, month: number): string[] {
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
  return dateRange(from, to);
}

export function daysInYear(year: number): string[] {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return dateRange(`${year}-01-01`, `${year}-12-${leap ? 31 : 31}`);
}

/** 365 or 366. February 29 is the only extra day. */
export function yearLength(year: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return leap ? 366 : 365;
}

/** Monday = 0 … Sunday = 6, for a civil `YYYY-MM-DD`. */
export function mondayIndex(iso: string): number {
  const js = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return (js + 6) % 7;
}

export interface MonthBoard {
  key: string;
  label: string;
  /** Nulls are Monday-alignment spacers, not days. */
  cells: Array<string | null>;
}

/** One Monday-first month. Non-null cells are exactly the days of that month inside `days`. */
export function monthBoards(days: readonly string[]): MonthBoard[] {
  const byMonth = new Map<string, string[]>();
  for (const day of days) {
    const key = day.slice(0, 7);
    const list = byMonth.get(key);
    if (list) list.push(day);
    else byMonth.set(key, [day]);
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, monthDays]) => {
    const sorted = [...monthDays].sort();
    const [year, month] = key.split('-').map(Number);
    const label = `${MONTHS[month - 1]} ${year}`;
    const pad = mondayIndex(sorted[0]);
    return { key, label, cells: [...Array<null>(pad).fill(null), ...sorted] };
  });
}

export function daysForZoom(input: {
  zoom: CalendarZoom;
  today: string;
  year: number;
  month: number;
  block: Pick<TeachingBlock, 'start' | 'exam'> | null;
}): string[] {
  if (input.zoom === 'year') return daysInYear(input.year);
  if (input.zoom === 'month') return daysInMonth(input.year, input.month);
  if (!input.block) return daysInMonth(Number(input.today.slice(0, 4)), Number(input.today.slice(5, 7)));
  return daysInBlock(input.block);
}

/** Median of days that had at least one review. Empty history has no usual day. */
export function medianStudyDay(counts: readonly number[]): number | null {
  const studied = counts.filter((count) => count > 0).sort((a, b) => a - b);
  if (studied.length === 0) return null;
  const mid = Math.floor(studied.length / 2);
  if (studied.length % 2 === 1) return studied[mid];
  return (studied[mid - 1] + studied[mid]) / 2;
}

/** "▲ 2.1× usual". Null when there is no usual day to compare with. */
export function usualDeltaLabel(count: number, median: number | null): string | null {
  if (median == null || median <= 0) return null;
  const ratio = count / median;
  const arrow = ratio >= 1 ? '▲' : '▼';
  return `${arrow} ${ratio.toFixed(1)}× usual`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True only when `value` is that civil date, not a rolled-over one (`2026-02-30`). */
function isCivilDate(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, date));
  const roundTrip = utc.toISOString().slice(0, 10);
  return roundTrip === value;
}

function inclusiveDaySpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/** `YYYY-MM-DD` or `YYYY-MM-DD..YYYY-MM-DD`, at most one calendar year of days. */
export function parseDayRange(value: string | null | undefined): { from: string; to: string } | null {
  if (!value) return null;
  const parts = value.split('..');
  if (parts.length > 2) return null;
  const [from, rest] = parts;
  const to = rest ?? from;
  if (!isCivilDate(from) || !isCivilDate(to) || from > to) return null;
  if (inclusiveDaySpan(from, to) > CALENDAR_MAX_DAYS) return null;
  return { from, to };
}

export function replayHref(from: string, to: string): string {
  const replay = from === to ? from : `${from}..${to}`;
  return `/review?replay=${replay}`;
}

export function pullForwardHref(day: string): string {
  return `/review?due=${day}`;
}

export function dayAriaLabel(date: string, count: number, today?: string): string {
  const when = formatCivilDate(date, today);
  const reviews = `${count} review${count === 1 ? '' : 's'}`;
  return `${when}, ${reviews}`;
}
