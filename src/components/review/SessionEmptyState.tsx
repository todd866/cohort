'use client';

import Link from 'next/link';
import { rotationLabel } from '@/lib/rotation-labels';
import type { ReviewFeedMode } from './hooks/useReviewFeedMode';

interface SessionStats {
  total: number;
  correct: number;
}

interface NewRemaining {
  cards: number;
  questions: number;
}

interface SessionEmptyStateProps {
  isExhausted: boolean;
  feedMode: ReviewFeedMode;
  newRemaining: NewRemaining | null | undefined;
  /** Set when called from the "items array empty" branch — shows a Refresh button. Otherwise omits it. */
  showRefresh?: boolean;
  /** Show session stats (only after at least one review). */
  stats?: SessionStats;
  /** Current explicit rotation focus. Null means the normal scheduled blend. */
  focusRotation?: string | null;
  /** Whether this review surface can enter dedicated focused practice. */
  canChooseFocus?: boolean;
  /** Guest remediation must preserve its post-sign-in destination. */
  isGuest?: boolean;
  onFetch: () => void;
  onFeedModeChange?: (next: ReviewFeedMode) => void;
  onFocusRotationChange?: (next: string | null) => void;
}

interface SessionDebriefProps {
  stats: SessionStats;
  feedMode: ReviewFeedMode;
  focusRotation: string | null;
  canChooseFocus: boolean;
  isGuest: boolean;
  onFetch: () => void;
  onFeedModeChange?: (next: ReviewFeedMode) => void;
  onFocusRotationChange?: (next: string | null) => void;
}

