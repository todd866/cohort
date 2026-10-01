import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { ReviewItem, ReviewStats } from './types';

interface UseCardReviewOptions {
  currentItem: ReviewItem | undefined;
  advanceToNext: () => void;
  setStats: React.Dispatch<React.SetStateAction<ReviewStats>>;
  registerResetCallback: (cb: () => void) => () => void;
  /** Interval-local signal that a canonical answer write was attempted. */
  onAnswerIntent?: (isCorrect: boolean) => void;
}

export function useCardReview({
  currentItem,
  advanceToNext,
  setStats,
  registerResetCallback,
  onAnswerIntent,
}: UseCardReviewOptions) {
  const [revealedBlanks, setRevealedBlanks] = useState(0);
  const cardAnswerRef = useRef<HTMLDivElement | null>(null);

  // Clear reveal state the moment the item changes, during render rather than
  // in an effect. The imperative reset callback below still runs for explicit
  // resets, but it left a window where a freshly advanced card rendered with
  // the previous card's reveal still standing. Harmless while that only
  // governed image mounting; once it governs shell width (itemUsesSidePane)
  // it renders the next card at the full 80rem before anything is revealed.
  const [lastItemId, setLastItemId] = useState(currentItem?.id);
  if (currentItem?.id !== lastItemId) {
    setLastItemId(currentItem?.id);
    setRevealedBlanks(0);
  }

  // Register reset callback
  useEffect(() => {
    return registerResetCallback(() => {
      setRevealedBlanks(0);
    });
  }, [registerResetCallback]);

  // Count blanks in current card
  const blankCount = useMemo(() => {
    if (!currentItem || currentItem.type !== 'card' || !currentItem.front) return 0;
    const matches = currentItem.front.match(/\[_{2,}\]/g);
    return matches?.length || 0;
  }, [currentItem]);

  // Card: reveal next blank (or show grading if all revealed)
  const handleReveal = useCallback(() => {
    const totalBlanks = blankCount > 0 ? blankCount : 1;
    setRevealedBlanks((prev) => Math.min(prev + 1, totalBlanks));
  }, [blankCount]);

  // Reveal the whole card at once. Space deliberately steps one blank at a
  // time, but on a multi-blank card that is one press per blank when the
  // learner already knows them all.
  const handleRevealAll = useCallback(() => {
    const totalBlanks = blankCount > 0 ? blankCount : 1;
    setRevealedBlanks(totalBlanks);
  }, [blankCount]);

  // Check if all blanks are revealed
  const cardFullyRevealed = useMemo(() => {
    const totalBlanks = blankCount > 0 ? blankCount : 1;
    return revealedBlanks >= totalBlanks;
  }, [blankCount, revealedBlanks]);

  // No post-reveal autoscroll on cards. Cloze answers fill in place above any
  // context/figure; scrolling would yank past the answer the student just
  // revealed. Peek-scroll is MCQ-only (long option lists push the explanation
  // below the fold) — see useMcqReview.

  // Card: grade (1-4) — stats + advance only; API call handled by useGrading
  const handleCardGrade = useCallback((quality: number) => {
    if (!currentItem || currentItem.type !== 'card') return;

    const isCorrect = quality >= 3;
    onAnswerIntent?.(isCorrect);
    setStats(prev => ({
      total: prev.total + 1,
      correct: isCorrect ? prev.correct + 1 : prev.correct,
    }));

    advanceToNext();
  }, [advanceToNext, currentItem, onAnswerIntent, setStats]);

  const handleCardContinue = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  return {
    revealedBlanks,
    handleRevealAll,
    blankCount,
    cardFullyRevealed,
    cardAnswerRef,
    handleReveal,
    handleCardGrade,
    handleCardContinue,
  };
}
