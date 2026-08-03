/**
 * CitationCard
 *
 * Renders a single database citation with source badge, verification status,
 * and relationship indicators (primary, contradicts, contextualizes).
 */

import type { CardCitationWithSource } from '@/lib/citations/evidence-tiers';

export function CitationCard({ cc }: { cc: CardCitationWithSource }) {
  const isContradict = cc.relationship === 'contradicts';
  const isContext = cc.relationship === 'contextualizes';

  return (
    <div
      className={`p-3 rounded-lg border ${
        isContradict
          ? 'bg-red-500/10 border-red-500/30'
          : cc.isPrimary
            ? 'bg-[var(--md-primary-container)]/20 border-[var(--md-primary)]/30'
            : 'bg-[var(--md-surface-container-high)] border-transparent'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Source badge */}
        <div className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]">
          {cc.citation.source.shortName}
        </div>

        <div className="flex-1 min-w-0">
          {/* Citation text */}
          <div className="flex items-center gap-2 flex-wrap">
            {cc.isPrimary && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium">
                Primary
              </span>
            )}
            {isContradict && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-700 dark:text-red-300">
                ✗ Contradicts
              </span>
            )}
            {isContext && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300">
                ↳ Context
              </span>
            )}
            <span className="text-sm font-medium text-[var(--md-on-surface)]">
              {cc.citation.level1Text}
            </span>
          </div>

          {/* Quote if available */}
          {cc.citation.level2Quote && (
            <p className="text-sm text-[var(--md-on-surface-variant)] mt-2 pl-3 border-l-2 border-[var(--md-outline-variant)] italic">
              &ldquo;{cc.citation.level2Quote}&rdquo;
            </p>
          )}

          {/* Jurisdiction note */}
          {cc.jurisdictionNote && (
            <p className="text-xs text-[var(--md-tertiary)] mt-2">
              ⚠️ {cc.jurisdictionNote}
            </p>
          )}

          {/* Metadata row */}
          <div className="flex items-center gap-2 mt-2 text-xs text-[var(--md-on-surface-variant)]">
            {cc.citation.source.jurisdiction && (
              <span className="px-1.5 py-0.5 rounded bg-[var(--md-surface-container)] uppercase">
                {cc.citation.source.jurisdiction}
              </span>
            )}
            {cc.citation.verified ? (
              <span className="text-green-600 flex items-center gap-1">
                <span>✓</span>
                <span>Verified</span>
                {cc.citation.verifiedAt && (
                  <span>
                    {new Date(cc.citation.verifiedAt).toLocaleDateString('en-AU', {
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-amber-500 flex items-center gap-1">
                <span>○</span>
                <span>Unverified</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
