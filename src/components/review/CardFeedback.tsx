'use client';

import { useState } from 'react';
import { postContentRating } from '@/lib/review/content-rating';

interface CardFeedbackProps {
  cardId: string;
  itemType?: 'card' | 'question';
  /** Exact delivered item trace. Required for trusted good/bad telemetry. */
  serveDecisionId?: string;
  sourceComponent: string;
  liked?: boolean;
  onFeedback?: (action: 'like' | 'suppress') => void;
}

type ContentRating = 'good' | 'bad';

/**
 * Compact feedback buttons for cards and MCQs.
 * - Thumbs: delivery-scoped question quality telemetry
 * - Heart: Like this card (show more like it)
 * - Eye-slash: Don't show this card again
 *
 * Note: Flag with reasons is handled by the toolbar flag button in UnifiedReview
 */
export function CardFeedback({
  cardId,
  itemType = 'card',
  serveDecisionId,
  sourceComponent,
  liked = false,
  onFeedback,
}: CardFeedbackProps) {
  const [isLiked, setIsLiked] = useState(liked);
  const [showConfirm, setShowConfirm] = useState(false);
  const [qualityRating, setQualityRating] = useState<ContentRating | null>(null);
  const [isRatingSaving, setIsRatingSaving] = useState(false);

  const handleQualityRating = async (rating: ContentRating) => {
    if (!serveDecisionId || isRatingSaving) return;

    const previousRating = qualityRating;
    const nextRating = previousRating === rating ? null : rating;
    setQualityRating(nextRating);
    setIsRatingSaving(true);

    try {
      const stored = await postContentRating({
        itemType,
        itemId: cardId,
        serveDecisionId,
        rating: nextRating,
        sourceComponent,
      });
      if (!stored) throw new Error('Content rating was not saved');
    } catch {
      setQualityRating(previousRating);
    } finally {
      setIsRatingSaving(false);
    }
  };

  const handleLike = async () => {
    const wasLiked = isLiked;
    const action = wasLiked ? 'unlike' : 'like';
    setIsLiked(!wasLiked);

    try {
      await fetch('/api/cards/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: itemType, cardId, action }),
      });
      if (action === 'like') {
        onFeedback?.('like');
      }
    } catch {
      setIsLiked(wasLiked);
    }
  };

  const handleSuppress = async () => {
    try {
      await fetch('/api/cards/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'card', cardId, action: 'suppress' }),
      });
      onFeedback?.('suppress');
    } catch {
      // Silently fail
    }
    setShowConfirm(false);
  };

  if (itemType === 'card' && showConfirm) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--md-on-surface-variant)]">Hide this card?</span>
        <button
          onClick={handleSuppress}
          className="px-2 py-1 rounded bg-[var(--md-error-container)] text-[var(--md-on-error-container)] text-xs font-medium"
        >
          Yes, hide
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          className="px-2 py-1 rounded bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)] text-xs font-medium"
        >
          Cancel
        </button>
      </div>
    );
  }

  // Question heart/hide actions use a card-only persistence endpoint. Questions
  // therefore render only the delivery-scoped controls, and only when their
  // ServeDecision can anchor the event to the exact item the learner saw.
  if (itemType === 'question' && !serveDecisionId) return null;

  const itemLabel = itemType === 'question' ? 'question' : 'card';

  return (
    <div className="flex items-center gap-0.5">
      {serveDecisionId && (
        <>
          {(['good', 'bad'] as const).map((rating) => {
            const active = qualityRating === rating;
            const key = rating === 'good' ? 'g' : 'b';
            const label = active
              ? `Clear ${rating} ${itemLabel} rating (${key})`
              : `Mark as a ${rating} ${itemLabel} (${key})`;
            return (
              <button
                key={rating}
                type="button"
                disabled={isRatingSaving}
                onClick={() => handleQualityRating(rating)}
                aria-label={label}
                aria-pressed={active}
                title={label}
                className={`p-1.5 rounded-full disabled:cursor-wait disabled:opacity-40 ${
                  active
                    ? rating === 'good'
                      ? 'text-[var(--md-success)] bg-[var(--md-success-container)]'
                      : 'text-[var(--md-error)] bg-[var(--md-error-container)]'
                    : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'
                }`}
              >
                <ThumbIcon direction={rating === 'good' ? 'up' : 'down'} className="w-4 h-4" />
              </button>
            );
          })}
        </>
      )}

      {itemType === 'card' && (
        <>
          {/* Like button */}
          <button
            onClick={handleLike}
            className={`p-1 rounded-full transition-colors ${
              isLiked
                ? 'text-[var(--md-primary)] bg-[var(--md-primary-container)]'
                : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] opacity-50 hover:opacity-100'
            }`}
            title={isLiked ? 'Remove upvote' : 'Show me more cards like this'}
            aria-label={isLiked ? 'Remove upvote' : 'Show me more cards like this'}
          >
            <HeartIcon filled={isLiked} className="w-3.5 h-3.5" />
          </button>

          {/* Hide button */}
          <button
            onClick={() => setShowConfirm(true)}
            className="p-1 rounded-full text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] transition-colors opacity-50 hover:opacity-100"
            title="Hide this card — won't appear again"
            aria-label="Hide this card"
          >
            <HideIcon className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function ThumbIcon({ className, direction }: { className?: string; direction: 'up' | 'down' }) {
  return (
    <svg
      className={`${className ?? ''} ${direction === 'down' ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v12H3V10h4Z" />
      <path d="M7 20h11.2a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 19.4 10H14l.8-4.1A3.3 3.3 0 0 0 11.6 2L7 10v10Z" />
    </svg>
  );
}

function HeartIcon({ className, filled }: { className?: string; filled?: boolean }) {
  if (filled) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
      </svg>
    );
  }
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}

function HideIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
