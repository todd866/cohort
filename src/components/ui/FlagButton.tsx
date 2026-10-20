'use client';

import type { ButtonHTMLAttributes } from 'react';

export function FlagIcon({ className = '', filled = false }: { className?: string; filled?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" className={className} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 22V3" />
      <path d="M4 4c6-3 10 3 16 0v11c-6 3-10-3-16 0Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" />
    </svg>
  );
}

export interface FlagButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  flagged?: boolean;
  pending?: boolean;
}

export function FlagButton({ flagged = false, pending = false, className = '', 'aria-label': ariaLabel, title, ...props }: FlagButtonProps) {
  const label = ariaLabel ?? (flagged ? 'Flagged' : pending ? 'Flag queued' : 'Flag');
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      data-flag-button
      data-state={pending ? 'pending' : flagged ? 'flagged' : 'ready'}
      aria-busy={pending || undefined}
      aria-label={label}
      title={title ?? label}
      className={`relative inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-[var(--md-outline-variant)] text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)] ${flagged ? 'bg-[var(--md-warning-container)] text-[var(--md-on-warning-container)] border-[var(--md-warning)]' : ''} ${className}`}
    >
      <FlagIcon filled={flagged} />
      {pending && <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" className="absolute -right-[2px] -top-[2px] rounded-full bg-[var(--md-surface)] text-[var(--md-on-surface)]" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="6" /><path d="M8 4v4l3 1" /></svg>}
    </button>
  );
}
