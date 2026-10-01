'use client';

import type { ReviewFilter, ReviewItemType } from '@/lib/review/review-intent';
import type { ReviewFeedMode } from './hooks/useReviewFeedMode';

export type ReviewMode = 'mixed' | 'new' | 'due' | 'at-risk' | 'mcq';

interface ReviewModeSelectorProps {
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter;
  itemType?: ReviewItemType;
  newRemaining: { cards: number; questions: number } | null;
  onChange: (mode: ReviewMode) => void;
  practiceExamHref?: string;
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
  itemType,
  newRemaining,
  onChange,
  practiceExamHref,
}: ReviewModeSelectorProps) {
  // MCQ-only wins the display: it is the one mode that changes WHAT is served
  // rather than which slice of it, and the request drops the typed filter when
  // it is chosen (due/at-risk have no question-only lane).
  const mode: ReviewMode = itemType === 'question'
    ? 'mcq'
    : reviewFilter === 'due' || reviewFilter === 'at-risk'
      ? reviewFilter
      : reviewFilter === 'new' || feedMode === 'new-only'
        ? 'new'
        : 'mixed';
  const newCount = newRemaining
    ? newRemaining.cards + newRemaining.questions
    : null;

  return (
    <label className="inline-flex min-w-0 items-center">
      <span className="sr-only">Review mode</span>
      <select
        aria-label="Review mode"
        value={mode}
        onChange={(event) => {
          if (event.target.value === "practice-exam" && practiceExamHref) window.location.assign(practiceExamHref);
          else onChange(event.target.value as ReviewMode);
        }}
        className="min-w-0 max-w-[8.5rem] truncate rounded-full border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)]"
      >
        <option value="mixed">Mixed</option>
        <option value="new">
          {newCount == null ? 'New only' : `New only (${newCount})`}
        </option>
        <option value="due">Due now</option>
        <option value="at-risk">At risk</option>
        <option value="mcq">MCQs only</option>
        {practiceExamHref && <option value="practice-exam">Practice exam</option>}
      </select>
    </label>
  );
}
