'use client';

import { useState, useCallback, type ReactNode } from 'react';

interface InlineClozeProps {
  answer: ReactNode;
}

/**
 * Interactive inline cloze blank for weekly content pages.
 * Tappable [___] that reveals the answer on click/tap/space.
 * Tab-navigable with visible focus ring.
 */
export function InlineCloze({ answer }: InlineClozeProps) {
  const [revealed, setRevealed] = useState(false);

  const reveal = useCallback(() => {
    if (revealed) return;
    setRevealed(true);
  }, [revealed]);

  return (
    <span
      role="button"
      tabIndex={0}
      data-inline-cloze="true"
      data-revealed={revealed ? 'true' : 'false'}
      aria-label={revealed ? undefined : 'Tap to reveal answer'}
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reveal();
        }
      }}
      className={
        revealed
          ? 'inline font-semibold text-[var(--md-primary)]'
          : 'inline-block min-w-[3rem] text-center px-2 py-0.5 rounded-md bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] cursor-pointer hover:brightness-95 active:brightness-90 transition-all select-none focus:outline-2 focus:outline-offset-2 focus:outline-[var(--md-primary)]'
      }
    >
      {revealed ? answer : '___'}
    </span>
  );
}
