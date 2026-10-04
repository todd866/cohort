/**
 * The learner-controlled challenge preference used while choosing discretionary
 * review material. It is deliberately small: this is a bounded ordering nudge,
 * not a second memory model.
 */

export const REVIEW_CHALLENGE_POLICY_VERSION = 'review-challenge-v2';

export type ReviewChallengeLevel = -2 | -1 | 0 | 1 | 2;

const LEVELS: readonly ReviewChallengeLevel[] = [-2, -1, 0, 1, 2];

export function normalizeReviewChallengeLevel(value: unknown): ReviewChallengeLevel {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  return LEVELS.reduce((closest, level) =>
    Math.abs(level - rounded) < Math.abs(closest - rounded) ? level : closest,
  0 as ReviewChallengeLevel);
}

export function reviewChallengeLabel(level: ReviewChallengeLevel): string {
  switch (normalizeReviewChallengeLevel(level)) {
    case -2: return 'Foundations';
    case -1: return 'Easier';
    case 1: return 'Harder';
    case 2: return 'Hardest';
    default: return 'Auto';
  }
}

/** The empirical quality signal is ignored until ten supporting observations. */
export const EMPIRICAL_FACILITY_SAMPLE_FLOOR = 10;

/**
 * Shrink facility toward an uninformative 0.5 prior. This prevents a small
 * number of unusually good or bad answers from steering the slider.
 */
export function shrunkFacility(
  facility: number | null | undefined,
  sampleSize: number | null | undefined,
): number | null {
  if (
    typeof facility !== 'number'
    || !Number.isFinite(facility)
    || typeof sampleSize !== 'number'
    || !Number.isFinite(sampleSize)
    || sampleSize < EMPIRICAL_FACILITY_SAMPLE_FLOOR
  ) return null;
  const bounded = Math.max(0, Math.min(1, facility));
  const weight = sampleSize / (sampleSize + EMPIRICAL_FACILITY_SAMPLE_FLOOR);
  return 0.5 + weight * (bounded - 0.5);
}

/**
 * Signed ordinal movement for a candidate. Lower is better in the ranker.
 * Positive levels favour harder authored material (higher complexity and lower
 * facility); negative levels favour easier material. The movement is bounded
 * by the user's setting and is zero for Auto or insufficient evidence.
 */
export function reviewChallengeOrdinalNudge(args: {
  level: ReviewChallengeLevel;
  complexity?: number | null;
  facility?: number | null;
  sampleSize?: number | null;
}): number {
  const level = normalizeReviewChallengeLevel(args.level);
  if (level === 0) return 0;
  const quality = shrunkFacility(args.facility, args.sampleSize);
  const authored = typeof args.complexity === 'number' && Number.isFinite(args.complexity)
    ? Math.max(1, Math.min(5, args.complexity)) / 5
    : 0.5;
  // Quality remains a separate axis: it can refine a known item, but never
  // invents a quality signal for a low-sample item.
  const qualityAxis = quality === null ? 0 : (0.5 - quality);
  const difficultyAxis = authored - 0.5;
  const preference = level > 0
    ? difficultyAxis + qualityAxis
    : -difficultyAxis - qualityAxis;
  return preference > 0 ? -Math.abs(level) :
    preference < 0 ? Math.abs(level) : 0;
}

export function shiftQuestionDifficulty(
  difficulty: 'easy' | 'medium' | 'hard',
  level: ReviewChallengeLevel,
  slotIndex = 0,
): 'easy' | 'medium' | 'hard' {
  // A slider setting is a bounded bias, not a command to turn every question
  // into a hard question. Bias peaks or valleys by one bucket (two at the
  // extremes), leaving the other half of each cycle available for recovery.
  const index = difficulty === 'easy' ? 0 : difficulty === 'hard' ? 2 : 1;
  const normalized = normalizeReviewChallengeLevel(level);
  if (normalized === 0) return difficulty;
  const phase = (2 * Math.PI * slotIndex) / 6 - Math.PI / 2;
  // Only the rising/peak half of the wave receives a one-bucket bias. Valleys
  // remain available as relief slots even when the global setting is harder.
  const wavePressure = Math.sin(phase);
  const magnitude = Math.abs(normalized) === 2 ? 2 : 1;
  const shift = normalized > 0
    ? (wavePressure >= 0.45 ? magnitude : 0)
    : (wavePressure <= -0.45 ? -magnitude : 0);
  const shifted = Math.max(0, Math.min(2, index + shift));
  return shifted === 0 ? 'easy' : shifted === 2 ? 'hard' : 'medium';
}

