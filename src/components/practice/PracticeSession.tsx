'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { ClozeCard } from './ClozeCard';
import { genClientRequestId } from '@/lib/client-request-id';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { isRetriableWriteStatus } from '@/lib/write-retry-policy';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from '@/lib/offline/owner';
import {
  fetchWithDeadline,
  STUDY_SESSION_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

interface Card {
  id: string;
  front: string;
  back: string;
  backs?: string[]; // Array of answers for multi-cloze one-by-one cards
  context?: string;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
  sourceComponent: string;
  week: number;
  liked: boolean;
}

interface SessionStats {
  total: number;
  reviewed: number;
  correct: number;
  phase: string;
  daysToExam: number | null;
}

interface PracticeSessionProps {
  rotation: string;
  rotationLabel: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function PracticeSession({ rotation, rotationLabel: _rotationLabel }: PracticeSessionProps) {
  const { data: session } = useSession();
  const [cards, setCards] = useState<Card[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [stats, setStats] = useState<SessionStats>({
    total: 0,
    reviewed: 0,
    correct: 0,
    phase: 'standard',
    daysToExam: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionComplete, setSessionComplete] = useState(false);

  const fetchCards = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Use unified-session endpoint - 4x faster than /api/cards/due
      const params = new URLSearchParams({ rotation, type: 'card', size: '50' });
      const res = await fetchWithDeadline(
        `/api/study/unified-session?${params}`,
        {},
        STUDY_SESSION_FETCH_DEADLINE_MS,
      );
      if (!res.ok) throw new Error('Failed to fetch cards');

      const data = await res.json();
      // Filter for cards only (unified-session can return cards + questions)
      const cardItems = (data.items || []).filter((item: { type: string }) => item.type === 'card');
      setCards(cardItems);
      setStats({
        total: data.stats?.totalItems || cardItems.length,
        reviewed: 0,
        correct: 0,
        phase: 'standard', // Unified endpoint doesn't return phase
        daysToExam: null, // Unified endpoint doesn't return exam date
      });
      setCurrentIndex(0);
      setSessionComplete(false);
    } catch (err) {
      setError('Failed to load practice cards');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [rotation]);

  // Fetch cards on mount
  useEffect(() => {
    fetchCards();
  }, [fetchCards]);

  const handleGrade = (quality: number) => {
    const card = cards[currentIndex];
    if (!card) return;
    const ownerLease = session?.user ? captureOfflineOwner() : null;

    // Send without blocking navigation. The body (including its idempotency
    // key) is constructed once and reused unchanged by retries and the outbox.
    if (ownerLease) {
      const url = '/api/cards/review';
      const body = {
        cardId: card.id,
        quality,
        clientRequestId: genClientRequestId(),
        ...captureReviewWriteClientContext(),
      };
      enqueueReview(url, body, ownerLease.ownerKey);
      void submitWithRetry(url, body, { ownerLease })
        .then((response) => {
          if (!isOfflineOwnerCurrent(ownerLease)) return;
          if (response.ok) {
            acknowledgeReview(url, body.clientRequestId, ownerLease.ownerKey);
            return;
          }
          if (isRetriableWriteStatus(response.status)) return;
          try {
            navigator.sendBeacon('/api/log/client-error', JSON.stringify({
              url,
              error: 'practice-review-deferred',
              status: response.status,
              ts: Date.now(),
            }));
          } catch { /* non-critical */ }
        })
        .catch(() => {
          // The write-ahead row remains available for replay.
        });
    }

    // Optimistically update stats only after the durable row exists.
    setStats((prev) => ({
      ...prev,
      reviewed: prev.reviewed + 1,
      correct: quality >= 3 ? prev.correct + 1 : prev.correct,
    }));
  };

  const handleNext = () => {
    if (currentIndex < cards.length - 1) {
      setCurrentIndex((prev) => prev + 1);
    } else {
      setSessionComplete(true);
    }
  };

  const handleRestart = () => {
    fetchCards();
  };

  const currentCard = cards[currentIndex];
  const progress = cards.length > 0 ? ((currentIndex + 1) / cards.length) * 100 : 0;

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-[var(--md-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[var(--md-on-surface-variant)]">Loading practice session...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-4">:(</div>
          <p className="text-[var(--md-error)] mb-4">{error}</p>
          <button
            onClick={fetchCards}
            className="px-6 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // No cards — show loading spinner (API should always return content now)
  if (cards.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="w-8 h-8 border-3 border-[var(--md-primary)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Session complete state
  if (sessionComplete) {
    const accuracy = stats.reviewed > 0 ? Math.round((stats.correct / stats.reviewed) * 100) : 0;

    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">
            {accuracy >= 80 ? ':D' : accuracy >= 60 ? ':)' : ':|'}
          </div>
          <h2 className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">
            Session Complete!
          </h2>
          <div className="grid grid-cols-3 gap-4 my-6">
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-[var(--md-primary)]">{stats.reviewed}</div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">Reviewed</div>
            </div>
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-green-600 dark:text-green-400">{stats.correct}</div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">Correct</div>
            </div>
            <div className="p-4 rounded-xl bg-[var(--md-surface-container)]">
              <div className="text-3xl font-bold text-[var(--md-tertiary)]">{accuracy}%</div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">Accuracy</div>
            </div>
          </div>
          <div className="flex gap-4 justify-center">
            <button
              onClick={handleRestart}
              className="px-6 py-2 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
            >
              Practice More
            </button>
            <a
              href={`/${rotation}`}
              className="px-6 py-2 rounded-xl border border-[var(--md-outline)] text-[var(--md-on-surface)] font-medium"
            >
              Back to Content
            </a>
          </div>
        </div>
      </div>
    );
  }

  // Active practice state
  return (
    <div>
      {/* Progress bar */}
      <div className="mb-6">
        <div className="flex justify-between text-sm text-[var(--md-on-surface-variant)] mb-2">
          <span>Card {currentIndex + 1} of {cards.length}</span>
          <span>{stats.correct} correct</span>
        </div>
        <div className="h-2 bg-[var(--md-surface-container)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--md-primary)] transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Exam phase indicator */}
      {stats.daysToExam !== null && stats.daysToExam <= 14 && (
        <div className={`mb-4 px-4 py-2 rounded-lg text-sm text-center ${
          stats.phase === 'final'
            ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200'
            : stats.phase === 'intensive'
            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-200'
            : 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200'
        }`}>
          {stats.daysToExam} days to exam - {stats.phase} mode
        </div>
      )}

      {/* Current card */}
      {currentCard && (
      <ClozeCard
        front={currentCard.front}
        back={currentCard.back}
        backs={currentCard.backs}
        context={currentCard.context}
        learnMore={currentCard.crosslinks?.primary ?? undefined}
        sourceComponent={currentCard.sourceComponent}
        week={currentCard.week}
        onGrade={handleGrade}
        onNext={handleNext}
      />
      )}

      {/* Guest warning */}
      {!session?.user && (
        <div className="mt-6 p-4 rounded-xl bg-[var(--md-surface-container)] border border-[var(--md-outline-variant)] text-center">
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Sign in to save your progress and unlock spaced repetition.
          </p>
        </div>
      )}
    </div>
  );
}
