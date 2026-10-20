/**
 * The blueprint-area chart, as data: which variant to draw for a rotation,
 * which rows, in what order, and which fold away. Client-safe, no taxonomy.
 *
 * One dumbbell per area on a fixed 0–100 axis, on every rotation.
 * You is the exam score (filled). md3 and a practice paper are outline
 * rings, including when the rotation has no exam. Areas with nothing to
 * draw fold into one "+N" control. Unassigned stays off the default view.
 */
import type { AreaTable, ExamResultView, StatsPeriod } from './stats-model';

/**
 * What "md3 %" means, wherever an area shows it (Exam gaps and Statistics
 * read it from one loader, loadAreaAccuracyRows in ./stats-page.server, over
 * one window, AREA_ACCURACY_PERIOD). Shown as the md3 legend's tooltip.
 */
export const AREA_ACCURACY_PERIOD: StatsPeriod = 'all';
export const AREA_ACCURACY_DEFINITION =
  'md3: % correct of answered items, all time · cloze Again = wrong · revealed answers not counted';

/** The expected passing standard and the cohort-mean range the papers aim for. */
export const PASS_BAND = { from: 64, to: 75 } as const;

export interface AreaChartRow {
  area: string;
  label: string;
  md3: number | null;
  exam: number | null;
  practice: number | null;
  gap: number | null;
  title: string;
}

export interface AreaChartModel {
  rotation: string;
  variant: 'dumbbell' | 'bars';
  overall: { md3: number | null; exam: number } | null;
  rows: AreaChartRow[];
  /** Areas with nothing to draw in this variant, including blueprint areas with no data at all. */
  folded: Array<{ area: string; label: string }>;
}

const pctText = (v: number | null) => (v == null ? '–' : `${Math.round(v)}%`);
const byNumber = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
const UNASSIGNED = 'unassigned';

export function areaChartModel(table: AreaTable): AreaChartModel {
  const variant = 'dumbbell' as const;
  const rows: AreaChartRow[] = [];
  const folded: Array<{ area: string; label: string }> = [];
  for (const r of table.rows) {
    if (r.area === UNASSIGNED) continue;
    const row: AreaChartRow = {
      area: r.area,
      label: r.label,
      md3: r.md3.pct,
      exam: r.exam?.pct ?? null,
      practice: r.practice?.pct ?? null,
      gap: r.gap,
      title: [
        r.label,
        `md3 ${pctText(r.md3.pct)} of ${r.md3.scored}${r.md3.cardPct != null && r.md3.mcqPct != null ? ` (cloze ${pctText(r.md3.cardPct)}, MCQ ${pctText(r.md3.mcqPct)})` : ''}`,
        ...(r.practice ? [`paper ${pctText(r.practice.pct)}`] : []),
        ...(r.exam ? [`exam ${pctText(r.exam.pct)}`] : []),
      ].join(' · '),
    };
    // Any measurement draws a row; only genuinely empty areas fold away.
    if (row.md3 != null || row.exam != null || row.practice != null) rows.push(row);
    else folded.push({ area: r.area, label: r.label });
  }
  rows.sort((a, b) => {
    if (a.gap != null && b.gap != null) return a.gap - b.gap;
    if (a.gap != null) return -1;
    if (b.gap != null) return 1;
    return byNumber(a.md3, b.md3);
  });
  folded.push(...table.missing);
  return {
    rotation: table.rotation,
    variant,
    overall: table.exam ? { md3: table.md3Overall, exam: table.exam.score } : null,
    rows,
    folded,
  };
}

/** The tab to open on: the learner's current rotation, else their latest exam's, else the first with data. */
export function defaultAreaRotation(tables: readonly AreaTable[], current: string | null, exams: readonly ExamResultView[]): string | null {
  const have = tables.map((t) => t.rotation).filter(Boolean);
  if (current && have.includes(current)) return current;
  const latest = [...exams].sort((a, b) => b.examDate.localeCompare(a.examDate)).find((e) => have.includes(e.rotation));
  return latest?.rotation ?? have[0] ?? null;
}

/**
 * The rotation strip: a tab per rotation with an exam blueprint, in course
 * (taxonomy) order; every other deck a learner has touched goes behind one
 * More menu, so the strip fits a phone. The blank rotation is dropped.
 */
export function rotationTabs<T extends { rotation: string }>(tables: readonly T[], blueprintOrder: readonly string[]): { tabs: T[]; more: T[] } {
  const usable = tables.filter((t) => t.rotation);
  const tabs = blueprintOrder.flatMap((r) => usable.filter((t) => t.rotation === r));
  const more = usable.filter((t) => !blueprintOrder.includes(t.rotation)).sort((a, b) => a.rotation.localeCompare(b.rotation));
  return { tabs, more };
}
