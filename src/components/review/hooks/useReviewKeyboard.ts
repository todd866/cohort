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
}

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
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleReveal();
          }
        } else {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleCardContinue();
          } else {
            const keyNum = parseInt(e.key);
            if (keyNum >= 1 && keyNum <= 4) {
              e.preventDefault();
              handleCardGrade(keyNum);
            }
          }
        }
      } else if (currentItem.type === 'question') {
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
    setFlagMode,
  ]);
}
