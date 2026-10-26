/**
 * Topic knowledge estimate: successful latest recall, decayed with the
 * scheduler's power-law memory curve, averaged over the whole live topic.
 * Unseen, failed and ungraded items contribute zero; studying is counted
 * separately. Card grades include self-reported recall, so this is an
 * estimate of current knowledge, not a validated exam-pass probability.
 *
 * A successful review starts at 1. Stability learned by the scheduler governs
 * how quickly that evidence fades. The exam countdown does not inflate it.
 * Pure and deterministic; the grouped SQL equivalent lives in topic-heat.server.ts.
 */

export const DAY_MS = 86_400_000;

/**
 * Horizon used when there is no real exam to aim at — a self-paced deck, or a
 * date already past. Keeps the map meaningful off-calendar without pretending
 * to a deadline that does not exist.
 */
export const DEFAULT_HORIZON_DAYS = 30;

/**
 * Floor for a card's stability. CardProgress defaults stabilityDays to 3 and
 * the column can in principle be set lower; a zero would divide by nothing.
 */
export const MIN_STABILITY_DAYS = 0.1;

/** Mirrors CardProgress.stabilityDays's schema default. */
export const DEFAULT_STABILITY_DAYS = 3;

/** Below this score a topic is red. */
export const COLD_CEILING = 0.4;
/** Below this score (and at or above COLD_CEILING) a topic is yellow. */
export const WARM_CEILING = 0.8;

/**
 * Difficulty weights use authored difficulty, independently of the latest recall grade.
 */
export const DIFFICULTY_WEIGHT = {
  easy: 0.5,
  medium: 1,
  hard: 2,
} as const;

export type TopicBand = 'unseen' | 'cold' | 'warm' | 'fresh';

/** 0 = grey/yellow/red; 1–4 = light → dark green. */
export type TopicLevel = 0 | 1 | 2 | 3 | 4;

export interface TopicItem {
  /** Authored difficulty. An unrecognised value is treated as medium. */
  difficulty: string;
  /** When this learner last answered this item; null = never. */
  lastAnsweredAt: Date | null;
  /** The scheduler's stability for this item. Defaults to CardProgress's own default. */
  stabilityDays?: number;
  /** Canonical latest recall grade: 0–5; unknown is not evidence of success. */
  lastQuality?: number | null;
}

export interface TopicHeat {
  band: TopicBand;
  level: TopicLevel;
  /** 0–1. Weighted estimated current recall across the whole topic. */
  score: number;
  /** Most recent answer anywhere in the topic. Shown to the learner. */
  lastAnsweredAt: Date | null;
  itemCount: number;
  /** Items answered at least once, ever. */
  seenCount: number;
}

export interface TopicReadinessCounts {
  ready: number;
  slipping: number;
  /** Explicit colour counts; optional for older API responses. */
  needsReview?: number;
  learning?: number;
  unseen: number;
  total: number;
}

export interface TopicReadinessSummary extends TopicReadinessCounts {
  rotation: string;
  rotationLabel: string;
  horizonDays: number;
}

/**
 * Product-level readiness buckets shared by the profile and review drawer.
 * Both cold and warm topics need attention. The legacy API field "slipping"
 * is retained for compatibility; the UI uses the separate cold and warm counts to match the legend.
 */
export function summarizeTopicReadiness(
  topics: readonly Pick<TopicHeat, 'band'>[],
): TopicReadinessCounts {
  let ready = 0;
  let slipping = 0;
  let unseen = 0;
  let needsReview = 0;
  let learning = 0;
  for (const topic of topics) {
    if (topic.band === 'fresh') ready += 1;
    else if (topic.band === 'unseen') unseen += 1;
    else {
      slipping += 1;
      if (topic.band === 'cold') needsReview += 1;
      else learning += 1;
    }
  }
  return { ready, slipping, unseen, needsReview, learning, total: topics.length };
}

/**
 * The totals a topic is classified from. Produced either by summing items in
 * JS (small topics — the pinned lifetime-skill squares) or by aggregating in
 * Postgres (a whole rotation's clusters, where pulling every card row to count
 * them would be absurd). Both paths land here, so the bands cannot drift.
 */
export interface TopicTotals {
  itemCount: number;
  seenCount: number;
  totalWeight: number;
  /** Σ(weight × readiness). Never exceeds totalWeight. */
  heldWeight: number;
  lastAnsweredAt: Date | null;
}

