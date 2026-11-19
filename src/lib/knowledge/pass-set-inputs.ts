/**
 * The one place the pass set's inputs are resolved, so the audit script, the
 * scheduler and the profile readout rank facts identically.
 *
 * Domain weights come from the exam-target registry (`effectiveWeight` of each
 * official blueprint area), keyed by both code and label because
 * `Card.examDomain` stores the label. Taught topics are the course's undated
 * topic set for the rotation (teaching-topic-week.ts keeps the calendar behind
 * its boundary).
 */

import { getExamTargetDefinition } from '@/lib/exam-target/registry';
import { buildTaughtTopicSet } from '@/lib/curriculum/teaching-topic-week';
import { buildPassSet, type PassSet, type PassSetCard, type PassSetInputs } from './pass-set';

/** Rotations whose new-material intake is shaped by a pass set: those with an exam target. */
export function rotationHasPassSet(rotation: string): boolean {
  return getExamTargetDefinition(rotation) !== null;
}

export function passSetInputsFor(rotation: string, targetShare?: number): PassSetInputs {
  const domainWeights = new Map<string, number>();
  for (const domain of getExamTargetDefinition(rotation)?.domains ?? []) {
    domainWeights.set(domain.label, domain.effectiveWeight);
    domainWeights.set(domain.code, domain.effectiveWeight);
  }
  return {
    domainWeights,
    taughtTopics: buildTaughtTopicSet(rotation),
    ...(targetShare !== undefined ? { targetShare } : {}),
  };
}

const MEMO = new WeakMap<object, Map<string, PassSet | null>>();

/**
 * The pass set of `rotation` within a card pool. Memoised on the pool object,
 * so a shared cached pool computes it once per process and epoch, never per
 * request. Returns null for a rotation with no exam target.
 */
export function passSetForPool(
  pool: readonly (PassSetCard & { rotation: string })[],
  rotation: string,
): PassSet | null {
  let byRotation = MEMO.get(pool);
  if (!byRotation) {
    byRotation = new Map();
    MEMO.set(pool, byRotation);
  }
  if (byRotation.has(rotation)) return byRotation.get(rotation) ?? null;
  const result = rotationHasPassSet(rotation)
    ? buildPassSet(pool.filter((card) => card.rotation === rotation), passSetInputsFor(rotation))
    : null;
  byRotation.set(rotation, result);
  return result;
}
