'use client';

import type { ReviewFilter, ReviewItemType, ReviewMedia } from '@/lib/review/review-intent';
import type { ReviewFeedMode } from './hooks/useReviewFeedMode';
import { ChipNativeSelect } from '@/components/shared/Chip';

export type ReviewMode = 'mixed' | 'new' | 'due' | 'at-risk' | 'mcq' | 'image' | 'video' | 'media' | 'text';

interface ReviewModeSelectorProps {
  feedMode: ReviewFeedMode;
  reviewFilter?: ReviewFilter;
  itemType?: ReviewItemType;
  media?: ReviewMedia;
  canAccessVideo?: boolean;
  newRemaining: { cards: number; questions: number } | null;
  onChange: (mode: ReviewMode) => void;
  practiceExamHref?: string;
  /** Both No videos and No images are on: the picker reads Text only. */
  textOnly?: boolean;
}

/**
 * One compact, live control for every supported serving intent.
 *
 * Due/at-risk were previously URL-only contracts: the scheduler implemented
 * them, but a reviewer could not select them from the review surface.
 */
/** What each mode serves, shown as the picker's tooltip. Learner question,
 *  31 Oct 2026: does grading every at-risk card Easy mean they never return? */
export const MODE_HINTS: Record<ReviewMode, string> = {
  mixed: 'Due reviews, new items and questions, chosen by the scheduler',
  new: 'Only items you have not seen yet',
  due: 'Only reviews that are due now',
  'at-risk': 'Reviewed cards predicted to slip below mastery by exam day. Grade honestly: Easy pushes a card furthest out, but it still comes back',
  mcq: 'Only multiple-choice questions',
  image: 'Only items with an image',
  video: 'Only items with a video clip',
  media: 'Only items with an image or video',
  text: 'No images or videos: items whose picture or clip is the question are left out',
};

/**
 * Text only is the two media hides from Options, chosen from the picker
 * (owner, 31 Oct 2026). Choosing it turns both on and serves the mixed feed;
 * choosing anything else while it is on turns both off, so a single-choice
 * picker never hides a filter it does not show. null leaves the hides alone.
 */
export function textOnlyTransition(next: ReviewMode, textOnly: boolean): { hideMedia: boolean | null; mode: ReviewMode } {
  if (next === 'text') return { hideMedia: true, mode: 'mixed' };
  return { hideMedia: textOnly ? false : null, mode: next };
}

export function ReviewModeSelector({
  feedMode,
  reviewFilter,
  itemType,
  media,
  canAccessVideo = false,
  newRemaining,
  onChange,
  practiceExamHref,
  textOnly = false,
}: ReviewModeSelectorProps) {
  // Media and MCQ-only win the display: they change WHAT is served
  // rather than which slice of it, and the request drops the typed filter when
  // it is chosen (due/at-risk have no question-only lane).
  const baseMode: ReviewMode = media === 'image' || media === 'video'
    ? media
    : media === 'any'
      ? 'media'
      : itemType === 'question'
    ? 'mcq'
    : reviewFilter === 'due' || reviewFilter === 'at-risk'
      ? reviewFilter
      : reviewFilter === 'new' || feedMode === 'new-only'
        ? 'new'
        : 'mixed';
  const mode: ReviewMode = textOnly && baseMode === 'mixed' ? 'text' : baseMode;
  const newCount = newRemaining
    ? newRemaining.cards + newRemaining.questions
    : null;

  return (
    <ChipNativeSelect
      aria-label="Review mode"
      title={MODE_HINTS[mode]}
      value={mode}
      onChange={(event) => {
        if (event.target.value === "practice-exam" && practiceExamHref) window.location.assign(practiceExamHref);
        else onChange(event.target.value as ReviewMode);
      }}
      className="max-w-[8.5rem]"
    >
      <option value="mixed">Mixed</option>
      <option value="new">
        {newCount == null ? 'New only' : `New only (${newCount})`}
      </option>
      <option value="due">Due now</option>
      <option value="at-risk">At risk</option>
      <option value="mcq">MCQs only</option>
      <option value="image">Images only</option>
      {canAccessVideo ? (
        <option value="video">Videos only</option>
      ) : media === 'video' ? (
        <option value="video" disabled>Videos only (unavailable)</option>
      ) : null}
      <option value="media">Media only</option>
      <option value="text">Text only</option>
      {practiceExamHref && <option value="practice-exam">Practice exam</option>}
    </ChipNativeSelect>
  );
}
