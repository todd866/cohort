/**
 * EvidenceSection
 *
 * Groups and displays citations by evidence tier (guidelines, research, foundational).
 * Shows a quality summary bar and per-tier citation lists.
 */

import {
  EVIDENCE_TIERS,
  groupCitationsByTier,
  type CardCitationWithSource,
} from '@/lib/citations/evidence-tiers';
import { CitationCard } from './CitationCard';

export function EvidenceSection({ citations }: { citations: CardCitationWithSource[] }) {
  const groups = groupCitationsByTier(citations);
  const tierOrder: (keyof typeof EVIDENCE_TIERS)[] = ['procedural', 'research', 'foundational'];

  // Count total and by tier
  const total = citations.length;
  const verifiedCount = citations.filter((c) => c.citation.verified).length;
  const tierCounts = {
    procedural: groups.procedural.length,
    research: groups.research.length,
    foundational: groups.foundational.length,
  };
  const hasMultipleTiers = tierOrder.filter((t) => groups[t].length > 0).length > 1;

  // Evidence quality (simple heuristic)
  const tiersPresent = Object.values(tierCounts).filter((c) => c > 0).length;
  const hasPrimary = citations.some((c) => c.isPrimary);
  const score = tiersPresent * 2 + (hasPrimary ? 1 : 0) + (verifiedCount > 0 ? 1 : 0);
  const quality =
    score >= 6 ? { label: 'Strong', color: 'text-green-600' } :
    score >= 4 ? { label: 'Moderate', color: 'text-blue-600' } :
    score >= 2 ? { label: 'Basic', color: 'text-amber-600' } :
    { label: 'Minimal', color: 'text-[var(--md-on-surface-variant)]' };

  return (
    <section className="mb-6">
      <h2 className="text-sm font-medium text-[var(--md-on-surface)] mb-3 uppercase tracking-wide">
        Evidence
      </h2>

      {/* Quality summary bar */}
      <div className="flex items-center gap-3 p-2 rounded-lg bg-[var(--md-surface-container-low)] mb-4">
        <span className={`text-xs font-medium ${quality.color}`}>{quality.label}</span>
        <div className="flex-1 flex items-center gap-2 text-xs text-[var(--md-on-surface-variant)]">
          {tierCounts.procedural > 0 && <span title="Guidelines">{EVIDENCE_TIERS.procedural.icon} {tierCounts.procedural}</span>}
          {tierCounts.research > 0 && <span title="Research">{EVIDENCE_TIERS.research.icon} {tierCounts.research}</span>}
          {tierCounts.foundational > 0 && <span title="Textbooks">{EVIDENCE_TIERS.foundational.icon} {tierCounts.foundational}</span>}
        </div>
        <span className="text-xs">
          {verifiedCount === total ? (
            <span className="text-green-600">✓ All verified</span>
          ) : verifiedCount > 0 ? (
            <span className="text-amber-600">{verifiedCount}/{total} verified</span>
          ) : (
            <span className="text-[var(--md-on-surface-variant)]">Unverified</span>
          )}
        </span>
      </div>

      <div className="space-y-4">
        {tierOrder.map((tier) => {
          const tierCitations = groups[tier];
          if (tierCitations.length === 0) return null;

          const tierInfo = EVIDENCE_TIERS[tier];

          return (
            <div key={tier}>
              {/* Tier header - only show if multiple tiers */}
              {hasMultipleTiers && (
                <div className="flex items-center gap-2 mb-2">
                  <span>{tierInfo.icon}</span>
                  <span className={`text-xs font-medium ${tierInfo.textClass}`}>
                    {tierInfo.label}
                  </span>
                  <span className="text-xs text-[var(--md-on-surface-variant)]">
                    ({tierCitations.length})
                  </span>
                </div>
              )}

              {/* Citations in this tier */}
              <div className="space-y-2">
                {tierCitations.map((cc) => (
                  <CitationCard key={cc.id} cc={cc} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
