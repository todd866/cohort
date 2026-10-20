import type { ReactNode } from 'react';

/** Secondary factual readings stay available without displacing study controls. */
export function ProfileInsights({ children }: { children: ReactNode }) {
  return (
    <details className="mb-6 border-b border-[var(--md-outline-soft)] text-sm">
      <summary className="min-h-11 cursor-pointer py-3 font-medium text-[var(--md-on-surface-variant)]">Study insights</summary>
      {children}
    </details>
  );
}
