import { describe, expect, it } from 'vitest';
import { isBridgeCardEligible, bridgeCardBlockedProgressWhere } from './bridge-card-eligibility';

describe('bridge card repetition policy', () => {
  const now = new Date('2026-09-13T00:30:00Z');
  const oldReview = new Date('2026-09-10T00:30:00Z');
  const future = new Date('2026-11-09T00:30:00Z');

  it.each(['mastered', 'reviewing', 'learning'])('parks a %s bridge until its exact due date even after the daily cooldown', (status) => {
    expect(isBridgeCardEligible({ status, lastReview: oldReview, nextDueAt: future }, now)).toBe(false);
    expect(isBridgeCardEligible({ status, lastReview: oldReview, nextDueAt: now }, now)).toBe(true);
  });

  it('allows an unseen fallback but does not treat missing lastReview as missing progress', () => {
    expect(isBridgeCardEligible(undefined, now)).toBe(true);
    expect(isBridgeCardEligible({ status: 'reviewing', lastReview: null, nextDueAt: future }, now)).toBe(false);
    expect(isBridgeCardEligible({ status: 'reviewing', lastReview: null, nextDueAt: now }, now)).toBe(true);
  });

  it.each(['reviewing', 'mastered', 'learning'])('rejects a %s card reviewed inside or exactly at the 24-hour cutoff', (status) => {
    const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
    for (const offset of [0, 1, 60_000]) {
      expect(isBridgeCardEligible({ status, lastReview: new Date(cutoff + offset), nextDueAt: now }, now)).toBe(false);
    }
    expect(isBridgeCardEligible({ status, lastReview: new Date(cutoff - 1), nextDueAt: now }, now)).toBe(true);
  });

  it('uses the supplied clock for both database disqualifications', () => {
    expect(bridgeCardBlockedProgressWhere('learner', now)).toEqual({
      userId: 'learner',
      OR: [
        { lastReview: { gte: new Date('2026-09-12T00:30:00Z') } },
        { nextDueAt: { gt: now } },
      ],
    });
  });
});