function SessionDebrief({
  stats,
  feedMode,
  focusRotation,
  canChooseFocus,
  isGuest,
  onFetch,
  onFeedModeChange,
  onFocusRotationChange,
}: SessionDebriefProps) {
  const correct = Math.min(stats.total, Math.max(0, stats.correct));
  const misses = Math.max(0, stats.total - correct);
  const focusLabel = focusRotation ? rotationLabel(focusRotation) : null;
  const remediationPath = '/learn?lookbackDays=1';
  const remediationHref = isGuest
    ? `/auth/signin?source=session-remediation&callbackUrl=${encodeURIComponent(remediationPath)}`
    : remediationPath;
  const actionClass =
    'inline-flex min-h-11 w-full items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition-colors';
  const startScheduledBlock = () => {
    if (feedMode === 'new-only' && onFeedModeChange) {
      onFeedModeChange('mixed');
    } else {
      onFetch();
    }
  };
  const returnToSchedule = () => {
    if (feedMode === 'new-only') onFeedModeChange?.('mixed');
    onFocusRotationChange?.(null);
  };

  return (
    <section
      aria-labelledby="session-complete-title"
      className="mx-auto max-w-xl px-4 py-10"
    >
      <div className="rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-5 sm:p-6">
        <div className="text-center">
          <p className="text-sm font-medium text-[var(--md-primary)]">Block finished</p>
          <h2
            id="session-complete-title"
            className="mt-1 text-xl font-semibold text-[var(--md-on-surface)]"
          >
            Session complete
          </h2>
        </div>

        <dl
          aria-label="Session result"
          className="mt-5 grid grid-cols-3 divide-x divide-[var(--md-outline-variant)] rounded-xl bg-[var(--md-surface)] py-3"
        >
          <div className="flex flex-col px-2 text-center">
            <dt className="order-2 mt-0.5 text-xs text-[var(--md-on-surface-variant)]">Reviewed</dt>
            <dd className="order-1 text-xl font-semibold text-[var(--md-on-surface)]">{stats.total}</dd>
          </div>
          <div className="flex flex-col px-2 text-center">
            <dt className="order-2 mt-0.5 text-xs text-[var(--md-on-surface-variant)]">Correct</dt>
            <dd className="order-1 text-xl font-semibold text-[var(--md-on-surface)]">{correct}</dd>
          </div>
          <div className="flex flex-col px-2 text-center">
            <dt className="order-2 mt-0.5 text-xs text-[var(--md-on-surface-variant)]">To revisit</dt>
            <dd className="order-1 text-xl font-semibold text-[var(--md-on-surface)]">{misses}</dd>
          </div>
        </dl>

        {misses > 0 ? (
          <div className="mt-5">
            <Link
              href={remediationHref}
              className={`${actionClass} bg-[var(--md-primary)] text-[var(--md-on-primary)] hover:opacity-90`}
            >
              Fix today’s misses
            </Link>
            <p className="mt-2 text-center text-xs text-[var(--md-on-surface-variant)]">
              Review the items that need another look while the context is fresh.
            </p>
          </div>
        ) : (
          <p className="mt-5 text-center text-sm text-[var(--md-on-surface-variant)]">
            Nothing from this block needs remediation.
          </p>
        )}

        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {focusRotation ? (
            <button
              type="button"
              onClick={onFetch}
              className={`${actionClass} border border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]`}
            >
              Another {focusLabel} block
            </button>
          ) : canChooseFocus ? (
            <Link
              href="/?filter=at-risk"
              className={`${actionClass} border border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]`}
            >
              Practice at-risk items
            </Link>
          ) : null}

          {focusRotation && onFocusRotationChange ? (
            <button
              type="button"
              onClick={returnToSchedule}
              className={`${actionClass} bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] hover:opacity-90`}
            >
              Back to scheduled review
            </button>
          ) : (
            <button
              type="button"
              onClick={startScheduledBlock}
              className={`${actionClass} bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)] hover:opacity-90`}
            >
              Another scheduled block
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Renders the "no items right now" UI.
 *
 * Three sub-states:
 *  - feedMode === 'new-only' && exhausted: scheduler may still have unseen items;
 *    distinguishes "truly out" (newRemaining is 0/null) from "scheduler couldn't pick".
 *  - exhausted (mixed): plain "session complete" / "no cards".
 *  - else: spinner (caller is responsible for triggering a fetch).
 */
export function SessionEmptyState({
  isExhausted,
  feedMode,
  newRemaining,
  showRefresh,
  stats,
  focusRotation = null,
  canChooseFocus = false,
  isGuest = false,
  onFetch,
  onFeedModeChange,
  onFocusRotationChange,
}: SessionEmptyStateProps) {
  const newRemainingTotal = newRemaining ? newRemaining.cards + newRemaining.questions : null;

  if (isExhausted && stats && stats.total > 0) {
    return (
      <SessionDebrief
        stats={stats}
        feedMode={feedMode}
        focusRotation={focusRotation}
        canChooseFocus={canChooseFocus}
        isGuest={isGuest}
        onFetch={onFetch}
        onFeedModeChange={onFeedModeChange}
        onFocusRotationChange={onFocusRotationChange}
      />
    );
  }

  if (isExhausted && feedMode === 'new-only') {
    const trulyExhausted = newRemainingTotal === 0 || newRemainingTotal === null;
    return (
      <div className="text-center py-12">
        <p className="text-lg font-medium text-[var(--md-on-surface)] mb-2">
          {trulyExhausted ? 'All caught up on new content' : 'Nothing more right now'}
        </p>
        {stats && stats.total > 0 && (
          <p className="text-[var(--md-on-surface-variant)] mb-6">
            {stats.correct}/{stats.total} correct this session
          </p>
        )}
        <p className="text-sm text-[var(--md-on-surface-variant)] mb-6">
          {trulyExhausted ? (
            <>
              You&apos;ve reviewed every new card in this rotation. Switch to{' '}
              <button
                onClick={() => onFeedModeChange?.('mixed')}
                className="underline hover:text-[var(--md-primary)]"
              >
                Mixed
              </button>{' '}
              to keep going.
            </>
          ) : (
            <>
              The scheduler couldn&apos;t pick more new items this round
              {newRemainingTotal != null ? ` (${newRemainingTotal} unseen still in the pool)` : ''}.
              Try refreshing, or switch to{' '}
              <button
                onClick={() => onFeedModeChange?.('mixed')}
                className="underline hover:text-[var(--md-primary)]"
              >
                Mixed
              </button>
              .
            </>
          )}
        </p>
        {showRefresh && !trulyExhausted && (
          <button onClick={onFetch} className="text-[var(--md-primary)] text-sm hover:underline">
            Refresh
          </button>
        )}
      </div>
    );
  }

  if (isExhausted) {
    if (showRefresh) {
      return (
        <div className="text-center py-12">
          <p className="text-lg font-medium text-[var(--md-on-surface)] mb-2">
            No cards available right now
          </p>
          <p className="text-sm text-[var(--md-on-surface-variant)] mb-6">
            Content may still be loading for your rotation. Check back soon.
          </p>
          <button onClick={onFetch} className="text-[var(--md-primary)] text-sm hover:underline">
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="text-center py-12">
        <p className="text-lg font-medium text-[var(--md-on-surface)] mb-2">
          Session complete
        </p>
        {stats && stats.total > 0 && (
          <p className="text-[var(--md-on-surface-variant)] mb-6">
            {stats.correct}/{stats.total} correct
          </p>
        )}
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          You&apos;ve reviewed all available cards. Come back later for more.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[200px]">
      <div className="w-8 h-8 border-3 border-[var(--md-primary)] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
