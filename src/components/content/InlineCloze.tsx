'use client';

import { useState, useCallback, type ReactNode } from 'react';
import { useContentReadingMode } from './content-reading-mode';

interface InlineClozeProps {
  answer: ReactNode;
}

/**
 * Interactive inline cloze blank for weekly content pages.
 * Tappable [___] that reveals the answer on click/tap/space.
 * Tab-navigable with visible focus ring.
 * A notes-page "Show answers" control can reveal every blank at once.
 */
export function InlineCloze({ answer }: InlineClozeProps) {
  const { showAnswers } = useContentReadingMode();
  const [revealed, setRevealed] = useState(false);
  const isRevealed = showAnswers || revealed;

  const reveal = useCallback(() => {
    if (isRevealed) return;
    setRevealed(true);
  }, [isRevealed]);

  return (
    <span
      role="button"
      tabIndex={0}
      data-inline-cloze="true"
      data-revealed={isRevealed ? 'true' : 'false'}
      aria-label={isRevealed ? undefined : 'Tap to reveal answer'}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reveal();
        }
      }}
      className={
        isRevealed
          ? 'inline font-semibold text-[var(--md-primary)]'
          : 'inline-block min-w-[3rem] cursor-pointer select-none rounded-md bg-[var(--md-primary-container)] px-2 py-0.5 text-center text-[var(--md-on-primary-container)] transition-colors hover:brightness-95 active:brightness-90 focus:outline-2 focus:outline-offset-2 focus:outline-[var(--md-primary)]'
      }
    >
      {isRevealed ? answer : '___'}
    </span>
  );
}