export type ReviewWaveItem = {
  id?: string;
  type?: string;
  complexity?: number | null;
  difficulty?: string | null;
  examTargetMasteryStage?: string | null;
  interventionReason?: string | null;
  firstSightAtSelection?: boolean;
  struggleIntervention?: { isScaffold?: boolean; targetCardId?: string };
};

const PROTECTED_WAVE_REASONS = new Set([
  'failure_escalation', 'stuck_intervention', 'pre_teach', 'pre_teach_naive',
  'chronic_stuck_mcq', 'mcq_bridge_card', 'preemptive_scaffold',
  'statement_scaffold',
]);

const isProtectedWaveItem = (item: ReviewWaveItem): boolean =>
  PROTECTED_WAVE_REASONS.has(item.interventionReason ?? '');

function contentChallengeRank(item: ReviewWaveItem): number {
  if (typeof item.complexity === 'number' && Number.isFinite(item.complexity)) {
    const complexity = Math.max(1, item.complexity);
    return complexity <= 1 ? 0 : complexity === 2 ? 1 : 2;
  }
  return item.difficulty === 'hard' ? 2 : item.difficulty === 'easy' ? 0 : 1;
}

/**
 * Reorder an already selected batch around a small challenge wave. Membership
 * and mastery-stage groups are preserved. The first position is a warm-up,
 * valleys remain even when the mean is raised, and a hard run is capped at two
 * items when an easier alternative exists in that stage.
 */
export function applyReviewChallengeWave<T extends ReviewWaveItem>(
  items: readonly T[],
  level: ReviewChallengeLevel,
): T[] {
  const normalized = normalizeReviewChallengeLevel(level);
  if (normalized === 0 || items.length < 3) return [...items];

  const output: T[] = [];
  // Keep both sides of a teaching pair fixed, including across batch/stage
  // boundaries. Pinning only the scaffold can separate it from its anchor.
  const scaffoldTargets = new Set(items.flatMap(item =>
    item.struggleIntervention?.isScaffold && item.struggleIntervention.targetCardId
      ? [item.struggleIntervention.targetCardId] : [],
  ));
  const isFixed = (item: T): boolean => isProtectedWaveItem(item)
    || item.struggleIntervention?.isScaffold === true
    || (item.id !== undefined && scaffoldTargets.has(item.id));
  const waveChunk = (group: readonly T[]): T[] => {
    const result = [...group];
    const movable = group.filter(item => !isFixed(item));
    const remaining = [...movable];
    let hardRun = 0;
    for (let position = 0; position < group.length; position += 1) {
      const fixed = group[position];
      if (isFixed(fixed)) {
        hardRun = contentChallengeRank(fixed) === 2 ? hardRun + 1 : 0;
        continue;
      }
      const phase = (2 * Math.PI * position) / 6 - Math.PI / 2;
      const desired = Math.max(-1, Math.min(1, 0.85 * Math.sin(phase) + normalized * 0.08));
      // Preserve the existing modality pattern exactly; difficulty ordering must
      // not undo the card/question run guard or move reserved modality seats.
      const sameType = remaining.filter(item => item.type === fixed.type);
      const candidates = sameType.filter(item => hardRun < 2 || contentChallengeRank(item) < 2);
      const pool = candidates.length > 0 ? candidates : sameType;
      let bestIndex = 0;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of pool) {
        const index = remaining.indexOf(candidate);
        const rank = contentChallengeRank(candidate) - 1;
        const score = Math.abs(rank - desired);
        if (score < bestScore) {
          bestIndex = index;
          bestScore = score;
        }
      }
      const [picked] = remaining.splice(bestIndex, 1);
      result[position] = picked;
      hardRun = contentChallengeRank(picked) === 2 ? hardRun + 1 : 0;
    }
    return result;
  };
  // Absolute client-batch boundaries take precedence over curriculum groups.
  for (let batchStart = 0; batchStart < items.length; batchStart += 15) {
    const batch = items.slice(batchStart, batchStart + 15);
    let start = 0;
    while (start < batch.length) {
      const stage = batch[start].examTargetMasteryStage ?? '__ordinary__';
      let end = start + 1;
      while (end < batch.length && (batch[end].examTargetMasteryStage ?? '__ordinary__') === stage) end += 1;
      output.push(...waveChunk(batch.slice(start, end)));
      start = end;
    }
  }
  return output;
}
