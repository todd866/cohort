import { useEffect } from 'react';
import type { ReviewItem } from './types';
import { isEditableShortcutTarget, isInteractiveActivationTarget } from './keyboardTarget';

interface UseReviewKeyboardOptions {
  currentItem: ReviewItem | undefined;
  cardFullyRevealed: boolean;
  mcqResult: { isCorrect: boolean; correctOption: string } | null;
  flagMode: boolean;
  setFlagMode: (v: boolean) => void;
  handleReveal: () => void;
  handleCardGrade: (quality: number) => void;
  handleCardContinue: () => void;
  handleSelectOption: (label: string) => void;
  handleMcqSkip: () => void;
  handleNext: () => void;
  handleMcqGrade: (confidence: number) => void;
  handleVideoRate: (quality: number) => void;
  handleVideoContinue: () => void;
  handleGoBack: () => void;
  /** Public opaque items: option is chosen, confidence has not submitted yet. */
  awaitingConfidence?: boolean;
  /** Delivery-scoped good/bad quality rating for the item on screen. */
  handleContentRating?: (rating: 'good' | 'bad') => void;
  /** Open every remaining blank on a multi-blank cloze in one press. */
  handleRevealAll?: () => void;
  /**
   * True while a grade for this card cannot be taken — one is saving, saved or
   * queued. `useGrading.grade()` early-returns in those states and never calls
   * onGraded, so a grade keystroke would neither record nor advance. Space used
   * to advance unconditionally; routing it through grading without this would
   * leave the primary key dead on the main study loop.
   */
  cardGradeBlocked?: boolean;
}

/**
 * Confidence 3 = "Good" (CONFIDENCE_TO_QUALITY in src/hooks/useGrading.ts).
 * Named rather than inlined because it is a product decision, not a magic
 * number: Space means "I knew that, normal interval".
 */
const GOOD_CONFIDENCE = 3;

export function useReviewKeyboard({
  currentItem,
  cardFullyRevealed,
  mcqResult,
  flagMode,
  setFlagMode,
  handleReveal,
  handleCardGrade,
  handleCardContinue,
  handleSelectOption,
  handleMcqSkip,
  handleNext,
  handleMcqGrade,
  handleVideoRate,
  handleVideoContinue,
  handleGoBack,
  awaitingConfidence = false,
  handleContentRating,
  handleRevealAll,
  cardGradeBlocked = false,
}: UseReviewKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableShortcutTarget(e.target)) return;

      // Let focused controls keep their native Enter/Space activation. Without
      // this, the window-level shortcut can skip/reveal/advance before the
      // focused option button receives its click.
      if ((e.key === ' ' || e.key === 'Enter') && isInteractiveActivationTarget(e.target)) {
        return;
      }

      if (!currentItem) return;

      // Flag mode — keyboard is captured by the textarea, nothing to handle here
      if (flagMode) return;

      // 'g' / 'b' rate the item on screen. The thumbs shipped mouse-only and
      // recorded zero ratings ever; every other review action has a key.
      if (handleContentRating && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        handleContentRating('good');
        return;
      }
      if (handleContentRating && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        handleContentRating('bad');
        return;
      }

      // 'f' to enter flag mode (anytime)
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setFlagMode(true);
        return;
      }

      // 'z' or Cmd+Z to go back
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        handleGoBack();
        return;
      }

      if (currentItem.type === 'card') {
        if (!cardFullyRevealed) {
          // 'a' opens the whole card. Space stays one blank at a time.
          if (handleRevealAll && (e.key === 'a' || e.key === 'A')) {
            e.preventDefault();
            handleRevealAll();
            return;
          }
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleReveal();
          }
        } else {
          // Space grades GOOD rather than advancing silently. It used to
          // advance without recording anything, which is where most of the
          // scheduler's signal was going missing — measured across every
          // active learner, roughly three delivered cards in four were
          // advanced with no grade, so the memory model never heard about
          // them and their stability sat at its default forever. Space is a
          // grade in Anki, which is the muscle memory people arrive with.
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            // saved/queued mean this card's grade is already recorded and
            // saving means one is in flight, so advancing is the right
            // response in all three rather than a dropped keystroke.
            if (cardGradeBlocked) handleCardContinue();
            else handleCardGrade(GOOD_CONFIDENCE);
          } else if (e.key === 's' || e.key === 'S') {
            // The deliberate no-signal path: advance without touching study
            // data. Content verification walks the review UI and must not
            // pollute the schedule (docs/runbooks/PROD_VERIFICATION.md).
            e.preventDefault();
            handleCardContinue();
          } else {
            const keyNum = parseInt(e.key);
            if (keyNum >= 1 && keyNum <= 4) {
              e.preventDefault();
              if (cardGradeBlocked) handleCardContinue();
              else handleCardGrade(keyNum);
            }
          }
        }
      } else if (currentItem.type === 'question') {
        if (awaitingConfidence && !mcqResult) {
          const keyNum = parseInt(e.key);
          if (!Number.isNaN(keyNum) && keyNum >= 1 && keyNum <= 4) {
            e.preventDefault();
            handleMcqGrade(keyNum);
          }
          return;
        }
        if (!mcqResult) {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleMcqSkip();
          } else {
            const keyNum = parseInt(e.key);
            if (keyNum >= 1 && keyNum <= 5 && currentItem.options) {
              const labels = ['A', 'B', 'C', 'D', 'E'];
              const label = labels[keyNum - 1];
              if (currentItem.options.some(o => o.label === label)) {
                e.preventDefault();
                handleSelectOption(label);
              }
            }
          }
        } else {
          const keyNum = parseInt(e.key);
          if (!Number.isNaN(keyNum) && keyNum >= 1 && keyNum <= 4) {
            e.preventDefault();
            handleMcqGrade(keyNum);
            return;
          }
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleNext();
          }
        }
      } else if (currentItem.type === 'video') {
        const keyNum = parseInt(e.key);
        if (!Number.isNaN(keyNum) && keyNum >= 1 && keyNum <= 4) {
          e.preventDefault();
          handleVideoRate(keyNum);
          return;
        }
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          handleVideoContinue();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentItem, cardFullyRevealed, mcqResult, flagMode,
    handleCardContinue, handleReveal, handleCardGrade,
    handleSelectOption, handleMcqSkip, handleNext, handleMcqGrade, handleVideoRate, handleVideoContinue, handleGoBack,
    setFlagMode, awaitingConfidence, cardGradeBlocked, handleContentRating, handleRevealAll,
  ]);
}
