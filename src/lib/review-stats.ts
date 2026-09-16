/**
 * Anki-style review statistics — pure aggregation.
 *
 * Everything here takes plain day-keyed counts and returns render-ready shapes.
 * No Prisma, no dates-from-now, so it is fully testable.
 *
 * A note on what counts as a "review": only answered items —
 * `card_reviewed` and `mcq_attempted`. `content_exposed` is an impression, not
 * an answer, and folding it in would inflate the numbers by ~5x.
 */

export const REVIEW_EVENT_TYPES = ['card_reviewed', 'mcq_attempted'] as const;

export interface DayCount {
  /** `YYYY-MM-DD` */
  date: string;
  count: number;
  correct?: number;
}

export interface HeatmapCell {
  date: string;
  count: number;
  /** 0 = none, 1–4 = quartile-ish intensity buckets. */
  level: 0 | 1 | 2 | 3 | 4;
  /** Column index (weeks since the grid start). */
  week: number;
  /** Row index, 0 = Monday. */
  weekday: number;
}

export interface ReviewSummary {
  totalReviews: number;
  daysStudied: number;
  daysInPeriod: number;
  /** 0–1. Anki's "Days studied: N of M (P%)". */
  studiedFraction: number;
  /** Mean over days actually studied — Anki's headline. */
  averagePerStudyDay: number;
  /** Mean over every day in the period, studied or not. */
  averagePerDay: number;
  busiestDay: DayCount | null;
  currentStreak: number;
  longestStreak: number;
}

const MS_PER_DAY = 86_400_000;

function utc(iso: string): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`review-stats: invalid date "${iso}"`);
  return ms;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = utc(from); t <= utc(to); t += MS_PER_DAY) out.push(isoDay(t));
  return out;
}

/**
 * Bucket counts into 4 intensity levels. Uses quantiles of the NON-ZERO days so
 * a handful of huge days can't flatten everything else into level 1 — the
 * failure mode of a naive max-relative scale.
 */
export function intensityLevels(counts: number[]): number[] {
  const nonZero = counts.filter((c) => c > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [0, 0, 0];
  const q = (p: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * p))];
  return [q(0.25), q(0.5), q(0.75)];
}

export function levelFor(count: number, thresholds: number[]): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  const [t1, t2, t3] = thresholds;
  if (count <= t1) return 1;
  if (count <= t2) return 2;
  if (count <= t3) return 3;
  return 4;
}

/**
 * Build a GitHub/Anki-style calendar grid. Weeks run Monday-first so the row
 * order matches how a UK/AU calendar reads.
 */
export function buildHeatmap(days: DayCount[], from: string, to: string): HeatmapCell[] {
  const byDate = new Map(days.map((d) => [d.date, d.count]));
  const all = dateRange(from, to);
  const thresholds = intensityLevels(all.map((d) => byDate.get(d) ?? 0));

  // Back up to the Monday on or before `from` so column 0 is a full week.
  const firstMs = utc(from);
  const jsDow = new Date(firstMs).getUTCDay(); // 0=Sun
  const mondayOffset = (jsDow + 6) % 7;
  const gridStart = firstMs - mondayOffset * MS_PER_DAY;

  return all.map((date) => {
    const count = byDate.get(date) ?? 0;
    const offset = Math.round((utc(date) - gridStart) / MS_PER_DAY);
    return {
      date,
      count,
      level: levelFor(count, thresholds),
      week: Math.floor(offset / 7),
      weekday: offset % 7,
    };
  });
}

export function summarise(days: DayCount[], from: string, to: string): ReviewSummary {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const all = dateRange(from, to);

  let totalReviews = 0;
  let daysStudied = 0;
  let busiestDay: DayCount | null = null;
  let currentStreak = 0;
  let longestStreak = 0;
  let running = 0;

  for (const date of all) {
    const d = byDate.get(date);
    const count = d?.count ?? 0;
    totalReviews += count;
    if (count > 0) {
      daysStudied += 1;
      running += 1;
      if (running > longestStreak) longestStreak = running;
      if (!busiestDay || count > busiestDay.count) busiestDay = { date, count };
    } else {
      running = 0;
    }
  }

  // The streak as of the last day in the period.
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if ((byDate.get(all[i])?.count ?? 0) > 0) currentStreak += 1;
    else break;
  }

  const daysInPeriod = all.length;
  return {
    totalReviews,
    daysStudied,
    daysInPeriod,
    studiedFraction: daysInPeriod === 0 ? 0 : daysStudied / daysInPeriod,
    averagePerStudyDay: daysStudied === 0 ? 0 : totalReviews / daysStudied,
    averagePerDay: daysInPeriod === 0 ? 0 : totalReviews / daysInPeriod,
    busiestDay,
    currentStreak,
    longestStreak,
  };
}

export interface MaturityBucket {
  key: 'new' | 'learning' | 'young' | 'mature';
  label: string;
  count: number;
  /** Ordered 0–3, used to index the sequential ramp. */
  step: 0 | 1 | 2 | 3;
}

/**
 * Card maturity is ORDERED, so it gets a sequential ramp rather than four
 * unrelated hues.
 *
 * Thresholds are md3's, NOT Anki's. Anki's 21-day "mature" line is meaningless
 * here: measured 2026-07-25, the highest stability across 4,125 cards and ~16k
 * reviews was 12.3 days, mean 2.1. Using Anki's bands produced three empty
 * buckets and told you nothing. These bands describe the distribution that
 * actually exists — see `stabilityCeiling` for why it is so compressed.
 */
export function maturityBuckets(rows: {
  total: number;
  neverReviewed: number;
  stabilityUnder1: number;
  stability1to3: number;
  stability3to7: number;
  stability7plus: number;
}): MaturityBucket[] {
  return [
    { key: 'new', label: 'Unseen', count: rows.neverReviewed, step: 0 },
    { key: 'learning', label: '< 1 day', count: rows.stabilityUnder1, step: 1 },
    { key: 'young', label: '1–3 days', count: rows.stability1to3, step: 2 },
    { key: 'mature', label: '3+ days', count: rows.stability3to7 + rows.stability7plus, step: 3 },
  ];
}

/** Rolling mean, used to damp the daily bar chart into a readable trend. */
export function rollingMean(values: number[], window: number): number[] {
  if (window <= 1) return [...values];
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}
