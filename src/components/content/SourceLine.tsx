import { type ReactNode } from 'react';

interface SourceLineProps {
  label?: 'Source' | 'Sources';
  children: ReactNode;
}

export function SourceLine({ label = 'Source', children }: SourceLineProps) {
  return (
    <p className="mt-2 mb-0 text-xs text-[var(--md-on-surface-variant)]">
      <span className="font-medium">{label}:</span> {children}
    </p>
  );
}

