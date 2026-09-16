'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import {
  isEditableShortcutTarget,
  isInteractiveActivationTarget,
} from '@/components/review/hooks/keyboardTarget';
import { useImageBlurPreference } from './useImageBlurPreference';

export interface SensitiveMediaGateProps {
  /**
   * Identifies this occurrence of the media. Include the card/question id so
   * consent never carries into the next review item that reuses this component.
   */
  consentKey: string;
  /** Non-sensitive media passes through without adding a wrapper or control. */
  sensitive?: boolean;
  children: ReactNode;
  /** Optional alternative to showing the image, such as advancing the review. */
  onSkip?: () => void;
  /** Overrides the review-specific keyboard hint for alternate skip semantics. */
  skipInstruction?: string;
  /**
   * While concealed, capture an unmodified page-level Space shortcut to show
   * the image. Enter remains available to the review's reveal/skip shortcut.
   * Focused controls retain their native Enter/Space activation.
   */
  captureReviewSpace?: boolean;
}

/**
 * Soft consent boundary for reviewed intimate or confronting clinical media.
 *
 * The media stays mounted under a strong blur until the learner opts in.
 * Each identity is a keyed consent occurrence, so moving away and later
 * returning creates a fresh concealed boundary.
 */
export function SensitiveMediaGate(props: SensitiveMediaGateProps) {
  const { blurImages } = useImageBlurPreference();
  const { consentKey, ...occurrenceProps } = props;
  // Restart only the media's local consent when the setting changes. Turning
  // blur back on must conceal an image previously shown by hand; its parent
  // CardImage and the learner's answer state remain mounted and unchanged.
  return (
    <SensitiveMediaOccurrence
      key={`${consentKey}:${blurImages}`}
      {...occurrenceProps}
      blurImages={blurImages}
    />
  );
}

function SensitiveMediaOccurrence({
  sensitive = false,
  children,
  onSkip,
  skipInstruction,
  captureReviewSpace = false,
  blurImages,
}: Omit<SensitiveMediaGateProps, 'consentKey'> & { blurImages: boolean }) {
  const descriptionId = useId();
  const [shownByConsent, setShownByConsent] = useState(false);

  const shown = !sensitive || !blurImages || shownByConsent;
  const showImage = useCallback(() => {
    setShownByConsent(true);
  }, []);

  useEffect(() => {
    if (!captureReviewSpace || !sensitive || shown) return;

    const handleReviewSpace = (event: KeyboardEvent) => {
      if (event.key !== ' ') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.defaultPrevented) return;
      if (isEditableShortcutTarget(event.target)) return;
      if (isInteractiveActivationTarget(event.target)) return;

      event.preventDefault();
      // The existing review keyboard listens on window in the bubble phase.
      // Consume this shortcut before it can also reveal/advance the answer.
      event.stopImmediatePropagation();
      showImage();
    };

    window.addEventListener('keydown', handleReviewSpace, true);
    return () => window.removeEventListener('keydown', handleReviewSpace, true);
  }, [captureReviewSpace, sensitive, showImage, shown]);

  if (!sensitive) return <>{children}</>;
  if (shown) return <>{children}</>;

  return (
    <div
      role="group"
      aria-label="Sensitive media"
      aria-describedby={descriptionId}
      data-sensitive-media-state="concealed"
      className="relative overflow-hidden rounded-lg"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none select-none"
        style={{
          filter: 'blur(22px)',
          transform: 'scale(1.06)',
          transformOrigin: 'center',
        }}
      >
        {children}
      </div>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center text-[var(--md-on-surface)]"
        style={{
          backgroundColor: 'color-mix(in srgb, var(--md-surface) 42%, transparent)',
        }}
      >
        <div>
          <p className="font-medium">Sensitive medical image</p>
          <p
            id={descriptionId}
            className="mt-1 text-sm text-[var(--md-on-surface-variant)]"
          >
            Blurred until you choose to show it.
          </p>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={showImage}
            className="min-h-11 min-w-11 rounded-lg bg-[var(--md-primary)] px-4 py-2 font-medium text-[var(--md-on-primary)]"
          >
            Show image
          </button>
          {onSkip && (
            <button
              type="button"
              onClick={onSkip}
              className="min-h-11 min-w-11 rounded-lg border border-[var(--md-outline)] bg-[var(--md-surface)] px-4 py-2 font-medium text-[var(--md-on-surface)]"
            >
              Skip image
            </button>
          )}
        </div>
        {captureReviewSpace && (
          <p className="text-xs text-[var(--md-on-surface-variant)]">
            {skipInstruction ?? (onSkip
              ? 'Space to show · Enter to reveal the answer without viewing'
              : 'Space to show')}
          </p>
        )}
      </div>
    </div>
  );
}
