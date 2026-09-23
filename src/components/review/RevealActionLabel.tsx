'use client';

import { useImageBlurPreference } from '@/components/media/useImageBlurPreference';
import { shouldGateClientImageMeta } from '@/lib/figures/types';
import type { ReviewItem } from './hooks/types';
import { reviewImageIsPrompt } from './image-role';

/** Describe the existing answer action without promising an image too early. */
export function RevealActionLabel({ item, remainingAnswers = 1 }: {
  item: ReviewItem;
  remainingAnswers?: number;
}) {
  const { blurImages } = useImageBlurPreference();
  const hasImage = Boolean(item.imageUrl || item.imageKey);
  const prompt = reviewImageIsPrompt(item.imageRole, item.imageMeta, item.front ?? item.stem);
  const concealed = hasImage && blurImages
    && shouldGateClientImageMeta(item.imageMeta, item.imageKey ?? item.imageUrl);
  const supplementary = hasImage && !prompt;
  const moreAnswers = remainingAnswers > 1;
  // The button says what pressing it does, not what is behind it. "+ image"
  // leaked this component's prompt/supplementary/blur branching into the label
  // for no gain — a figure explains itself once it is on screen. The only
  // distinction worth a word is whether blanks remain.
  const label = moreAnswers ? 'Show next answer' : 'Show answer';
  const shortcut = concealed && prompt ? 'Enter' : 'Space';
  const detail = concealed && prompt
    ? 'If concealed, Space shows the image first.'
    : supplementary && moreAnswers
      ? concealed ? 'Image available after the final answer.' : 'Image appears after the final answer.'
      : supplementary && concealed
        ? 'Image available after answering.'
        : null;
  const confidenceDetail = item.type === 'question' && item.deliveryId
    ? 'Then choose your confidence to reveal.'
    : null;

  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span>
        {label}
        <span className="hidden sm:inline font-normal text-[var(--md-on-surface-variant)]"> · {shortcut}</span>
      </span>
      {(detail || confidenceDetail) && (
        <span className="text-xs font-normal text-[var(--md-on-surface-variant)]">
          {[detail, confidenceDetail].filter(Boolean).join(' ')}
        </span>
      )}
    </span>
  );
}
