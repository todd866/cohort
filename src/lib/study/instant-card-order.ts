/**
 * Card order on the instant lane: cards the learner has seen and that are due
 * come first, most overdue first; everything else keeps its shuffled order.
 *
 * Pure: no I/O and no clock. The caller supplies the shuffled list, the
 * learner's progress rows and `now`. "Due" is the same notion the lane's
 * egress due-gate uses (`isCardDueForSelection`: nextDueAt at or before now).
 * A parked card (suppressed, flagged, retired or leech-suppressed) earns no
 * boost; this does not change eligibility, only who goes first.
 *
 * A learner with no progress gets the input back unchanged, so guests and new
 * learners see exactly the shuffle they saw before.
 */
import { isCardDueForSelection } from '@/lib/knowledge/card-due-eligibility';

export type InstantCardOrderMode = 'overdue-first' | 'shuffle';

/** Selection-policy id recorded with each delivered row, per mode. */
export const INSTANT_OVERDUE_FIRST_POLICY = 'instant-overdue-first-v1';

/** Read the kill switch once per request: `MD3_INSTANT_CARD_ORDER=shuffle`. */
export function instantCardOrderMode(
  env: Record<string, string | undefined> = process.env,
): InstantCardOrderMode {
  return env.MD3_INSTANT_CARD_ORDER?.trim().toLowerCase() === 'shuffle' ? 'shuffle' : 'overdue-first';
}

/**
 * Stable partition-and-sort: items flagged `due` first, largest `overdue`
 * first, input order on ties; the rest follow in input order. Returns a copy.
 */
export function orderSeenDueFirst<T>(
  items: readonly T[],
  key: (item: T) => { due: boolean; overdue: number },
): T[] {
  return items
    .map((item, index) => ({ item, index, ...key(item) }))
    .sort((a, b) => (
      Number(b.due) - Number(a.due)
      || (a.due && b.due ? b.overdue - a.overdue : 0)
      || a.index - b.index
    ))
    .map((entry) => entry.item);
}

export interface InstantCardProgress {
  nextDueAt: Date | null;
  /** Suppressed, flagged, retired or leech-suppressed: never boosted. */
  parked?: boolean;
}

export function orderCardsOverdueFirst<T extends { id: string }>(
  shuffled: readonly T[],
  progress: ReadonlyMap<string, InstantCardProgress>,
  now: Date,
): T[] {
  if (progress.size === 0) return [...shuffled];
  return orderSeenDueFirst(shuffled, (card) => {
    const row = progress.get(card.id);
    if (!row || row.parked || !isCardDueForSelection(row.nextDueAt, now)) {
      return { due: false, overdue: 0 };
    }
    return { due: true, overdue: row.nextDueAt ? now.getTime() - row.nextDueAt.getTime() : 0 };
  });
}

/** Cards the ordering would move forward: seen, not parked, and due. */
export function dueCardCount(
  cards: readonly { id: string }[],
  progress: ReadonlyMap<string, InstantCardProgress>,
  now: Date,
): number {
  let count = 0;
  for (const card of cards) {
    const row = progress.get(card.id);
    if (row && !row.parked && isCardDueForSelection(row.nextDueAt, now)) count += 1;
  }
  return count;
}
