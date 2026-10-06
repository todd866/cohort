'use client';
import { useState, useRef, useEffect } from 'react';
export interface ReviewModulePickerProps {
  disabled?: boolean;
  options: readonly {id: string; label: string}[];
  value: string | null;
  onChange: (value: string | null) => void;
  defaultLabel?: string;
  triggerDefaultLabel?: string;
  preferredId?: string | null;
  ariaPrefix?: string;
  onChangeEnrollment?: () => void;
  enrollmentLabel?: string;
}
export function ReviewModulePicker({disabled = false, options, value, onChange, defaultLabel = 'All', triggerDefaultLabel = defaultLabel, preferredId = null, ariaPrefix = 'Review module', onChangeEnrollment, enrollmentLabel = 'Change modules…'}: ReviewModulePickerProps) {
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

  if (options.length === 0) return null;

  const label = (id: string) => options.find(option => option.id === id)?.label ?? id;
  const triggerLabel = value ? label(value) : triggerDefaultLabel;
  const ordered = options.map(option => option.id);
  const examFirst = preferredId && ordered.includes(preferredId) ? preferredId : null;
  const rest = examFirst ? ordered.filter(id => id !== examFirst) : ordered;
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
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${ariaPrefix}: ${triggerLabel}`}
        title={triggerLabel}
        className="inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-[var(--md-outline-variant)] px-3 py-1 text-xs text-[var(--md-on-surface-variant)] transition-colors hover:bg-[var(--md-surface-container-high)]"
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <span aria-hidden className="shrink-0 opacity-60">{'▾'}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 min-w-[8rem] max-h-[min(70dvh,28rem)] overflow-y-auto rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] py-1 text-xs shadow-lg"
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
              {label(examFirst)}
            </button>
          )}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={value === null}
            onClick={() => pick(null)}
            className={itemClass(value === null)}
          >
            {defaultLabel}
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
              {label(slug)}
            </button>
          ))}
          {onChangeEnrollment && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onChangeEnrollment();
              }}
              className={`${itemClass(false)} border-t border-[var(--md-outline-variant)] text-[var(--md-primary)]`}
            >
              {enrollmentLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
