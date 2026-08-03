'use client';

import type { ReviewFeedMode } from './hooks/useReviewFeedMode';

interface FeedModeToggleProps {
  feedMode: ReviewFeedMode;
  onChange: (next: ReviewFeedMode) => void;
  newRemaining: { cards: number; questions: number } | null;
}

export function FeedModeToggle({ feedMode, onChange, newRemaining }: FeedModeToggleProps) {
  const totalNew = newRemaining ? newRemaining.cards + newRemaining.questions : null;

  return (
    <div
      className="inline-flex rounded-full border border-[var(--md-outline-variant)] text-xs overflow-hidden"
      role="group"
      aria-label="Review feed mode"
    >
      <button
        type="button"
        onClick={() => onChange('mixed')}
        aria-pressed={feedMode === 'mixed'}
        className={`px-3 py-1 transition-colors ${
          feedMode === 'mixed'
            ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
            : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'
        }`}
      >
        Mixed
      </button>
      <button
        type="button"
        onClick={() => onChange('new-only')}
        aria-pressed={feedMode === 'new-only'}
        className={`px-3 py-1 transition-colors ${
          feedMode === 'new-only'
            ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
            : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'
        }`}
      >
        New only
        {feedMode === 'new-only' && totalNew != null && (
          <span className="ml-1 opacity-80">{'·'} {totalNew}</span>
        )}
      </button>
    </div>
  );
}
