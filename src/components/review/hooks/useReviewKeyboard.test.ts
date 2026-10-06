/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReviewKeyboard } from './useReviewKeyboard';
import type { ReviewItem } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return { type: 'card', id: 'c1', rotation: 'critical-care', front: 'Q', back: 'A', ...overrides };
}

function makeQuestion(optionCount = 4, overrides: Partial<ReviewItem> = {}): ReviewItem {
  const labels = ['A', 'B', 'C', 'D', 'E'];
  return {
    type: 'question',
    id: 'q1',
    rotation: 'critical-care',
    stem: 'Which drug?',
    options: labels.slice(0, optionCount).map((l, i) => ({
      label: l,
      text: `Option ${l}`,
      isCorrect: i === 0,
    })),
    ...overrides,
  };
}

function defaultHandlers() {
  return {
    handleReveal: vi.fn(),
    handleCardGrade: vi.fn(),
    handleCardContinue: vi.fn(),
    handleSelectOption: vi.fn(),
    handleMcqSkip: vi.fn(),
    handleNext: vi.fn(),
    handleMcqGrade: vi.fn(),
    handleVideoRate: vi.fn(),
    handleVideoContinue: vi.fn(),
    handleGoBack: vi.fn(),
    setFlagMode: vi.fn(),
    handleContentRating: vi.fn(),
    handleRevealAll: vi.fn(),
  };
}

function pressKey(key: string, target?: EventTarget | null) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, 'target', { value: target });
  }
  window.dispatchEvent(event);
}