/** Weight for one item's authored difficulty; unknown values fall back to medium. */
export function itemWeight(difficulty: string): number {
  const key = difficulty.toLowerCase() as keyof typeof DIFFICULTY_WEIGHT;
  return Object.hasOwn(DIFFICULTY_WEIGHT, key)
    ? DIFFICULTY_WEIGHT[key]
    : DIFFICULTY_WEIGHT.medium;
}

/** Current recall estimate. A failed or unknown latest grade cannot earn credit. */
export function itemReadiness(input: {
  ageDays: number | null;
  stabilityDays: number;
  lastQuality?: number | null;
  /** Retained for callers; the exam horizon never changes current knowledge. */
  horizonDays?: number;
}): number {
  const { ageDays, lastQuality } = input;
  if (ageDays === null || !Number.isFinite(ageDays)
      || lastQuality == null || !Number.isFinite(lastQuality)
      || lastQuality < 3 || lastQuality > 5) return 0;
  const stability = Number.isFinite(input.stabilityDays)
    ? Math.max(MIN_STABILITY_DAYS, input.stabilityDays) : DEFAULT_STABILITY_DAYS;
  return Math.sqrt(stability / (stability + Math.max(0, ageDays)));
}

/**
 * Depth thresholds inside the green band, as scores. The top step needs a
 * topic mostly covered and recently — on a topic full of hard material that
 * means having actually done the hard material, since easy items contribute a
 * quarter of what hard ones do.
 */
const DEPTH_THRESHOLDS = [0.85, 0.9, 0.95] as const;

function levelForScore(score: number): TopicLevel {
  const [t1, t2, t3] = DEPTH_THRESHOLDS;
  if (score < t1) return 1;
  if (score < t2) return 2;
  if (score < t3) return 3;
  return 4;
}

/** Classify a topic from its totals. */
export function classifyTopicHeat(input: TopicTotals & { now: Date }): TopicHeat {
  const { itemCount, seenCount, totalWeight, heldWeight, lastAnsweredAt } = input;

  const score = totalWeight > 0 ? Math.min(1, Math.max(0, heldWeight / totalWeight)) : 0;

  // Grey means literally untouched. A topic with history scores on the ramp,
  // however low — "I have been here and let it go" is a different statement
  // from "I have never opened this", and they must not share a colour.
  let band: TopicBand = 'unseen';
  if (seenCount > 0) {
    band = score < COLD_CEILING ? 'cold' : score < WARM_CEILING ? 'warm' : 'fresh';
  }

  const ts = lastAnsweredAt?.getTime();
  return {
    band,
    level: band === 'fresh' ? levelForScore(score) : 0,
    score,
    lastAnsweredAt: ts === undefined || Number.isNaN(ts) ? null : new Date(ts),
    itemCount,
    seenCount,
  };
}

/**
 * Sum a topic's items into totals, then classify. The item-level entry point,
 * for topics small enough to hold in memory.
 */
export function computeTopicHeat(input: {
  items: readonly TopicItem[];
  now: Date;
  /** Days from now to the exam. Defaults to DEFAULT_HORIZON_DAYS. */
  horizonDays?: number;
}): TopicHeat {
  const { items, now } = input;
  const horizonDays = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const nowMs = now.getTime();

  let totalWeight = 0;
  let heldWeight = 0;
  let seenCount = 0;
  let lastMs: number | null = null;

  for (const item of items) {
    const weight = itemWeight(item.difficulty);
    totalWeight += weight;

    const ts = item.lastAnsweredAt?.getTime();
    if (ts === undefined || Number.isNaN(ts)) continue;
    seenCount += 1;
    if (lastMs === null || ts > lastMs) lastMs = ts;
    heldWeight += weight * itemReadiness({
      ageDays: (nowMs - ts) / DAY_MS,
      stabilityDays: item.stabilityDays ?? DEFAULT_STABILITY_DAYS,
      horizonDays,
      lastQuality: item.lastQuality,
    });
  }

  return classifyTopicHeat({
    itemCount: items.length,
    seenCount,
    totalWeight,
    heldWeight,
    lastAnsweredAt: lastMs === null ? null : new Date(lastMs),
    now,
  });
}

/**
 * The status in words. Every square carries this in its tooltip so colour is
 * never the only channel — green-vs-red is the classic deutan trap, and the
 * grid leans on it twice.
 */
export function describeTopicHeat(heat: { band: TopicBand; level: TopicLevel }): string {
  switch (heat.band) {
    case 'unseen':
      return 'Never studied';
    case 'cold':
      return 'Needs review';
    case 'warm':
      return 'Learning';
    case 'fresh':
      return 'Ready';
  }
}
