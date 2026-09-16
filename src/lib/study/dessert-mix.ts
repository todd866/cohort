/**
 * Post-commitment "dessert" mix for the current exam objective.
 *
 * Before the daily commitment is met, other-source share is zero. At unlock the
 * default batch aims for ~80% native / 20% other. Further overshoot raises the
 * other-source share and, within those seats, how many may be unmapped
 * entitled source cards rather than target-adjacent ones.
 */

export function dessertOvershootRatio(
  answeredToday: number,
  studyGoal: number,
): number {
  if (!Number.isFinite(answeredToday) || answeredToday < 0) return 0;
  if (!Number.isSafeInteger(studyGoal) || studyGoal <= 0) return 0;
  if (answeredToday < studyGoal) return 0;
  return answeredToday / studyGoal;
}

/**
 * Fraction of a batch that may be filled by entitled other-source items.
 * 1.0× → 0.20, 1.5× → 0.50, 2.0× → 0.80, ≥2.5× → 0.90.
 */
export function dessertOtherSourceShare(overshoot: number): number {
  if (!Number.isFinite(overshoot) || overshoot < 1) return 0;
  if (overshoot >= 2.5) return 0.9;
  if (overshoot >= 2) {
    return 0.8 + (0.1 * ((overshoot - 2) / 0.5));
  }
  if (overshoot >= 1.5) {
    return 0.5 + (0.3 * ((overshoot - 1.5) / 0.5));
  }
  return 0.2 + (0.3 * ((overshoot - 1) / 0.5));
}

/** Whole seats for other-source items; never consumes the entire batch. */
export function dessertCrossSourceSlots(
  batchSize: number,
  otherSourceShare: number,
): number {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) return 0;
  if (!Number.isFinite(otherSourceShare) || otherSourceShare <= 0) return 0;
  const raw = Math.floor(batchSize * Math.min(1, otherSourceShare));
  return Math.min(batchSize - 1, Math.max(0, raw));
}

/**
 * Of the other-source seats, how many may be unmapped ("random") entitled
 * source cards. Just after unlock every dessert seat stays adjacent-only.
 */
export function dessertUnmappedSlots(
  crossSourceSlots: number,
  overshoot: number,
): number {
  if (!Number.isSafeInteger(crossSourceSlots) || crossSourceSlots <= 0) return 0;
  if (!Number.isFinite(overshoot) || overshoot < 1) return 0;
  // 1.0× → 0%, 1.5× → ~33%, 2.0× → 75%, ≥2.5× → 90% of dessert seats.
  let exploreShare = 0;
  if (overshoot >= 2.5) exploreShare = 0.9;
  else if (overshoot >= 2) exploreShare = 0.75 + (0.15 * ((overshoot - 2) / 0.5));
  else if (overshoot >= 1.5) exploreShare = (1 / 3) + (((0.75 - (1 / 3)) * ((overshoot - 1.5) / 0.5)));
  else exploreShare = 0;
  return Math.min(crossSourceSlots, Math.floor(crossSourceSlots * exploreShare));
}
