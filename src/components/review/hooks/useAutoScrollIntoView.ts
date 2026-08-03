import { useEffect } from 'react';

/**
 * Scroll an element into view shortly after it becomes active.
 *
 * Used by the group-review flow to bring the rating buttons into view once a
 * card is revealed / an MCQ is answered. The small delay lets the DOM update
 * first; the optional-chained `scrollIntoView` tolerates environments (jsdom)
 * that don't implement it.
 */
export function useAutoScrollIntoView<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  active: boolean,
  delayMs: number = 100,
): void {
  useEffect(() => {
    if (!active || !ref.current) return;

    const timeoutId = window.setTimeout(() => {
      ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }, delayMs);

    return () => window.clearTimeout(timeoutId);
  }, [active, ref, delayMs]);
}
