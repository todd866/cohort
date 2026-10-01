import type { PracticeReviewProvenance } from '@/lib/study/practice-review-focus';

/** Private practice-exam scaffold binding is omitted from the public build. */
export async function bindPracticeScaffoldDelivery(_input: unknown): Promise<{ deliveryId: string; practiceReview: PracticeReviewProvenance } | null> { return null; }
export async function reconcileCompletedPracticeScaffolds(_input: unknown): Promise<void> {}
