import { createHash } from 'node:crypto';
import type { PracticeReviewPaper } from './practice-review-focus';

/** Content fingerprint; a reordered paper can still align its answers by ID. */
export function practiceReviewPaperVersion<T extends PracticeReviewPaper & { id: string }>(paper: T): string {
  return createHash('sha256').update(JSON.stringify({
    ...paper,
    items: [...paper.items].sort((left, right) => left.id.localeCompare(right.id)),
  })).digest('hex');
}
