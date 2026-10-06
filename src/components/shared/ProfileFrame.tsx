import type { ReactNode } from 'react';

export function ProfileFrame({ children, mainClassName = 'mx-auto max-w-2xl px-4' }: { children: ReactNode; mainClassName?: string }) {
  return <div className="min-h-screen bg-[var(--md-surface)] py-8"><main className={mainClassName}>{children}</main></div>;
}
