/**
 * Topic heat — the pure layer behind the profile knowledge heatmap.
 *
 * One rule colours every square, and it is deliberately NOT the old currency
 * rule. Currency gated green behind a high windowed-accuracy bar measured from
 * the learner's own confidence presses. Self-rating is not calibrated: on a
 * heavy user's corpus the great majority of grades came back at the lowest
 * confidence, so the gate was unreachable by construction and every row sat red
 * permanently. Nothing the learner did could move it, which is the opposite of
 * what an instrument is for.
 *
 * So heat reads only what the learner DID, never how they rated themselves,
 * and it asks ONE question: how ready is this topic for exam day?
 *
 *   readiness(item) = R(exam | last review) / R(exam | reviewed today)
 *   score(topic)    = Σ(weight × readiness) / Σ(weight)
 *
 * R is md3's own power-law forgetting curve, R(t) = (1 + t/S)^-0.5 — the same
 * one predictRetrievalStrengthOnDate uses — so the map and the scheduler share
 * a memory model rather than each inventing one. Dividing by the best the item
 * could do makes the score a fraction of ACHIEVABLE readiness: an item
 * reviewed today scores 1, one never answered scores 0, and "all green by exam
 * day" is a target the learner can actually hit by reviewing.
 *
 * The score folds in all three things a learner means by "do I know this?":
 * VOLUME (uncovered items score 0 and drag the weighted mean down), RECENCY
 * (readiness decays smoothly with time since review), and DIFFICULTY (hard
 * material carries four times an easy item's weight, so drilling the hard
 * cards darkens a square faster than grinding the easy ones).
 *
 * It also tightens on its own as the exam nears: with the horizon d in the
 * numerator, a month-old review still looks respectable in week one and looks
 * threadbare in the final week. The grid gets harder to keep green exactly
 * when it should.
 *
 *   unseen (grey)   nothing in the topic has ever been answered
 *   cold   (red)    score below COLD_CEILING — been too long
 *   warm   (yellow) score below WARM_CEILING — been a while
 *   fresh  (green)  at or above it, in four depths
 *
 * WHY NORMALISED READINESS AND NOT AN ABSOLUTE ONE. Four rules were built and
 * measured against a real rotation before this one, and the first three
 * produced grids that told the learner nothing:
 *
 *   newest answer in the topic       four squares in five green — two cards out
 *                                    of a hundred-odd marked a whole topic fresh
 *   median weight in a 14-day window one square in twenty-five green —
 *                                    re-covering half of every topic each
 *                                    fortnight across a few thousand cards is
 *                                    arithmetically impossible
 *   the scheduler's own due-state    a few per cent of cards not overdue
 *   raw projected exam-day recall    almost every topic near zero
 *
 * The last one is the instructive failure. It is not wrong — it is what md3's
 * model actually predicts — but observed stability hovers near its default of a
 * few days, so little survives a three-week horizon and every square reads red.
 * An instrument whose needle is pinned tells you nothing, and it was pinned by a
 * data problem the grid cannot fix. Normalising by the achievable maximum
 * divides that problem out: the score measures distance from where this item
 * COULD be on exam day, which is the part the learner and the scheduler
 * control. On the same rotation that produced the degenerate grids above, it
 * spreads across all four bands.
 *
 * Everything here is deterministic: `now` is injected, no Date.now(), no I/O.
 * The Prisma side lives in topic-heat.server.ts.
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
export const COLD_CEILING = 0.25;
/** Below this score (and at or above COLD_CEILING) a topic is yellow. */
export const WARM_CEILING = 0.4;

/**
 * Difficulty weights. Authored `Card.difficulty` / `Question.difficulty`, not
 * the learner's self-rating — deliberately, so a learner's grading habit can
 * never distort the map the way it distorted currency.
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
}

export interface TopicHeat {
  band: TopicBand;
  level: TopicLevel;
  /** 0–1. Weighted share of this topic's ACHIEVABLE exam-day readiness. */
  score: number;
  /** Most recent answer anywhere in the topic. Shown to the learner. */
  lastAnsweredAt: Date | null;
  itemCount: number;
  /** Items answered at least once, ever. */
  seenCount: number;
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

/**
 * How ready one item is for exam day, as a fraction of the best it could be.
 *
 * Both numerator and denominator are md3's power-law curve R(t) = (1 + t/S)^-0.5,
 * evaluated at the exam: the numerator from the item's actual last review, the
 * denominator as if it were reviewed today. The square roots cancel into
 *
 *     sqrt((S + horizon) / (S + horizon + age))
 *
 * which is 1 for an item reviewed today, falls as it ages, and never reaches
 * zero — an old review is worth less than a new one but more than nothing. An
 * item never answered returns 0 outright; there is no curve to decay.
 *
 * A negative age (client clock skew) clamps to just-reviewed.
 */
export function itemReadiness(input: {
  ageDays: number | null;
  stabilityDays: number;
  horizonDays: number;
}): number {
  const { ageDays } = input;
  if (ageDays === null) return 0;
  const stability = Math.max(MIN_STABILITY_DAYS, input.stabilityDays);
  const horizon = Math.max(0, input.horizonDays);
  const age = Math.max(0, ageDays);
  return Math.sqrt((stability + horizon) / (stability + horizon + age));
}

/**
 * Depth thresholds inside the green band, as scores. The top step needs a
 * topic mostly covered and recently — on a topic full of hard material that
 * means having actually done the hard material, since easy items contribute a
 * quarter of what hard ones do.
 */
const DEPTH_THRESHOLDS = [0.5, 0.6, 0.7] as const;

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
      return "Won't hold";
    case 'warm':
      return 'Slipping';
    case 'fresh':
      if (heat.level >= 4) return 'Ready';
      if (heat.level === 3) return 'Nearly there';
      if (heat.level === 2) return 'Halfway';
      return 'Started';
  }
}
