'use client';

import { useState, useRef, useEffect } from 'react';
import { rotationLabel } from '@/lib/rotation-labels';

interface RotationFocusSelectorProps {
  /** Studyable rotation slugs the user is enrolled in. */
  options: string[];
  /** Currently focused rotation, or null for "All" (the blended feed). */
  value: string | null;
  /** Called with a slug to focus, or null to return to "All". */
  onChange: (next: string | null) => void;
  /** Show the picker even when the only saved choice is an opt-in focus deck. */
  forceVisible?: boolean;
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

  if (options.length === 0 || (!forceVisible && options.length <= 1)) return null;

  const triggerLabel = value ? rotationLabel(value) : 'All';
  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  const itemClass = (active: boolean) =>
    `block w-full text-left px-3 py-1.5 transition-colors hover:bg-[var(--md-surface-container-high)] ${
      active ? 'text-[var(--md-primary)] font-medium' : 'text-[var(--md-on-surface)]'
    }`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Focus rotation: ${triggerLabel}`}
        className="inline-flex items-center gap-1 rounded-full border border-[var(--md-outline-variant)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)]"
      >
        {triggerLabel}
        <span aria-hidden className="opacity-60">{'▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[8rem] overflow-hidden rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] py-1 text-xs shadow-lg"
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            onClick={() => pick(null)}
            className={itemClass(value === null)}
          >
            All
          </button>
          {options.map((slug) => (
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
        </div>
      )}
    </div>
  );
}
