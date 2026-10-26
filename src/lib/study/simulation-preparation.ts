import registry from './simulation-item-map.json';
import type { SimulationFocus } from './simulation-focus';

type RecallState = 'unknown' | 'weak' | 'due' | 'recalled';

/**
 * Same grade rule as the simulation learner plan: below Good is weak, a
 * successful grade whose next review has arrived is due, and a successful
 * grade still in the future is held. This copy stays here so the public
 * scheduler does not import the private case planner.
 */
function recallState(row: Pick<SimulationPreparationEvidence, 'totalReviews' | 'lastQuality' | 'lastReview' | 'nextDueAt'>, now: Date): RecallState {
  if (row.totalReviews < 1 || row.lastQuality === null || !row.lastReview
    || !Number.isFinite(row.lastReview.getTime()) || row.lastReview > now) return 'unknown';
  if (row.lastQuality < 3) return 'weak';
  const due = row.nextDueAt ?? new Date(0);
  if (!Number.isFinite(due.getTime()) || due <= now) return 'due';
  return 'recalled';
}

export function isSimulationPreparationHeld(
  row: Pick<SimulationPreparationEvidence, 'totalReviews' | 'lastQuality' | 'lastReview' | 'nextDueAt'>,
  now: Date,
): boolean {
  return recallState(row, now) === 'recalled';
}

/** Reviewed preparation cards for the active simulation topics. */
export function simulationPreparationStableIds(focus: SimulationFocus | null | undefined): string[] {
  if (!focus) return [];
  const topics = new Set(focus.topics);
  return registry.records.filter(record => topics.has(record.topic)).map(record => record.stableId);
}

export interface SimulationPreparationEvidence {
  id: string;
  stableId: string;
  lastQuality: number | null;
  totalReviews: number;
  lastReview: Date | null;
  nextDueAt: Date | null;
}

function preparationRank(state: RecallState): number {
  if (state === 'weak') return 0;
  if (state === 'due') return 1;
  if (state === 'unknown') return 2;
  return 3;
}

/**
 * Misses first, then anything not currently held. A Good or Easy grade whose
 * next review is still in the future drops out: that card is held.
 */
export function orderUnrecalledSimulationPreparation<T extends SimulationPreparationEvidence>(
  rows: readonly T[],
  now: Date,
): T[] {
  const stateOf = (row: T) => recallState(row, now);
  return rows.filter(row => stateOf(row) !== 'recalled').sort((a, b) => {
    const byState = preparationRank(stateOf(a)) - preparationRank(stateOf(b));
    if (byState) return byState;
    const byQuality = (a.lastQuality ?? 99) - (b.lastQuality ?? 99);
    if (byQuality) return byQuality;
    return (a.lastReview?.getTime() ?? 0) - (b.lastReview?.getTime() ?? 0);
  });
}
