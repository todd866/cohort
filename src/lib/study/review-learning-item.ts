import { cardEligibleForReviewLearning, questionEligibleForReviewLearning } from './review-learning-policy';
import type { UnifiedItem } from './unified-session-types';

/** Pure parity boundary for online, cached and offline ordinary review. */
export function itemMatchesReviewLearning(
  item: Pick<UnifiedItem, 'type' | 'id' | 'complexity' | 'difficulty'>,
  level: number,
  gapQuestionIds: ReadonlySet<string> = new Set(),
): boolean {
  if (item.type === 'card') return cardEligibleForReviewLearning(item.complexity, level);
  if (item.type === 'question') return questionEligibleForReviewLearning(level, {
    difficulty: item.difficulty,
    demonstratedGap: gapQuestionIds.has(item.id),
  });
  return level !== 2 && level !== -2;
}

