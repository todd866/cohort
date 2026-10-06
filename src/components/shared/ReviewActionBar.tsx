'use client';
import type { ReactNode } from 'react';

/** The same fixed action position before and after answering on every host. */
export function ReviewActionBar({children, onClick, disabled = false, ariaLabel}: {children: ReactNode; onClick: () => void; disabled?: boolean; ariaLabel?: string}) {
  return <div className="fixed left-0 right-0 md:left-20 z-50 p-4 border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)] shadow-[0_-10px_28px_rgba(21,35,46,0.08)] safe-area-pb" style={{bottom: 'var(--md-review-footer-bottom, 0px)'}}>
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className="review-choice max-w-2xl mx-auto w-full block min-h-[52px] py-3 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-high)] hover:bg-[var(--md-surface-container-highest)] text-[var(--md-on-surface)] font-medium transition-colors disabled:cursor-wait disabled:opacity-60">{children}</button>
  </div>;
}
