export type SlotStep = 1 | 2 | 3;

export interface DueCard {
  cardId: string;
  stableId: string;
  variantGroupId: string | null;
  variantType: string | null;
  complexity: number;
  lastQuality: number | null;
  correctCount: number;
  targetStep?: SlotStep;
}

export interface SiblingCard {
  id: string;
  stableId: string;
  variantGroupId: string | null;
  variantType: string | null;
  complexity: number;
}

export interface ProximityLink {
  q: string;
  sim: number;
}

export interface SlotPools {
  siblings: SiblingCard[];
  seenCardIds: ReadonlySet<string>;
  proximity: ReadonlyMap<string, ProximityLink[]>;
  seenQuestionIds: ReadonlySet<string>;
  questionComplexity: ReadonlyMap<string, number>;
}

export type SlotDecision =
  | { kind: 'keep'; itemType: 'card'; id: string; reason: 'not-yet-correct' }
  | { kind: 'substitute'; itemType: 'card' | 'question'; id: string; step: SlotStep; reason: string }
  | { kind: 'empty'; supplyEmpty: true; stableId: string; reason: 'no-unseen-probe' };

export interface SlotOutcome {
  step: SlotStep;
  isCorrect: boolean;
  quality: number | null;
  responseTimeMs: number | null;
  learnerMedianMs: number | null;
  nearMiss: boolean;
}

export type OutcomeReading = 'too-easy' | 'in-band' | 'edge' | 'overshot';

export const SAME_FACT_FLOOR = 0.85;

/**
 * md3 grades on 0/1/3/5 (Again, Hard, Good, Easy): CardProgress.lastQuality and
 * ServeDecision.quality both use it. Hard (1) and Again (0) are misses; 3+ is correct.
 */
export const EASY = 5;

const STEP_REASON: Record<SlotStep, string> = {
  1: 'reword',
  2: 'same-fact-mcq',
  3: 'harder-same-fact-mcq',
};

export function isReword(s: { variantType: string | null; variantGroupId: string | null }): boolean {
  return s.variantType === null
    && s.variantGroupId !== null
    && !s.variantGroupId.startsWith('dup-');
}

export function defaultTargetStep(due: DueCard): SlotStep {
  if (due.targetStep !== undefined) return due.targetStep;
  if (due.correctCount >= 2 || (due.lastQuality ?? 0) >= EASY) return 2;
  return 1;
}

export function substituteDueSlot(due: DueCard, pools: SlotPools): SlotDecision {
  if (due.lastQuality === null || due.lastQuality <= 2) {
    return { kind: 'keep', itemType: 'card', id: due.cardId, reason: 'not-yet-correct' };
  }

  const target = defaultTargetStep(due);
  for (const step of searchOrder(target)) {
    const pick = pickStep(step, due, pools);
    if (pick) {
      return {
        kind: 'substitute',
        itemType: step === 1 ? 'card' : 'question',
        id: pick,
        step,
        reason: STEP_REASON[step],
      };
    }
  }

  return { kind: 'empty', supplyEmpty: true, stableId: due.stableId, reason: 'no-unseen-probe' };
}

export function readOutcome(o: SlotOutcome): OutcomeReading {
  if (o.isCorrect) {
    const fast = o.responseTimeMs !== null
      && o.learnerMedianMs !== null
      && o.responseTimeMs < o.learnerMedianMs;
    if ((o.quality === null || o.quality >= EASY) && fast) return 'too-easy';
    return 'in-band';
  }
  return o.nearMiss ? 'edge' : 'overshot';
}

export function nextTargetStep(o: SlotOutcome): SlotStep {
  const reading = readOutcome(o);
  if (reading === 'too-easy') return Math.min(o.step + 1, 3) as SlotStep;
  if (reading === 'overshot') return Math.max(o.step - 1, 1) as SlotStep;
  return o.step;
}

function searchOrder(target: SlotStep): SlotStep[] {
  const order: SlotStep[] = [];
  for (let step = target; step <= 3; step++) order.push(step as SlotStep);
  for (let step = target - 1; step >= 1; step--) order.push(step as SlotStep);
  return order;
}

function pickStep(step: SlotStep, due: DueCard, pools: SlotPools): string | null {
  if (step === 1) {
    const cards = pools.siblings
      .filter((card) => card.variantGroupId !== null
        && card.variantGroupId === due.variantGroupId
        && isReword(card)
        && card.id !== due.cardId
        && !pools.seenCardIds.has(card.id))
      .sort((a, b) => {
        const distance = Math.abs(a.complexity - due.complexity) - Math.abs(b.complexity - due.complexity);
        return distance !== 0 ? distance : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    return cards[0]?.id ?? null;
  }

  const links = (pools.proximity.get(due.stableId) ?? [])
    .filter((link) => link.sim >= SAME_FACT_FLOOR && !pools.seenQuestionIds.has(link.q))
    .filter((link) => step === 2 || (pools.questionComplexity.get(link.q) ?? -Infinity) > due.complexity)
    .sort((a, b) => (b.sim - a.sim) || (a.q < b.q ? -1 : a.q > b.q ? 1 : 0));
  return links[0]?.q ?? null;
}
