/**
 * One popover's numbers. The route returns grouped rows; this folds them.
 * Median-versus-usual is computed by the client from the calendar it already
 * holds, so opening a day does not scan the rest of the history.
 */
import { rotationShortLabel } from './calendar-grid';

export interface DayGroupRow {
  rotation: string;
  topic: string;
  n: number;
  pass: number;
  scored: number;
  ms: number;
}

export interface DaySlice {
  label: string;
  n: number;
}

export interface AnsweredDaySummary {
  reviews: number;
  correctPct: number | null;
  minutes: number;
  rotations: DaySlice[];
  topics: DaySlice[];
}

function slices(rows: readonly DayGroupRow[], key: (row: DayGroupRow) => string, limit?: number): DaySlice[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = key(row);
    if (!label || row.n <= 0) continue;
    totals.set(label, (totals.get(label) ?? 0) + row.n);
  }
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => ({ label, n }));
  return limit ? ranked.slice(0, limit) : ranked;
}

export function summariseAnswered(rows: readonly DayGroupRow[]): AnsweredDaySummary {
  let reviews = 0;
  let pass = 0;
  let scored = 0;
  let ms = 0;
  for (const row of rows) {
    reviews += row.n;
    pass += row.pass;
    scored += row.scored;
    ms += row.ms;
  }
  return {
    reviews,
    correctPct: scored > 0 ? (pass / scored) * 100 : null,
    minutes: Math.round(ms / 60_000),
    rotations: slices(rows, (row) => (row.rotation ? rotationShortLabel(row.rotation) : '')),
    // A topic label can carry its module in brackets ("Care of the Healthy
    // Newborn (PWH)"); the rotation row already says that.
    topics: slices(rows, (row) => row.topic.trim().replace(/\s*\([^()]*\)?$/, ''), 3),
  };
}

export function summariseDue(rows: readonly { rotation: string; n: number }[]): DaySlice[] {
  return rows
    .filter((row) => row.n > 0 && row.rotation)
    .map((row) => ({ label: rotationShortLabel(row.rotation), n: row.n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

export function formatSlice(items: readonly DaySlice[]): string {
  return items.map((item) => `${item.label} ${item.n}`).join(' · ');
}
