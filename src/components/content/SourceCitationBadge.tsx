'use client';

import { useState } from 'react';
import { useInteractionTracking } from '@/hooks/useTracking';

interface SourceCitationBadgeProps {
  // For static rendering (inline data)
  level1Text: string;
  level2Quote?: string | null;
  level2Context?: string | null;
  sourceUrl?: string | null;
  reliability?: number;
  sourceType?: string;
  // Or fetch by ID
  citationId?: string;
}

/**
 * Reliability tier indicator
 * 5 = Gold standard (guidelines)
 * 4 = High quality (textbook)
 * 3 = Standard (lecture)
 * 2 = Secondary
 * 1 = Unverified
 */
function ReliabilityIndicator({ tier }: { tier: number }) {
  const tiers: Record<number, { stars: string; label: string; color: string }> = {
    5: { stars: '***', label: 'Gold standard (guidelines)', color: 'text-amber-500' },
    4: { stars: '**', label: 'High quality (textbook)', color: 'text-slate-400' },
    3: { stars: '*', label: 'Standard', color: 'text-slate-500' },
    2: { stars: '', label: 'Secondary', color: 'text-slate-600' },
    1: { stars: '?', label: 'Unverified', color: 'text-slate-600 opacity-50' },
  };

  const t = tiers[tier] || tiers[3];
  return (
    <span className={`${t.color} text-xs font-bold mr-1`} title={t.label}>
      {t.stars}
    </span>
  );
}

export function SourceCitationBadge({
  level1Text,
  level2Quote,
  level2Context,
  sourceUrl,
  reliability = 3,
  sourceType,
  citationId,
}: SourceCitationBadgeProps) {
  const [expanded, setExpanded] = useState(false);
  const { trackInteraction } = useInteractionTracking();

  const handleClick = () => {
    setExpanded(!expanded);
    if (!expanded) {
      trackInteraction('SourceCitation', 'expand', citationId || level1Text, {
        level1Text,
        reliability,
        sourceType,
      });
    }
  };

  const hasLevel2 = level2Quote || level2Context;

  return (
    <span className="inline-block align-middle">
      {/* Level 1: Always visible badge */}
      <button
        onClick={hasLevel2 ? handleClick : undefined}
        className={`
          inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs
          bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]
          ${hasLevel2 ? 'cursor-pointer hover:bg-[var(--md-surface-container)] hover:text-[var(--md-on-surface)]' : ''}
          transition-colors
        `}
        type="button"
        aria-expanded={expanded}
      >
        <ReliabilityIndicator tier={reliability} />
        <span className="font-medium">{level1Text}</span>
        {hasLevel2 && (
          <svg
            className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Level 2: Expanded quote/context */}
      {expanded && hasLevel2 && (
        <div className="mt-2 p-3 rounded-lg bg-[var(--md-surface-container)] text-sm border border-[var(--md-outline-variant)]">
          {level2Quote && (
            <blockquote className="italic text-[var(--md-on-surface-variant)] border-l-2 border-[var(--md-primary)] pl-3 mb-2">
              &ldquo;{level2Quote}&rdquo;
            </blockquote>
          )}
          {level2Context && (
            <p className="text-[var(--md-on-surface-variant)] text-xs opacity-80">{level2Context}</p>
          )}

          {/* Level 3: Link to original */}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-[var(--md-primary)] hover:underline"
              onClick={() =>
                trackInteraction('SourceCitation', 'open_source', citationId || level1Text, {
                  sourceUrl,
                })
              }
            >
              View original source
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 3h7v7m0-7L10 14" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5v14h14v-7" />
              </svg>
            </a>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Simple citation badge without progressive disclosure
 * For backwards compatibility and simple inline citations
 */
export function SimpleCitation({
  text,
  reliability = 3,
}: {
  text: string;
  reliability?: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]">
      <ReliabilityIndicator tier={reliability} />
      <span className="font-medium">{text}</span>
    </span>
  );
}
