'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Lightweight keyboard shortcuts for weekly content pages.
 *
 * Reading uses NATIVE scrolling — wheel, trackpad, arrow keys, Space, and
 * PageUp/PageDown all behave exactly as the browser intends. This hook does
 * NOT hijack scroll keys, install scroll listeners, or measure block positions
 * on scroll. (The old "feed" model did all three — half-page smooth jumps on
 * j/k, a getBoundingClientRect sweep over every [data-content-block] on every
 * scroll tick, and a focus outline that chased the scroll — which made long
 * pages stutter and fight the reader. All removed.)
 *
 * The only shortcuts left are ones that don't conflict with reading:
 *   ←/→  previous / next week
 *   f    flag the content block currently nearest the viewport centre
 *
 * `keyboardActive` flips true on the first shortcut press so the hint bar can
 * reveal itself; it never changes on scroll.
 */
export function useContentKeyboard(opts: {
  prevWeekHref: string | null;
  nextWeekHref: string | null;
  flagMode?: boolean;
  onFlag?: () => void;
}) {
  const router = useRouter();
  const { prevWeekHref, nextWeekHref, flagMode = false, onFlag } = opts;
  const [keyboardActive, setKeyboardActive] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) return;

      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (flagMode) return;

      switch (e.key) {
        case 'ArrowLeft': {
          if (prevWeekHref) {
            e.preventDefault();
            setKeyboardActive(true);
            router.push(prevWeekHref);
          }
          break;
        }

        case 'ArrowRight': {
          if (nextWeekHref) {
            e.preventDefault();
            setKeyboardActive(true);
            router.push(nextWeekHref);
          }
          break;
        }

        case 'f':
        case 'F': {
          e.preventDefault();
          setKeyboardActive(true);
          onFlag?.();
          break;
        }
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [flagMode, nextWeekHref, onFlag, prevWeekHref, router]);

  return { keyboardActive };
}
