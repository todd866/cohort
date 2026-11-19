import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ReviewShortcutContext } from '@/components/review/ReviewKeyboardHelp';
import {
  GAMEPAD_RIGHT_STICK_Y_AXIS,
  GAMEPAD_STICK_DEAD_ZONE,
  gamepadActionFor,
  gamepadButtonFromIndex,
  wrapMcqHighlightIndex,
} from './review-gamepad';

const GOOD_CONFIDENCE = 3;

type KeyboardReviewItem = { type: string; id?: string; options?: { label: string }[] };

export interface UseReviewGamepadOptions {
  shortcutContext: ReviewShortcutContext;
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
  handleGoForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  awaitingConfidence?: boolean;
  handleRevealAll?: () => void;
  handleOpenShortcuts?: () => void;
  cardGradeBlocked?: boolean;
  scrollRootRef?: RefObject<HTMLElement | null>;
}

function anyGamepadConnected(getGamepads: () => (Gamepad | null)[]): boolean {
  return getGamepads().some(Boolean);
}

export function useReviewGamepad(options: UseReviewGamepadOptions) {
  const [mcqHighlightIndex, setMcqHighlightIndex] = useState<number | null>(null);
  const mcqHighlightRef = useRef<number | null>(null);
  const prevButtonsRef = useRef<Set<number>>(new Set());
  const optsRef = useRef(options);
  useEffect(() => {
    optsRef.current = options;
  });

  useEffect(() => {
    mcqHighlightRef.current = mcqHighlightIndex;
  }, [mcqHighlightIndex]);

  const currentItemId = options.currentItem?.id ?? null;
  const highlightResetKey = `${options.shortcutContext}:${currentItemId ?? ''}:${options.mcqResult ? 1 : 0}`;
  useEffect(() => {
    // Clearing gamepad MCQ focus when the item/context changes is driven by input, not props.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- highlight must reset with the review step
    setMcqHighlightIndex(null);
  }, [highlightResetKey]);

  useEffect(() => {
    const root = document.documentElement;
    const clearPadInput = () => {
      delete root.dataset.input;
    };
    const onKey = () => clearPadInput();
    const onPointer = () => clearPadInput();
    const onMouseMove = () => clearPadInput();
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('mousemove', onMouseMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('mousemove', onMouseMove);
    };
  }, []);

  useEffect(() => {
    const getGamepads = typeof navigator !== 'undefined' && navigator.getGamepads
      ? () => [...navigator.getGamepads()]
      : null;
    if (!getGamepads) return;

    let frame = 0;
    let running = false;
    const prevPressed = prevButtonsRef;

    const act = (action: ReturnType<typeof gamepadActionFor>) => {
      const opts = optsRef.current;
      if (!action) return;
      const {
        disabled, flagMode, currentItem, cardFullyRevealed, mcqResult,
        handleReveal, handleCardGrade, handleCardContinue, handleSelectOption,
        handleMcqSkip, handleNext, handleMcqGrade, handleVideoRate, handleVideoContinue,
        handleGoBack, handleGoForward, canGoForward,
        handleRevealAll, handleOpenShortcuts, cardGradeBlocked, shortcutContext,
      } = opts;

      if (disabled || flagMode || document.querySelector('[aria-modal="true"]')) return;
      if (!currentItem && action.type !== 'open-shortcuts' && action.type !== 'prev-item' && action.type !== 'next-item') return;

      const optionCount = currentItem?.options?.length ?? 0;

      switch (action.type) {
        case 'open-shortcuts':
          handleOpenShortcuts?.();
          return;
        case 'open-flag':
          if (currentItem) opts.setFlagMode(true);
          return;
        case 'prev-item':
          handleGoBack();
          return;
        case 'next-item':
          if (canGoForward) handleGoForward?.();
          return;
        case 'reveal':
          handleReveal();
          return;
        case 'reveal-all':
          handleRevealAll?.();
          return;
        case 'grade': {
          const q = action.quality;
          if (currentItem?.type === 'card' && cardFullyRevealed) {
            if (cardGradeBlocked) handleCardContinue();
            else handleCardGrade(q);
          } else if (currentItem?.type === 'question') {
            handleMcqGrade(q);
          } else if (currentItem?.type === 'video') {
            handleVideoRate(q);
          }
          return;
        }
        case 'continue':
          if (currentItem?.type === 'card' && cardFullyRevealed) {
            if (cardGradeBlocked) handleCardContinue();
            else handleCardGrade(GOOD_CONFIDENCE);
          } else if (currentItem?.type === 'question' && mcqResult) {
            handleNext();
          } else if (currentItem?.type === 'video') {
            handleVideoContinue();
          }
          return;
        case 'mcq-skip':
          handleMcqSkip();
          return;
        case 'mcq-nav': {
          if (shortcutContext !== 'mcq-select' || !optionCount) return;
          const next = wrapMcqHighlightIndex(mcqHighlightRef.current, action.direction, optionCount);
          setMcqHighlightIndex(next);
          return;
        }
        case 'mcq-prime':
          if (optionCount > 0) setMcqHighlightIndex(0);
          return;
        case 'mcq-pick': {
          const idx = mcqHighlightRef.current;
          if (idx == null || !currentItem?.options?.[idx]) return;
          handleSelectOption(currentItem.options[idx].label);
          setMcqHighlightIndex(null);
          return;
        }
        default:
          return;
      }
    };

    const tick = () => {
      const root = document.documentElement;
      const opts = optsRef.current;
      // Held buttons are tracked even while the review is blocked, so a button held through a dialog or a
      // step change is never read as a new press when it ends.
      const blocked = Boolean(opts.disabled || opts.flagMode || document.querySelector('[aria-modal="true"]'));

      const pads = getGamepads();
      const pressedNow = new Set<number>();
      for (const pad of pads) {
        if (!pad) continue;
        pad.buttons.forEach((btn, index) => {
          if (btn.pressed) pressedNow.add(index);
        });
      }

      for (const index of pressedNow) {
        if (!blocked && !prevPressed.current.has(index)) {
          root.dataset.input = 'pad';
          const button = gamepadButtonFromIndex(index);
          if (button) {
            const action = gamepadActionFor(opts.shortcutContext, button, {
              mcqHighlighted: mcqHighlightRef.current != null,
            });
            act(action);
          }
        }
      }

      for (const pad of pads) {
        if (!pad) continue;
        const deflection = pad.axes[GAMEPAD_RIGHT_STICK_Y_AXIS] ?? 0;
        if (!blocked && Math.abs(deflection) > GAMEPAD_STICK_DEAD_ZONE) {
          const scrollEl = opts.scrollRootRef?.current;
          const delta = deflection * 24;
          if (scrollEl) scrollEl.scrollTop += delta;
          else window.scrollBy(0, delta);
        }
      }

      prevPressed.current = pressedNow;
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const sync = () => {
      if (anyGamepadConnected(getGamepads)) start();
      else stop();
    };

    const onConnect = () => sync();
    const onDisconnect = () => {
      sync();
      if (!running) prevPressed.current = new Set();
    };

    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
    sync();

    return () => {
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnect);
      stop();
    };
  // Everything the loop reads comes through optsRef, so it is set up once and survives every step change.
  }, []);

  return { mcqHighlightIndex };
}