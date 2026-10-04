'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function DecodedTerm({ expansion, children }: { expansion: string; children: React.ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const cancelHover = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  useLayoutEffect(() => () => cancelHover(), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tooltip.current) return;
    const place = () => {
      const trigger = anchor.current;
      const bubble = tooltip.current;
      if (!trigger || !bubble) return;
      // Fixed body-portal positions and client rects use layout coordinates;
      // visualViewport offsets locate the visible region within that space.
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const width = (viewport?.width ?? window.innerWidth) - 16;
      const height = (viewport?.height ?? window.innerHeight) - 16;
      bubble.style.maxWidth = `${Math.max(1, Math.min(250, width))}px`;
      bubble.style.maxHeight = `${Math.max(1, height)}px`;
      const rect = trigger.getBoundingClientRect();
      const size = bubble.getBoundingClientRect();
      const x = Math.max(left, Math.min(rect.left + rect.width / 2 - size.width / 2, left + width - size.width));
      const preferredY = rect.top - size.height - 6;
      const y = Math.max(top, Math.min(preferredY >= top ? preferredY : rect.bottom + 6, top + height - size.height));
      bubble.style.left = `${x}px`;
      bubble.style.top = `${y}px`;
      bubble.style.visibility = 'visible';
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelHover();
        setOpen(false);
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(tooltip.current);
    observer.observe(anchor.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', escape);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', escape);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open, expansion]);

  return (
    <>
      <abbr
        ref={anchor}
        className="term-tooltip cursor-help border-b border-dotted border-[var(--md-on-surface-variant)] text-[var(--md-on-surface)] no-underline"
        data-tooltip={expansion}
        aria-describedby={open ? id : undefined}
        tabIndex={0}
        role="definition"
        onMouseEnter={() => {
          hovered.current = true;
          cancelHover();
          timer.current = setTimeout(() => setOpen(true), 120);
        }}
        onMouseLeave={() => {
          hovered.current = false;
          cancelHover();
          if (!focused.current) timer.current = setTimeout(() => setOpen(false), 120);
        }}
        onFocus={() => {
          focused.current = true;
          cancelHover();
          setOpen(true);
        }}
        onBlur={() => {
          focused.current = false;
          if (!hovered.current) setOpen(false);
        }}
        onClick={(event) => { event.currentTarget.focus(); cancelHover(); setOpen(true); }}
      >
        {children}
      </abbr>
      {open && createPortal(
        <span
          ref={tooltip} id={id} role="tooltip" className="term-tooltip-bubble"
          style={{ visibility: 'hidden' }}
          onMouseEnter={() => { hovered.current = true; cancelHover(); }}
          onMouseLeave={() => {
            hovered.current = false;
            cancelHover();
            if (!focused.current) timer.current = setTimeout(() => setOpen(false), 120);
          }}
        >
          {expansion}
        </span>,
        document.body,
      )}
    </>
  );
}
