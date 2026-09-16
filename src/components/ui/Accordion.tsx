'use client';

import { useState } from 'react';

export function Accordion({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-[var(--md-outline-variant)] rounded-2xl overflow-hidden mb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-[var(--md-surface-container)] transition-colors"
      >
        <span className="font-semibold text-[var(--md-on-surface)]">{title}</span>
        <span className="text-xs text-[var(--md-on-surface-variant)]">
          {subtitle} {open ? '\u25B4' : '\u25BE'}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}
