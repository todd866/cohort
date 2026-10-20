'use client';

/**
 * The manual exam-entry form, kept as an escape hatch behind a ⋯ menu: the
 * default is uploading the feedback document, not typing numbers.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function RecordExamButton({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  return (
    <>
      <span ref={wrap} className="relative">
        <button type="button" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="More exam options" title="More"
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-lg leading-none text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)]">
          ⋯
        </button>
        {menu && (
          <span role="menu" className="absolute right-0 top-full z-20 mt-1 flex min-w-36 flex-col rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface)] py-1 shadow-md">
            <button type="button" role="menuitem" onClick={() => { setOpen((o) => !o); setMenu(false); }} aria-controls="record-exam"
              className="min-h-9 px-3 text-left text-sm text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]">
              {open ? 'Close editor' : 'Edit numbers'}
            </button>
          </span>
        )}
      </span>
      {open && <div id="record-exam" className="order-last basis-full pt-3">{children}</div>}
    </>
  );
}
