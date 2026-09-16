/**
 * BACKGROUND USE ONLY. Aggregates a learner's whole recent grade and MCQ
 * history; listed in BACKGROUND_ONLY_MODULES and never imported from a request
 * path. See .claude/rules/hot-path-latency.md.
 *
 * Computes the learner's self-rating reliability record and stores it on
 * User.feedProfile.ratingReliability, where serve time reads it as a single
 * row and grade time never reads it at all (the served item carries what it
 * needs). Run by `npm run reliability:refresh` over active learners.
 *
 * Tier 1 asks whether the rating varies at all (rating-reliability.ts).
 * Tier 2 asks whether the variation predicts outcomes on tightly linked
 * questions (rating-discrimination.ts, pairs from rating-reliability-pairs.ts).
 * Both use a rolling window so a verdict is escapable.
 */

import { prisma } from '@/lib/prisma';
import { loadProximityOverlay, type ProximityOverlay } from '@/lib/manifold/card-question-proximity';
import { degeneracyVerdict, gradeEntropyBits, combineReliabilityVerdicts } from './rating-reliability';
import { discriminationVerdict, rankAuc } from './rating-discrimination';
import { fitGradeCalibration } from './grade-calibration';
import {
  pairGradesWithOutcomes,
  summariseQuestionOutcomes,
  type CardGradeEvent,
  type QuestionAttempt,
} from './rating-reliability-pairs';
import {
  RATING_RELIABILITY_RECORD_VERSION,
  type RatingReliabilityRecord,
} from './rating-reliability-record';

export const RELIABILITY_WINDOW_DAYS = 60;
/**
 * The four rotations the cohort actually studies, each with a committed
 * proximity overlay. More overlays mean more (grade, linked-MCQ) pairs per
 * learner, which is the only route from `insufficient-evidence` to a verdict.
 */
export const DEFAULT_RELIABILITY_ROTATIONS = ['cah', 'critical-care', 'paam', 'pwh'] as const;

/** Merge per-rotation overlays into one keyed map; stableIds are unique across rotations. */
export function mergeOverlays(overlays: ReadonlyArray<ProximityOverlay | null>): ProximityOverlay | null {
  const present = overlays.filter((o): o is ProximityOverlay => o != null);
  if (present.length === 0) return null;
  return {
    generatedAt: present.map((o) => o.generatedAt).sort().at(-1) ?? '',
    rotation: present.map((o) => o.rotation).join('+'),
    k: Math.max(...present.map((o) => o.k)),
    tightFloor: Math.max(...present.map((o) => o.tightFloor)),
    looseFloor: Math.max(...present.map((o) => o.looseFloor)),
    cards: Object.assign({}, ...present.map((o) => o.cards)),
  };
}

export interface LearnerHistory {
  grades: number[];
  gradeEvents: CardGradeEvent[];
  attempts: QuestionAttempt[];
}

/**
 * A learner's raw grades and MCQ attempts in [since, until). Exported so the
 * held-out backtest can cut train and test windows from the same loader the
 * production refresh uses — a backtest against a different reading of the
 * data would validate the wrong thing.
 */
export async function loadLearnerHistory(
  userId: string,
  { since, until }: { since: Date; until: Date },
): Promise<LearnerHistory> {
  const [events, responses] = await Promise.all([
    prisma.learningEvent.findMany({
      where: {
        userId, eventType: 'card_reviewed', sourceType: 'card',
        timestamp: { gte: since, lt: until }, quality: { not: null },
      },
      select: { sourceId: true, quality: true, timestamp: true },
    }),
    prisma.questionResponse.findMany({
      where: { userId, createdAt: { gte: since, lt: until } },
      select: { questionId: true, isCorrect: true, selectedOption: true, createdAt: true },
    }),
  ]);
  const cardIds = [...new Set(events.map((e) => e.sourceId))];
  const cards = cardIds.length > 0
    ? await prisma.card.findMany({ where: { id: { in: cardIds } }, select: { id: true, stableId: true } })
    : [];
  const stableById = new Map(cards.map((c) => [c.id, c.stableId]));
  const grades: number[] = [];
  const gradeEvents: CardGradeEvent[] = [];
  for (const e of events) {
    if (e.quality == null) continue;
    grades.push(e.quality);
    const stableId = stableById.get(e.sourceId);
    if (stableId) gradeEvents.push({ stableId, quality: e.quality, at: e.timestamp });
  }
  const attempts: QuestionAttempt[] = responses.map((r) => ({
    questionId: r.questionId,
    correct: r.isCorrect,
    skipped: r.selectedOption === 'SKIP',
    at: r.createdAt,
  }));
  return { grades, gradeEvents, attempts };
}

export interface ComputeOptions {
  now?: Date;
  windowDays?: number;
  rotations?: readonly string[];
  /** Injected for tests; defaults to loading from content/. */
  overlay?: ProximityOverlay | null;
}

export async function computeRatingReliability(
  userId: string,
  {
    now = new Date(),
    windowDays = RELIABILITY_WINDOW_DAYS,
    rotations = DEFAULT_RELIABILITY_ROTATIONS,
    overlay,
  }: ComputeOptions = {},
): Promise<RatingReliabilityRecord> {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const merged = overlay !== undefined
    ? overlay
    : mergeOverlays(rotations.map((r) => loadProximityOverlay(r)));

  const { grades, gradeEvents, attempts } = await loadLearnerHistory(userId, { since, until: now });

  const tier1Verdict = degeneracyVerdict(grades);
  const pairs = pairGradesWithOutcomes(merged, gradeEvents, attempts);
  const tier2Verdict = discriminationVerdict(pairs);
  // The learner's own ladder, from the same pairs. The held-out backtest found
  // this to be the best predictor of linked-MCQ outcome and the fixed ladder
  // the worst; see grade-calibration.ts.
  const answered = attempts.filter((a) => !a.skipped);
  const baseRate = answered.length > 0 ? answered.filter((a) => a.correct).length / answered.length : 0.5;
  const calibration = fitGradeCalibration(pairs, baseRate);

  return {
    version: RATING_RELIABILITY_RECORD_VERSION,
    computedAt: now.toISOString(),
    windowDays,
    rotations: [...rotations],
    tier1: { grades: grades.length, entropyBits: gradeEntropyBits(grades), verdict: tier1Verdict },
    tier2: { pairs: pairs.length, auc: rankAuc(pairs), verdict: tier2Verdict },
    verdict: combineReliabilityVerdicts(tier1Verdict, tier2Verdict),
    questionOutcomes: summariseQuestionOutcomes(attempts),
    calibration,
  };
}

/** Writes the record under feedProfile.ratingReliability, preserving every other key. */
export async function persistRatingReliability(userId: string, record: RatingReliabilityRecord): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { feedProfile: true } });
  const feedProfile = (existing?.feedProfile && typeof existing.feedProfile === 'object' && !Array.isArray(existing.feedProfile)
    ? existing.feedProfile
    : {}) as Record<string, unknown>;
  await prisma.user.update({
    where: { id: userId },
    data: { feedProfile: { ...feedProfile, ratingReliability: record } as object },
  });
}
