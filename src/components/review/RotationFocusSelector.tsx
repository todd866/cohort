'use client';

import { useState, useRef, useEffect } from 'react';
import { rotationLabel } from '@/lib/rotation-labels';
import { orderFocusOptions } from '@/lib/study/focus-option-order';

interface RotationFocusSelectorProps {
  /** Studyable rotation slugs the user is enrolled in. */
  options: string[];
  /** Currently focused rotation, or null for "All" (the blended feed). */
  value: string | null;
  /** Called with a slug to focus, or null to return to "All". */
  onChange: (next: string | null) => void;
  /** Show the picker even when the only saved choice is an opt-in focus deck. */
  forceVisible?: boolean;
  /**
   * When provided, the menu gains a "Change rotation…" entry (and the pill
   * renders even for single-rotation profiles) so switching ENROLMENT is one
   * tap from the review screen — before this, changing stream was buried in
   * the desktop Content page (requested 2026-08-19).
   */
  onChangeRotation?: () => void;
  /**
   * The rotation whose exam is actually booked. It renders ABOVE "All",
   * because "All" is not a peer of it: `evaluateObjectiveCoreGate` withholds
   * cross-source content until the day's work in the exam rotation is done, so
   * a blended session resolves to this rotation anyway until that is cleared.
   * Putting it first says what the menu already does.
   */
  examRotation?: string | null;
  /** Actual objective served when the URL has no explicit focus. */
  defaultRotation?: string | null;
}

/**
 * Compact pill + menu to focus the study session on one rotation. Ordinarily
 * it appears only for multi-rotation profiles; an offline focus-only pack can
 * force it visible so its single opt-in deck stays reachable without becoming
 * the default feed. Mirrors FeedModeToggle styling.
 */
export function RotationFocusSelector({
  options,
  value,
  onChange,
  forceVisible = false,
  onChangeRotation,
  examRotation = null,
  defaultRotation = null,
}: RotationFocusSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (options.length === 0 || (!forceVisible && !onChangeRotation && options.length <= 1)) return null;

  const defaultLabel = defaultRotation ? rotationLabel(defaultRotation) : 'All';
  const triggerLabel = value ? rotationLabel(value) : defaultLabel;
  // Ordered by the caller; the exam rotation is lifted out so it can sit above
  // "All" rather than wherever the shared order happens to put it.
  const ordered = orderFocusOptions(options);
  const examFirst = examRotation && ordered.includes(examRotation) ? examRotation : null;
  const rest = examFirst ? ordered.filter((slug) => slug !== examFirst) : ordered;
  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const itemClass = (active: boolean) =>
    `block w-full text-left px-3 py-1.5 transition-colors hover:bg-[var(--md-surface-container-high)] ${
      active ? 'text-[var(--md-primary)] font-medium' : 'text-[var(--md-on-surface)]'
    }`;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Focus rotation: ${triggerLabel}`}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-[var(--md-outline-variant)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)]"
      >
        {triggerLabel}
        <span aria-hidden className="opacity-60">{'▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[8rem] overflow-hidden rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] py-1 text-xs shadow-lg"
        >
          {examFirst && (
            <button
              key={examFirst}
              type="button"
              role="menuitemradio"
              aria-checked={value === examFirst}
              onClick={() => pick(examFirst)}
              className={itemClass(value === examFirst)}
            >
              {rotationLabel(examFirst)}
            </button>
          )}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            onClick={() => pick(null)}
            className={itemClass(value === null)}
          >
            {defaultRotation ? `Default (${defaultLabel})` : 'All'}
          </button>
          {rest.map((slug) => (
            <button
              key={slug}
              type="button"
              role="menuitemradio"
              aria-checked={value === slug}
              onClick={() => pick(slug)}
              className={itemClass(value === slug)}
            >
              {rotationLabel(slug)}
            </button>
          ))}
          {onChangeRotation && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChangeRotation();
              }}
              className={`${itemClass(false)} border-t border-[var(--md-outline-variant)] text-[var(--md-primary)]`}
            >
              Change rotation…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
