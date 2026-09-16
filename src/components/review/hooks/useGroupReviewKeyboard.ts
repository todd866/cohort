import { useEffect } from 'react';
import type { QuestionGroupStep, StepOption } from '@/lib/question-groups/types';
import { isEditableShortcutTarget, isInteractiveActivationTarget } from './keyboardTarget';

interface UseGroupReviewKeyboardOptions {
  currentStep: QuestionGroupStep | undefined;
  groupType: string;
  revealed: boolean;
  mcqAnswered: boolean;
  mcqShowRating: boolean;
  displayOptions: StepOption[];
  handleReveal: () => void;
  handleCardGrade: (quality: number) => void;
  advanceWithoutRating: () => void;
  handleSelectOption: (label: string) => void;
  handleMcqSkip: () => void;
  handleMcqGrade: (quality: number) => void;
  handleMcqContinue: () => void;
  toggleImageExpand: () => void;
  handleSkipGroup: () => void;
}

/**
 * Keyboard shortcuts for the group review flow. Mirrors the single-item
 * `useReviewKeyboard`: reveal/grade cards (space/enter, 1-4), answer/skip/rate
 * MCQs (1-N, space/enter), plus 'i' to expand the image and 's' to skip the
 * group.
 */
export function useGroupReviewKeyboard({
  currentStep,
  groupType,
  revealed,
  mcqAnswered,
  mcqShowRating,
  displayOptions,
  handleReveal,
  handleCardGrade,
  advanceWithoutRating,
  handleSelectOption,
  handleMcqSkip,
  handleMcqGrade,
  handleMcqContinue,
  toggleImageExpand,
  handleSkipGroup,
}: UseGroupReviewKeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if typing in an input
      if (isEditableShortcutTarget(e.target)) return;
      if ((e.key === ' ' || e.key === 'Enter') && isInteractiveActivationTarget(e.target)) return;

      const step = currentStep;
      if (!step) return;

      // Card type shortcuts
      if (step.type === 'card') {
        if (!revealed) {
          // Space/Enter to reveal
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleReveal();
          }
        } else {
          // 1-4 to grade, space/enter continues without recording confidence
          if (e.key === '1') { e.preventDefault(); handleCardGrade(1); }
          if (e.key === '2') { e.preventDefault(); handleCardGrade(2); }
          if (e.key === '3') { e.preventDefault(); handleCardGrade(3); }
          if (e.key === '4') { e.preventDefault(); handleCardGrade(4); }
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            advanceWithoutRating();
          }
        }
      }

      // MCQ type shortcuts
      if (step.type === 'mcq' && displayOptions.length > 0) {
        if (!mcqAnswered) {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleMcqSkip();
            return;
          }
          // 1-5 to select option (matches display)
          const keyNum = parseInt(e.key, 10);
          if (keyNum >= 1 && keyNum <= displayOptions.length) {
            const option = displayOptions[keyNum - 1];
            if (option) {
              e.preventDefault();
              handleSelectOption(option.label);
            }
          }
        } else if (mcqShowRating) {
          // 1-4 to rate after answering, space/enter continues without confidence
          if (e.key === '1') { e.preventDefault(); handleMcqGrade(1); }
          if (e.key === '2') { e.preventDefault(); handleMcqGrade(2); }
          if (e.key === '3') { e.preventDefault(); handleMcqGrade(3); }
          if (e.key === '4') { e.preventDefault(); handleMcqGrade(4); }
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleMcqContinue();
          }
        }
      }

      // 'i' to toggle image expansion (non-ECG only, ECG is always large)
      if ((e.key === 'i' || e.key === 'I') && groupType !== 'ecg') {
        e.preventDefault();
        toggleImageExpand();
      }

      // 's' to skip entire group
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handleSkipGroup();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentStep, revealed, mcqAnswered, mcqShowRating, displayOptions, groupType,
    handleReveal, handleCardGrade, advanceWithoutRating,
    handleSelectOption, handleMcqSkip, handleMcqGrade, handleMcqContinue,
    toggleImageExpand, handleSkipGroup,
  ]);
}
