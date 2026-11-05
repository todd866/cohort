import { useEffect } from 'react';
type KeyboardReviewItem = { type: string; options?: { label: string }[] };
import { isEditableShortcutTarget, isInteractiveActivationTarget, shortcutNumber } from './keyboardTarget';

interface UseReviewKeyboardOptions {
  currentItem: KeyboardReviewItem | undefined;
  disabled?: boolean;
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
  /** Open the compact shortcut reference (usually from `?` or Options). */
  handleOpenShortcuts?: () => void;
  handleOpenBrowser?: () => void;
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
  disabled = false,
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
  handleOpenShortcuts,
  handleOpenBrowser,
  cardGradeBlocked = false,
}: UseReviewKeyboardOptions) {
  useEffect(() => {
    type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'target' | 'repeat' | 'preventDefault'>;
    const act = (e: ShortcutEvent) => {
      // A held key auto-repeats: that is not a decision. Left unguarded, one held
      // key grades hundreds of items in minutes and records each as real evidence.
      if (disabled || e.repeat || document.querySelector('[aria-modal="true"]')) return;
      if (isEditableShortcutTarget(e.target)) return;

      // Let focused controls keep their native Enter/Space activation. Without
      // this, the window-level shortcut can skip/reveal/advance before the
      // focused option button receives its click.
      if ((e.key === ' ' || e.key === 'Enter') && isInteractiveActivationTarget(e.target)) {
        return;
      }

      if (handleOpenShortcuts && e.key === '?') {
        e.preventDefault();
        handleOpenShortcuts();
        return;
      }

      // Flag mode — keyboard is captured by the textarea, nothing to handle here
      if (flagMode) return;

      // B follows Anki's browser shortcut; bad ratings remain on the thumb button.
      if (currentItem && handleContentRating && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        handleContentRating('good');
        return;
      }
      if (handleOpenBrowser && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        handleOpenBrowser();
        return;
      }

      // 'f' to enter flag mode (anytime)
      if (currentItem && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        setFlagMode(true);
        return;
      }

      // Z revisits history without changing the live turn.
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        handleGoBack();
        return;
      }

      if (!currentItem) return;

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
            const keyNum = shortcutNumber(e.key);
            if (keyNum >= 1 && keyNum <= 4) {
              e.preventDefault();
              if (cardGradeBlocked) handleCardContinue();
              else handleCardGrade(keyNum);
            }
          }
        }
      } else if (currentItem.type === 'question') {
        if (awaitingConfidence && !mcqResult) {
          const keyNum = shortcutNumber(e.key);
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
            const keyNum = shortcutNumber(e.key);
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
          const keyNum = shortcutNumber(e.key);
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
        const keyNum = shortcutNumber(e.key);
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

    // Number shortcuts (1-9 and the home-row twins J K L ; ') show on press and
    // act on release (owner, 1 Nov 2026): the button under the key looks pressed
    // while it is held, so pressing J lights the same button as 1 and the twins
    // teach themselves without a label. Releasing a different key, or leaving
    // the window, cancels. Every other key still acts on press.
    const root = document.documentElement;
    let armed: { key: string; target: EventTarget | null } | null = null;
    const disarm = () => {
      armed = null;
      delete root.dataset.shortcutPressed;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = shortcutNumber(e.key);
      if (Number.isNaN(n)) {
        act(e);
        return;
      }
      if (e.repeat) {
        if (armed) e.preventDefault();
        return;
      }
      if (disabled || document.querySelector('[aria-modal="true"]') || isEditableShortcutTarget(e.target)) return;
      armed = { key: e.key.toLowerCase(), target: e.target };
      root.dataset.shortcutPressed = String(n);
      e.preventDefault();
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (!armed || e.key.toLowerCase() !== armed.key) return;
      const { target } = armed;
      disarm();
      act({ key: e.key, target, repeat: false, preventDefault: () => e.preventDefault() });
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', disarm);
      disarm();
    };
  }, [
    currentItem, disabled, cardFullyRevealed, mcqResult, flagMode,
    handleCardContinue, handleReveal, handleCardGrade,
    handleSelectOption, handleMcqSkip, handleNext, handleMcqGrade, handleVideoRate, handleVideoContinue, handleGoBack,
    setFlagMode, awaitingConfidence, cardGradeBlocked, handleContentRating, handleRevealAll,
    handleOpenShortcuts, handleOpenBrowser,
  ]);
}
