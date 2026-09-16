/**
 * Readiness over time, and where it is heading — the pure layer.
 *
 * The heatmap answers "where am I?". This answers the question actually being
 * asked of it: "will this be all green by exam day?".
 *
 * A NOTE ON THE YARDSTICK. Every historical point is scored against TODAY's
 * exam horizon, not the horizon as it stood on that date. That is deliberate.
 * Readiness tightens as the exam nears (see topic-heat.ts), so replaying each
 * point against its own contemporaneous horizon would bend the line downward
 * purely because the calendar moved, and a learner standing still would appear
 * to be sliding backwards. Holding the yardstick fixed means the line shows
 * change in the LEARNER. The projection then answers "if I keep working like
 * this" — which is the only part they control.
 *
 * Everything here is deterministic: no Date.now(), no I/O.
 */

export interface ReadinessPoint {
  /** `YYYY-MM-DD` */
  date: string;
  /** Topics at or above the fresh bar on that date. */
  ready: number;
}

export interface ReadinessProjection {
  /** Topics per WEEK the recent trend is adding. Negative when slipping. */
  perWeek: number;
  /** Projected ready count on exam day, clamped to [0, total]. */
  projectedReady: number;
  /** True when the projection clears every topic before the exam. */
  reachesAll: boolean;
  /** Null when there is not enough history to say anything honest. */
  confidentEnough: boolean;
}

/** Two points is a line through noise; below this we decline to project. */
export const MIN_POINTS_TO_PROJECT = 4;

/**
 * How many trailing points the projection fits, regardless of how many the
 * sparkline draws.
 *
 * A block is six weeks long and the window is eight, so the early samples
 * routinely sit BEFORE the learner started this rotation at all — flat at near
 * zero, then a takeoff when the block begins. Fitting across that regime
 * change roughly halves the apparent pace, because most of the window
 * describes a period the learner was studying something else. The full series
 * is still drawn — seeing the takeoff is the point of a chart — but the
 * forecast reads only the part that is still true.
 */
export const FIT_POINTS = 5;

/**
 * Least-squares slope of `ready` against day-offset, in topics per week.
 *
 * Ordinary linear regression rather than first-to-last, because a single point
 * is one day's worth of luck: a heavy session the evening before lifts it, and
 * a rest day drops it. The fit reads the trailing FIT_POINTS samples — see
 * there for why not all of them.
 */
export function readinessSlopePerWeek(points: readonly ReadinessPoint[]): number {
  if (points.length < 2) return 0;

  const fitted = points.slice(-FIT_POINTS);
  const xs = fitted.map((p) => Date.parse(`${p.date}T00:00:00Z`) / 86_400_000);
  const ys = fitted.map((p) => p.ready);
  if (xs.some((x) => Number.isNaN(x))) return 0;

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (den === 0) return 0;
  return (num / den) * 7; // per day → per week
}

/**
 * Where the trend lands on exam day.
 *
 * Anchored on the OBSERVED last point — which is where the learner actually
 * is, and the number shown beside the chart — with the fitted slope carrying
 * it forward. Anchoring on the fitted value instead would be smoother but
 * would print a "ready today" count that disagreed with the grid above it.
 */
export function projectReadiness(input: {
  points: readonly ReadinessPoint[];
  totalTopics: number;
  daysToExam: number;
}): ReadinessProjection {
  const { points, totalTopics, daysToExam } = input;
  const perWeek = readinessSlopePerWeek(points);
  const confidentEnough = points.length >= MIN_POINTS_TO_PROJECT;

  const last = points.at(-1);
  const observed = last ? last.ready : 0;
  const projected = observed + (perWeek * Math.max(0, daysToExam)) / 7;
  const projectedReady = Math.max(0, Math.min(totalTopics, Math.round(projected)));

  return {
    perWeek,
    projectedReady,
    reachesAll: projectedReady >= totalTopics,
    confidentEnough,
  };
}

/**
 * One sentence for the learner. Says what the trend implies and, when it falls
 * short, how much it falls short by — a projection that does not name the gap
 * is just a number.
 */
export function describeProjection(input: {
  projection: ReadinessProjection;
  totalTopics: number;
  daysToExam: number;
}): string {
  const { projection, totalTopics, daysToExam } = input;
  const days = Math.round(daysToExam);

  if (!projection.confidentEnough) {
    return 'Not enough history yet to project a finish.';
  }
  if (projection.reachesAll) {
    return `On this pace, every topic is ready before the exam in ${days} days.`;
  }
  if (projection.perWeek <= 0) {
    return `Readiness is not rising. ${totalTopics - projection.projectedReady} topics would still be short in ${days} days.`;
  }
  const short = totalTopics - projection.projectedReady;
  return `On this pace, ${projection.projectedReady} of ${totalTopics} topics ready in ${days} days — ${short} short.`;
}