function renderKeyboard(overrides: Record<string, unknown> = {}) {
  const handlers = defaultHandlers();
  const opts = {
    currentItem: makeCard(),
    cardFullyRevealed: false,
    mcqResult: null,
    flagMode: false,
    ...handlers,
    ...overrides,
  };
  const result = renderHook(() => useReviewKeyboard(opts));
  return { ...handlers, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Confidence 3 = "Good" in CONFIDENCE_TO_QUALITY. */
const GOOD_CONFIDENCE = 3;

describe('useReviewKeyboard', () => {
  describe('held keys', () => {
    // 2026-09-26: a held key auto-repeated through hundreds of items at a fraction of a
    // second each — cards graded Again, MCQs answered A — and every one was recorded as
    // learning evidence. An auto-repeat is not a decision.
    function holdKey(key: string) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, repeat: true }));
    }

    it('ignores an auto-repeated grade key on a revealed card', () => {
      const { handleCardGrade } = renderKeyboard({ cardFullyRevealed: true });
      holdKey('1');
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('ignores an auto-repeated option key on an MCQ', () => {
      const { handleSelectOption } = renderKeyboard({ currentItem: makeQuestion() });
      holdKey('1');
      expect(handleSelectOption).not.toHaveBeenCalled();
    });

    it('still acts on the first, deliberate press', () => {
      const { handleCardGrade } = renderKeyboard({ cardFullyRevealed: true });
      pressKey('1');
      expect(handleCardGrade).toHaveBeenCalledWith(1);
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Input focus detection ----

  describe('input focus detection', () => {
    it('ignores keyboard events when an input element is focused', () => {
      const { handleReveal } = renderKeyboard({ cardFullyRevealed: false });

      const input = document.createElement('input');
      document.body.appendChild(input);
      pressKey(' ', input);

      expect(handleReveal).not.toHaveBeenCalled();
      document.body.removeChild(input);
    });

    it('ignores keyboard events when a textarea element is focused', () => {
      const { handleReveal } = renderKeyboard({ cardFullyRevealed: false });

      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      pressKey(' ', textarea);

      expect(handleReveal).not.toHaveBeenCalled();
      document.body.removeChild(textarea);
    });

    it('ignores keyboard events from a contenteditable element', () => {
      const { handleReveal } = renderKeyboard({ cardFullyRevealed: false });

      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'true');
      document.body.appendChild(editor);
      pressKey(' ', editor);

      expect(handleReveal).not.toHaveBeenCalled();
      document.body.removeChild(editor);
    });

    it('ignores keyboard events from inside a contenteditable element', () => {
      const { handleReveal } = renderKeyboard({ cardFullyRevealed: false });

      const editor = document.createElement('div');
      editor.setAttribute('contenteditable', 'plaintext-only');
      const child = document.createElement('span');
      editor.appendChild(child);
      document.body.appendChild(editor);
      pressKey(' ', child);

      expect(handleReveal).not.toHaveBeenCalled();
      document.body.removeChild(editor);
    });
  });

  it('opens shortcut help with ? but ignores it in editable fields and modals', () => {
    const handleOpenShortcuts = vi.fn();
    renderKeyboard({ handleOpenShortcuts });
    pressKey('?');
    expect(handleOpenShortcuts).toHaveBeenCalledOnce();

    const input = document.createElement('input');
    document.body.appendChild(input);
    pressKey('?', input);
    expect(handleOpenShortcuts).toHaveBeenCalledOnce();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    pressKey('?');
    expect(handleOpenShortcuts).toHaveBeenCalledOnce();
    modal.remove();
    input.remove();
  });

  // ---- No current item ----

  describe('when no current item', () => {
    it('ignores all key presses', () => {
      const { handleReveal, handleCardGrade, handleGoBack } = renderKeyboard({
        currentItem: undefined,
      });

      pressKey(' ');
      pressKey('1');
      pressKey('z');

      expect(handleReveal).not.toHaveBeenCalled();
      expect(handleCardGrade).not.toHaveBeenCalled();
      expect(handleGoBack).not.toHaveBeenCalled();
    });
  });

  // ---- Card type ----

  describe('card type', () => {
    it('space reveals card when not fully revealed', () => {
      const { handleReveal } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: false,
      });

      pressKey(' ');
      expect(handleReveal).toHaveBeenCalledOnce();
    });

    it('Enter reveals card when not fully revealed', () => {
      const { handleReveal } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: false,
      });

      pressKey('Enter');
      expect(handleReveal).toHaveBeenCalledOnce();
    });

    // Space used to advance without grading, and that was where most of the
    // scheduler's missing signal went: across every active learner, ~76% of
    // delivered cards were advanced with no grade at all, so the memory model
    // learned nothing from three cards in four. Space is a GRADE in Anki, which
    // is the muscle memory people arrive with. Skip moves to its own key.
    it('space grades Good when the card is fully revealed', () => {
      const { handleCardContinue, handleCardGrade, handleReveal } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey(' ');
      expect(handleCardGrade).toHaveBeenCalledWith(GOOD_CONFIDENCE);
      expect(handleCardContinue).not.toHaveBeenCalled();
      expect(handleReveal).not.toHaveBeenCalled();
    });

    it('Enter grades Good too, so both advance keys agree', () => {
      const { handleCardContinue, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey('Enter');
      expect(handleCardGrade).toHaveBeenCalledWith(GOOD_CONFIDENCE);
      expect(handleCardContinue).not.toHaveBeenCalled();
    });

    it('falls back to advancing when the card cannot be graded right now', () => {
      // useGrading.grade() early-returns while a grade is saving/saved/queued
      // and never calls onGraded, which is what advances. Routing Space through
      // it without this fallback leaves the primary key dead on the main study
      // loop — worse than the silent-advance it replaced.
      const { handleCardContinue, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
        cardGradeBlocked: true,
      });

      pressKey(' ');
      expect(handleCardContinue).toHaveBeenCalledOnce();
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('still advances on a number key when a grade is already in flight', () => {
      // saved/queued mean this card's grade is already recorded, so moving on
      // is the correct response rather than a dropped keystroke.
      const { handleCardContinue, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
        cardGradeBlocked: true,
      });

      pressKey('3');
      expect(handleCardContinue).toHaveBeenCalledOnce();
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('s skips without grading — the path that must not pollute study data', () => {
      const { handleCardContinue, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey('s');
      expect(handleCardContinue).toHaveBeenCalledOnce();
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('does not skip on s before the card is revealed — s is not a reveal key', () => {
      const { handleCardContinue, handleReveal } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: false,
      });

      pressKey('s');
      expect(handleCardContinue).not.toHaveBeenCalled();
      expect(handleReveal).not.toHaveBeenCalled();
    });

    it.each([1, 2, 3, 4])('number key %d grades card when revealed', (num) => {
      const { handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey(String(num));
      expect(handleCardGrade).toHaveBeenCalledWith(num);
    });

    it('number keys 1-4 do nothing when card is not revealed', () => {
      const { handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: false,
      });

      pressKey('1');
      pressKey('4');
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('number key 5 does nothing for cards (only 1-4 valid)', () => {
      const { handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey('5');
      expect(handleCardGrade).not.toHaveBeenCalled();
    });
  });

  // ---- Question type (MCQ) ----

  describe('question type', () => {
    describe('before answering (no mcqResult)', () => {
      it('number keys 1-4 select options A-D', () => {
        const { handleSelectOption } = renderKeyboard({
          currentItem: makeQuestion(4),
          mcqResult: null,
        });

        pressKey('1');
        expect(handleSelectOption).toHaveBeenCalledWith('A');

        pressKey('3');
        expect(handleSelectOption).toHaveBeenCalledWith('C');
      });

      it('number key 5 selects option E when 5 options exist', () => {
        const { handleSelectOption } = renderKeyboard({
          currentItem: makeQuestion(5),
          mcqResult: null,
        });

        pressKey('5');
        expect(handleSelectOption).toHaveBeenCalledWith('E');
      });

      it('number key 5 does nothing when only 4 options exist', () => {
        const { handleSelectOption } = renderKeyboard({
          currentItem: makeQuestion(4),
          mcqResult: null,
        });
        pressKey('5');
        expect(handleSelectOption).not.toHaveBeenCalledWith('E');
      });
    });

    describe('awaiting opaque confidence', () => {
      it('number keys 1-4 grade instead of re-selecting options', () => {
        const { handleMcqGrade, handleSelectOption } = renderKeyboard({
          currentItem: makeQuestion(4),
          mcqResult: null,
          awaitingConfidence: true,
        });

        pressKey('2');
        expect(handleMcqGrade).toHaveBeenCalledWith(2);
        expect(handleSelectOption).not.toHaveBeenCalled();
      });
    });

      it('space skips the MCQ', () => {
        const { handleMcqSkip } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult: null,
        });

        pressKey(' ');
        expect(handleMcqSkip).toHaveBeenCalledOnce();
      });

      it('Enter skips the MCQ', () => {
        const { handleMcqSkip } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult: null,
        });

        pressKey('Enter');
        expect(handleMcqSkip).toHaveBeenCalledOnce();
      });

      it.each(['Enter', ' '])('lets a focused option button handle %j natively', (key) => {
        const { handleMcqSkip } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult: null,
        });
        const option = document.createElement('button');
        document.body.appendChild(option);

        pressKey(key, option);

        expect(handleMcqSkip).not.toHaveBeenCalled();
        document.body.removeChild(option);
      });

    describe('after answering (mcqResult present)', () => {
      const mcqResult = { isCorrect: true, correctOption: 'A' };

      it('space advances to next without confidence', () => {
        const { handleNext } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult,
        });

        pressKey(' ');
        expect(handleNext).toHaveBeenCalledOnce();
      });

      it('Enter advances to next without confidence', () => {
        const { handleNext } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult,
        });

        pressKey('Enter');
        expect(handleNext).toHaveBeenCalledOnce();
      });

      it.each([1, 2, 3, 4])('number key %d grades MCQ with confidence %d', (num) => {
        const { handleMcqGrade } = renderKeyboard({
          currentItem: makeQuestion(),
          mcqResult,
        });

        pressKey(String(num));
        expect(handleMcqGrade).toHaveBeenCalledWith(num);
      });
    });
  });

  describe('video type', () => {
    it.each([1, 2, 3, 4])('number key %d rates video', (num) => {
      const { handleVideoRate } = renderKeyboard({
        currentItem: { type: 'video', id: 'v1', rotation: 'critical-care', videoTitle: 'Video title' },
      });

      pressKey(String(num));
      expect(handleVideoRate).toHaveBeenCalledWith(num);
    });

    it('space continues video without rating', () => {
      const { handleVideoContinue, handleVideoRate } = renderKeyboard({
        currentItem: { type: 'video', id: 'v1', rotation: 'critical-care', videoTitle: 'Video title' },
      });

      pressKey(' ');
      expect(handleVideoContinue).toHaveBeenCalledOnce();
      expect(handleVideoRate).not.toHaveBeenCalled();
    });

    it('Enter continues video without rating', () => {
      const { handleVideoContinue, handleVideoRate } = renderKeyboard({
        currentItem: { type: 'video', id: 'v1', rotation: 'critical-care', videoTitle: 'Video title' },
      });

      pressKey('Enter');
      expect(handleVideoContinue).toHaveBeenCalledOnce();
      expect(handleVideoRate).not.toHaveBeenCalled();
    });
  });

  // ---- Flag mode ----

  // ---- Reveal all (a) ----

  describe('reveal-all shortcut', () => {
    it('opens every blank on a, while the card is still hidden', () => {
      const { handleRevealAll } = renderKeyboard({ cardFullyRevealed: false });
      pressKey('a');
      expect(handleRevealAll).toHaveBeenCalledTimes(1);
    });

    it('accepts the uppercase form', () => {
      const { handleRevealAll } = renderKeyboard({ cardFullyRevealed: false });
      pressKey('A');
      expect(handleRevealAll).toHaveBeenCalledTimes(1);
    });

    it('does not re-reveal an already fully revealed card', () => {
      const { handleRevealAll } = renderKeyboard({ cardFullyRevealed: true });
      pressKey('a');
      expect(handleRevealAll).not.toHaveBeenCalled();
    });

    it('leaves questions alone — they have no blanks to step through', () => {
      const { handleRevealAll } = renderKeyboard({ currentItem: makeQuestion() });
      pressKey('a');
      expect(handleRevealAll).not.toHaveBeenCalled();
    });

    it('does not fire in flag mode', () => {
      const { handleRevealAll } = renderKeyboard({ flagMode: true });
      pressKey('a');
      expect(handleRevealAll).not.toHaveBeenCalled();
    });
  });

  // ---- Content rating (g / b) ----

  describe('content rating shortcuts', () => {
    // The thumbs have existed since content-rating-v1 and recorded zero
    // ratings across every user. Everything else in review is keyboard-driven,
    // so the mouse-only affordance was the gap.
    it('rates the current item good on g', () => {
      const { handleContentRating } = renderKeyboard();
      pressKey('g');
      expect(handleContentRating).toHaveBeenCalledWith('good');
    });

    it('rates the current item bad on b', () => {
      const { handleContentRating } = renderKeyboard();
      pressKey('b');
      expect(handleContentRating).toHaveBeenCalledWith('bad');
    });

    it('accepts the uppercase forms', () => {
      const { handleContentRating } = renderKeyboard();
      pressKey('G');
      pressKey('B');
      expect(handleContentRating).toHaveBeenNthCalledWith(1, 'good');
      expect(handleContentRating).toHaveBeenNthCalledWith(2, 'bad');
    });

    it('rates a question as well as a card', () => {
      const { handleContentRating } = renderKeyboard({ currentItem: makeQuestion() });
      pressKey('g');
      expect(handleContentRating).toHaveBeenCalledWith('good');
    });

    it('stays out of the way in flag mode, where the textarea owns the keys', () => {
      const { handleContentRating } = renderKeyboard({ flagMode: true });
      pressKey('g');
      pressKey('b');
      expect(handleContentRating).not.toHaveBeenCalled();
    });

    it('does not fire while typing in an input', () => {
      const input = document.createElement('input');
      document.body.appendChild(input);
      const { handleContentRating } = renderKeyboard();
      pressKey('g', input);
      expect(handleContentRating).not.toHaveBeenCalled();
      input.remove();
    });

    it('does nothing when there is no current item', () => {
      const { handleContentRating } = renderKeyboard({ currentItem: undefined });
      pressKey('g');
      expect(handleContentRating).not.toHaveBeenCalled();
    });
  });

  describe('flag mode', () => {
    it('F key enters flag mode', () => {
      const { setFlagMode } = renderKeyboard({ flagMode: false });

      pressKey('f');
      expect(setFlagMode).toHaveBeenCalledWith(true);
    });

    it('uppercase F also enters flag mode', () => {
      const { setFlagMode } = renderKeyboard({ flagMode: false });

      pressKey('F');
      expect(setFlagMode).toHaveBeenCalledWith(true);
    });

    it('all keys are ignored in flag mode (textarea handles input)', () => {
      const { handleReveal, handleCardGrade, setFlagMode } = renderKeyboard({
        flagMode: true,
        cardFullyRevealed: true,
      });

      pressKey(' ');
      pressKey('f');
      pressKey('1');
      pressKey('Escape');

      expect(handleReveal).not.toHaveBeenCalled();
      expect(handleCardGrade).not.toHaveBeenCalled();
      expect(setFlagMode).not.toHaveBeenCalled();
    });
  });

  // ---- Go back (Z key) ----

  describe('go back', () => {
    it('Z key triggers handleGoBack', () => {
      const { handleGoBack } = renderKeyboard();

      pressKey('z');
      expect(handleGoBack).toHaveBeenCalledOnce();
    });

    it('uppercase Z also triggers handleGoBack', () => {
      const { handleGoBack } = renderKeyboard();

      pressKey('Z');
      expect(handleGoBack).toHaveBeenCalledOnce();
    });
  });

  // ---- F key takes priority over card/question handling ----

  describe('key priority', () => {
    it('F key enters flag mode even when card is revealed (does not grade)', () => {
      const { setFlagMode, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey('f');
      expect(setFlagMode).toHaveBeenCalledWith(true);
      expect(handleCardGrade).not.toHaveBeenCalled();
    });

    it('Z key triggers go back even when card is revealed (does not grade)', () => {
      const { handleGoBack, handleCardGrade } = renderKeyboard({
        currentItem: makeCard(),
        cardFullyRevealed: true,
      });

      pressKey('z');
      expect(handleGoBack).toHaveBeenCalledOnce();
      expect(handleCardGrade).not.toHaveBeenCalled();
    });
  });
});
