'use client';

import type { ReviewFilter } from '@/lib/review/review-intent';
import type { ReviewFeedMode } from './hooks/useReviewFeedMode';

export type ReviewMode = 'mixed' | 'new' | 'due' | 'at-risk';

interface ReviewModeSelectorProps {
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter;
  newRemaining: { cards: number; questions: number } | null;
  onChange: (mode: ReviewMode) => void;
}

/**
 * One compact, live control for every supported serving intent.
 *
 * Due/at-risk were previously URL-only contracts: the scheduler implemented
 * them, but a reviewer could not select them from the review surface.
 */
export function ReviewModeSelector({
  feedMode,
  reviewFilter,
  newRemaining,
  onChange,
}: ReviewModeSelectorProps) {
  const mode: ReviewMode = reviewFilter === 'due' || reviewFilter === 'at-risk'
    ? reviewFilter
    : reviewFilter === 'new' || feedMode === 'new-only'
      ? 'new'
      : 'mixed';
  const newCount = newRemaining
    ? newRemaining.cards + newRemaining.questions
    : null;

  return (
    <label className="inline-flex items-center">
      <span className="sr-only">Review mode</span>
      <select
        aria-label="Review mode"
        value={mode}
        onChange={(event) => onChange(event.target.value as ReviewMode)}
        className="max-w-[8.5rem] rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)]"
      >
        <option value="mixed">Mixed</option>
        <option value="new">
          {newCount == null ? 'New only' : `New only (${newCount})`}
        </option>
        <option value="due">Due now</option>
        <option value="at-risk">At risk</option>
      </select>
    </label>
  );
}
