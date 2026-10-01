/**
 * Answers already recorded for one DELIVERY of one review item, in this page.
 *
 * The review screen keeps the last graded item one step behind so a learner can
 * go back to it. Going back clears the item's answered state, and on a phone the
 * only way forward again is to answer it again, so every re-read became a
 * second, independent review seconds after the first, usually with the same
 * grade. The schedule was counting a re-read as a second attempt.
 *
 * So an answer is sent once per delivery. Giving the SAME answer again only
 * moves the learner on. A DIFFERENT answer is still sent, because that is a
 * correction and the learner means it.
 *
 * A delivery is identified by its serve decision, or failing that its batch.
 * An item with neither has no identity here and is never suppressed, because
 * a later genuine re-serve of the same item must always be recorded.
 */

export const ANSWERED_SLOT_CAPACITY = 200;

const answers = new Map<string, string>();

export function answeredSlotKey(input: {
  itemType: string;
  itemId: string;
  serveDecisionId?: string | null;
  batchId?: string | null;
}): string | null {
  if (input.serveDecisionId) return `${input.itemType}:${input.itemId}:sd:${input.serveDecisionId}`;
  if (input.batchId) return `${input.itemType}:${input.itemId}:batch:${input.batchId}`;
  return null;
}

export function isRepeatAnswer(key: string | null, answer: string): boolean {
  return key !== null && answers.get(key) === answer;
}

export function recordAnswer(key: string | null, answer: string): void {
  if (key === null) return;
  // Re-inserting moves the key to the newest position, so eviction is by recency.
  answers.delete(key);
  answers.set(key, answer);
  while (answers.size > ANSWERED_SLOT_CAPACITY) {
    const oldest = answers.keys().next().value;
    if (oldest === undefined) break;
    answers.delete(oldest);
  }
}

/** Tests only: each test starts from an empty page. */
export function clearAnsweredSlots(): void {
  answers.clear();
}
