'use client';

import { useState, type ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  badge?: string | number;
}

export function CollapsibleSection({
  title,
  subtitle,
  defaultOpen = true,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-[var(--md-outline-variant)] rounded-xl overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between bg-[var(--md-surface-container)] hover:bg-[var(--md-surface-container-high)] active:scale-[0.995] transition-all"
      >
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-[var(--md-on-surface)]">{title}</h2>
          {badge !== undefined && (
            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]">
              {badge}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {subtitle && !isOpen && (
            <span className="text-sm text-[var(--md-on-surface-variant)]">{subtitle}</span>
          )}
          <svg
            className={`w-5 h-5 text-[var(--md-on-surface-variant)] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      <div
        className={`transition-all duration-200 ease-out ${
          isOpen ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'
        }`}
      >
        <div className="p-4 border-t border-[var(--md-outline-variant)]">
          {subtitle && (
            <p className="text-sm text-[var(--md-on-surface-variant)] mb-4">{subtitle}</p>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
