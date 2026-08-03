'use client';

import { RefObject, useRef } from 'react';
import { useActiveHeading } from '@/hooks/useActiveHeading';

interface Props {
  containerRef: RefObject<HTMLElement | null>;
}

function stripNumberPrefix(text: string): string {
  return text.replace(/^\d+\.\s*/, '');
}

/**
 * Self-contained smooth scroll. Native `scrollIntoView({behavior:'smooth'})`
 * is unreliable across browser configs (it no-ops in some), so we animate with
 * requestAnimationFrame ourselves: dead-reliable, reduced-motion aware, and it
 * yields instantly if the reader scrolls mid-jump (so it never fights them).
 */
function animateScrollTo(targetY: number) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const startY = window.scrollY;
  const distance = targetY - startY;

  // Instant when motion is reduced, the move is tiny, or the tab is hidden
  // (requestAnimationFrame is paused in background tabs, so an animation would
  // never run — fall back so the jump always lands).
  if (reduce || document.hidden || Math.abs(distance) < 2) {
    window.scrollTo(0, targetY);
    return;
  }

  const duration = Math.min(600, Math.max(220, Math.abs(distance) * 0.35));
  const easeInOutQuad = (t: number) =>
    t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  let startTime: number | null = null;
  let cancelled = false;
  const cancel = () => { cancelled = true; };

  const cleanup = () => {
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('keydown', cancel);
  };

  // The reader takes over the instant they scroll/type.
  window.addEventListener('wheel', cancel, { passive: true, once: true });
  window.addEventListener('touchstart', cancel, { passive: true, once: true });
  window.addEventListener('keydown', cancel, { once: true });

  const step = (now: number) => {
    if (cancelled) { cleanup(); return; }
    if (startTime === null) startTime = now;
    const progress = Math.min(1, (now - startTime) / duration);
    window.scrollTo(0, startY + distance * easeInOutQuad(progress));
    if (progress < 1) requestAnimationFrame(step);
    else cleanup();
  };

  requestAnimationFrame(step);
}

export function TopicTabBar({ containerRef }: Props) {
  const { activeId, headings } = useActiveHeading(containerRef);
  const barRef = useRef<HTMLDivElement>(null);

  if (headings.length === 0) return null;

  function scrollToHeading(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    // Land the heading just below the sticky bar.
    const barHeight = barRef.current?.offsetHeight ?? 56;
    const top = el.getBoundingClientRect().top + window.scrollY - barHeight - 12;
    animateScrollTo(Math.max(0, top));
  }

  return (
    <div ref={barRef} className="sticky top-0 z-30 bg-[var(--md-surface)]/95 backdrop-blur border-b border-[var(--md-outline-variant)]">
      <div className="max-w-4xl mx-auto px-6">
        <div className="flex gap-1 overflow-x-auto py-2 scrollbar-hide">
          {headings.map((h) => (
            <button
              key={h.id}
              data-active={activeId === h.id ? 'true' : 'false'}
              onClick={() => scrollToHeading(h.id)}
              className={`
                whitespace-nowrap px-3 py-1.5 text-sm font-medium rounded-full transition-colors shrink-0
                ${activeId === h.id
                  ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                  : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-highest)]'
                }
              `}
            >
              {stripNumberPrefix(h.text)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
