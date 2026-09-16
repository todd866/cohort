'use client';

import { useState, type ReactNode } from 'react';
import { useLearnMoreTracking } from '@/hooks/useTracking';

interface LearnMoreProps {
  title: string;
  children: ReactNode;
  id?: string;
}

export function LearnMore({ title, children, id }: LearnMoreProps) {
  const [expanded, setExpanded] = useState(false);
  const { onExpand, onCollapse } = useLearnMoreTracking(id || title);

  const handleToggle = () => {
    if (expanded) {
      onCollapse();
    } else {
      onExpand();
    }
    setExpanded(!expanded);
  };

  return (
    <div className="my-4 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] overflow-hidden">
      {/* Toggle Header */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[var(--md-surface-container-high)] transition-colors"
      >
        <svg
          className={`w-4 h-4 text-[var(--md-primary)] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-medium text-[var(--md-primary)]">{title}</span>
      </button>

      {/* Expandable Content */}
      <div
        className={`transition-all duration-200 ease-out ${
          expanded ? 'max-h-[2000px] opacity-100' : 'max-h-0 opacity-0'
        }`}
        style={{ overflow: 'hidden' }}
      >
        <div className="px-4 pb-4 pt-0 pl-10 text-[var(--md-on-surface)] text-sm leading-relaxed border-t border-[var(--md-outline-variant)]">
          {children}
        </div>
      </div>
    </div>
  );
}
