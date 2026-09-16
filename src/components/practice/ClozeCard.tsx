'use client';

import { useState, useEffect, useCallback } from 'react';
import { InlineMarkdown } from '@/lib/inline-markdown';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { CONFIDENCE_TO_QUALITY } from '@/hooks/useGrading';

interface ClozeCardProps {
  front: string;  // Text with [___] blanks
  back: string;   // The answer (single answer for simple cloze)
  backs?: string[]; // Array of answers for multi-cloze one-by-one cards
  context?: string;
  learnMore?: string;
  sourceComponent: string;
  week: number;
  onGrade: (quality: number) => void;
  onNext: () => void;
}

export function ClozeCard({
  front,
  back,
  backs,
  context,
  learnMore,
  sourceComponent,
  week,
  onGrade,
  onNext,
}: ClozeCardProps) {
  // For multi-cloze, track how many answers have been revealed
  const answers = backs && backs.length > 0 ? backs : [back];
  const isMultiCloze = answers.length > 1;

  const [revealedCount, setRevealedCount] = useState(0);
  const allRevealed = revealedCount >= answers.length;
  const [showFeedback, setShowFeedback] = useState(false);

  // Replace [___] blanks with answers or underscores
  const renderFront = () => {
    let blankIndex = 0;
    return front.replace(/\[___\]/g, () => {
      const currentIndex = blankIndex++;
      if (currentIndex < revealedCount) {
        // This blank has been revealed - show answer
        return `**${answers[currentIndex]}**`;
      }
      // Not yet revealed - show blank
      return '______';
    });
  };

  // Reveal next answer (for multi-cloze) or all (for single)
  const handleRevealNext = useCallback(() => {
    if (revealedCount < answers.length) {
      setRevealedCount(prev => prev + 1);
    }
  }, [revealedCount, answers.length]);

  // Reveal all at once
  const handleRevealAll = useCallback(() => {
    setRevealedCount(answers.length);
  }, [answers.length]);

  // Grade and advance (or show feedback if incorrect)
  const handleGradeAndNext = useCallback((quality: number) => {
    onGrade(quality);
    if (quality >= 3) {
      onNext();
      setRevealedCount(0);
      setShowFeedback(false);
    } else {
      setShowFeedback(true);
    }
  }, [onGrade, onNext]);

  const handleConfidenceSelect = useCallback((confidence: number) => {
    handleGradeAndNext(CONFIDENCE_TO_QUALITY[confidence] ?? 3);
  }, [handleGradeAndNext]);

  const handleContinue = useCallback(() => {
    onNext();
    setRevealedCount(0);
    setShowFeedback(false);
  }, [onNext]);

  // Keyboard shortcuts (Anki-style)
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const key = e.key.toLowerCase();

    // Before all revealed
    if (!allRevealed) {
      // Space/Enter/N reveals next (or all for single cloze)
      if (key === ' ' || key === 'enter' || key === 'n') {
        e.preventDefault();
        if (isMultiCloze) {
          handleRevealNext();
        } else {
          handleRevealAll();
        }
      }
      return;
    }

    if (showFeedback) {
      if (key === ' ' || key === 'enter' || key === 'n') {
        e.preventDefault();
        handleContinue();
      }
      return;
    }

    // After all revealed: 1-4 to grade + advance
    // Space defaults to Good (3)
    if (key === ' ' || key === 'enter' || key === '3' || key === 'g') {
      e.preventDefault();
      handleGradeAndNext(CONFIDENCE_TO_QUALITY[3]); // Good
    } else if (key === '1' || key === 'a') {
      e.preventDefault();
      handleGradeAndNext(CONFIDENCE_TO_QUALITY[1]); // Again
    } else if (key === '2' || key === 'h') {
      e.preventDefault();
      handleGradeAndNext(CONFIDENCE_TO_QUALITY[2]); // Hard
    } else if (key === '4' || key === 'e') {
      e.preventDefault();
      handleGradeAndNext(CONFIDENCE_TO_QUALITY[4]); // Easy
    }
  }, [allRevealed, isMultiCloze, showFeedback, handleRevealNext, handleRevealAll, handleGradeAndNext, handleContinue]);

  useEffect(() => {
    setRevealedCount(0);
    setShowFeedback(false);
  }, [front, back, backs]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Parse markdown bold for display
  const formatText = (text: string) => {
    return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <span key={i} className="font-bold text-[var(--md-primary)]">
            {part.slice(2, -2)}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const sourceLabel = {
    'Mnemonic': 'MNEMONIC',
    'KeyPoint': 'KEY POINT',
    'MCQ': 'MCQ',
  }[sourceComponent] || sourceComponent.toUpperCase();

  return (
    <div className="w-full max-w-2xl mx-auto">
      {/* Card */}
      <div className="rounded-2xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)] overflow-hidden">
        {/* Header */}
        <div className="px-6 py-3 bg-[var(--md-surface-container)] border-b border-[var(--md-outline-variant)]">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 text-xs font-bold rounded-full bg-[var(--md-secondary)] text-[var(--md-on-secondary)]">
              {sourceLabel}
            </span>
            <span className="text-sm text-[var(--md-on-surface-variant)]">
              Week {week}
            </span>
            {isMultiCloze && (
              <span className="text-sm text-[var(--md-on-surface-variant)]">
                • {revealedCount}/{answers.length}
              </span>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="px-6 py-8">
          <p className="text-lg text-[var(--md-on-surface)] leading-relaxed text-center">
            {formatText(renderFront())}
          </p>
        </div>

        {/* Actions */}
        <div className="px-6 py-4 border-t border-[var(--md-outline-variant)]">
          {!allRevealed ? (
            <div className="text-center">
              <button
                onClick={isMultiCloze ? handleRevealNext : handleRevealAll}
                className="px-8 py-3 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium hover:brightness-110 transition-all"
              >
                {isMultiCloze
                  ? revealedCount === 0
                    ? 'Show First'
                    : `Show Next (${revealedCount}/${answers.length})`
                  : 'Show Answer'}
              </button>
              <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
                {isMultiCloze ? 'press N or Space' : 'or press Space'}
              </p>
            </div>
          ) : (
            <div>
              <ConfidenceButtons mode="inline" onSelect={handleConfidenceSelect} />
            </div>
          )}
        </div>

        {/* Feedback (shown after incorrect) */}
        {showFeedback && (context || learnMore) && (
          <div className="px-6 py-4 bg-[var(--md-surface-container-lowest)] border-t border-[var(--md-outline-variant)] space-y-2">
            {context && (
              <p className="text-sm text-[var(--md-on-surface-variant)] leading-relaxed">
                <InlineMarkdown text={context} />
              </p>
            )}
            {learnMore && (
              <a
                href={learnMore}
                className="inline-flex items-center text-sm text-[var(--md-primary)] hover:underline"
              >
                Learn more →
              </a>
            )}
            <button
              onClick={handleContinue}
              className="w-full mt-1 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium"
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
