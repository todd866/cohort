import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { ReviewItem, ReviewStats } from './types';
import { imageIsPrompt } from '../CardItemView';
import { revealScrollBlock } from './reveal-scroll';

interface UseCardReviewOptions {
  currentItem: ReviewItem | undefined;
  advanceToNext: () => void;
  setStats: React.Dispatch<React.SetStateAction<ReviewStats>>;
  registerResetCallback: (cb: () => void) => () => void;
  shouldAutoScroll: () => boolean;
  scrollBehavior: () => ScrollBehavior;
  isOffscreen: (element: HTMLElement, marginPx?: number) => boolean;
}

export function useCardReview({
  currentItem,
  advanceToNext,
  setStats,
  registerResetCallback,
  shouldAutoScroll,
  scrollBehavior,
  isOffscreen,
}: UseCardReviewOptions) {
  const [revealedBlanks, setRevealedBlanks] = useState(0);
  const cardAnswerRef = useRef<HTMLDivElement | null>(null);
  const lastCardAutoScrollId = useRef<string | null>(null);

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

  // Check if all blanks are revealed
  const cardFullyRevealed = useMemo(() => {
    const totalBlanks = blankCount > 0 ? blankCount : 1;
    return revealedBlanks >= totalBlanks;
  }, [blankCount, revealedBlanks]);

  // Reset per-item auto-scroll state
  useEffect(() => {
    if (!cardFullyRevealed) lastCardAutoScrollId.current = null;
  }, [cardFullyRevealed]);

  // After revealing all blanks, scroll answer/context into view — except when the
  // figure is the prompt (above the cloze). On those cards the filled blanks are
  // already on screen above a large image; scrolling to the context block below
  // pushes the answer off the top (the reference learner flag: "auto scroll-down… scroll back up").
  useEffect(() => {
    if (!currentItem || currentItem.type !== 'card') return;
    if (!cardFullyRevealed) return;
    if (!shouldAutoScroll()) return;
    if (imageIsPrompt(currentItem.imageMeta)) return;

    const answerEl = cardAnswerRef.current;
    if (!answerEl) return;
    if (lastCardAutoScrollId.current === currentItem.id) return;
    if (!isOffscreen(answerEl)) return;

    lastCardAutoScrollId.current = currentItem.id;
    requestAnimationFrame(() => {
      // 'nearest' on a reveal block taller than the viewport aligns its BOTTOM
      // and pushes the answer off the top — see revealScrollBlock.
      answerEl.scrollIntoView({
        behavior: scrollBehavior(),
        block: revealScrollBlock(
          answerEl.getBoundingClientRect().height,
          window.innerHeight,
        ),
      });
    });
  }, [currentItem, cardFullyRevealed, shouldAutoScroll, scrollBehavior, isOffscreen]);

  // Card: grade (1-4) — stats + advance only; API call handled by useGrading
  const handleCardGrade = useCallback((quality: number) => {
    if (!currentItem || currentItem.type !== 'card') return;

    const isCorrect = quality >= 3;
    setStats(prev => ({
      total: prev.total + 1,
      correct: isCorrect ? prev.correct + 1 : prev.correct,
    }));

    advanceToNext();
  }, [advanceToNext, currentItem, setStats]);

  const handleCardContinue = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  return {
    revealedBlanks,
    blankCount,
    cardFullyRevealed,
    cardAnswerRef,
    handleReveal,
    handleCardGrade,
    handleCardContinue,
  };
}
