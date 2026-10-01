'use client';

/**
 * Lake Sources Section with Exposure Tracking
 *
 * Wraps lake citations display with learning analytics tracking.
 * Logs exposures when citations are rendered, tracks engagement on clicks.
 */

import { useEffect, useRef } from 'react';
import { useContentExposure } from '@/hooks/useContentExposure';
import type { CardCitationWithDetails } from '@/lib/content-lake-client';

// Lake reliability tier styling
const LAKE_TIERS = {
  gold: {
    label: 'Authoritative',
    icon: '★',
    bgClass: 'bg-yellow-500/10 border-yellow-500/30',
    textClass: 'text-yellow-700 dark:text-yellow-300',
  },
  silver: {
    label: 'Standard',
    icon: '●',
    bgClass: 'bg-gray-500/10 border-gray-500/30',
    textClass: 'text-gray-600 dark:text-gray-300',
  },
  bronze: {
    label: 'Educational',
    icon: '●',
    bgClass: 'bg-orange-500/10 border-orange-500/30',
    textClass: 'text-orange-700 dark:text-orange-300',
  },
} as const;

interface LakeCitationCardProps {
  citation: CardCitationWithDetails;
  onEngage: (chunkId: string) => void;
}

function LakeCitationCard({ citation, onEngage }: LakeCitationCardProps) {
  const tier = LAKE_TIERS[citation.reliabilityTier] || LAKE_TIERS.silver;
  const engageStartRef = useRef<number | null>(null);

  const handleClick = () => {
    if (!engageStartRef.current) {
      engageStartRef.current = Date.now();
    }
  };

  const handleSourceClick = () => {
    // Calculate engagement duration and mark as engaged
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _engagementMs = engageStartRef.current
      ? Date.now() - engageStartRef.current
      : undefined;
    onEngage(citation.chunkId);
  };

  return (
    <div
      className={`p-3 rounded-lg border ${tier.bgClass} cursor-pointer hover:opacity-90 transition-opacity`}
      onClick={handleClick}
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 text-xs font-medium px-2 py-1 rounded bg-[var(--md-surface-container)] text-[var(--md-on-surface-variant)]">
          {tier.icon} {citation.sourceName}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--md-on-surface)]">
            {citation.heading}
          </div>
          <p className="text-sm text-[var(--md-on-surface-variant)] mt-1 line-clamp-3">
            {citation.content}
          </p>
          <div className="flex items-center gap-2 mt-2 text-xs text-[var(--md-on-surface-variant)]">
            <span>{citation.articleTitle}</span>
            {citation.articleUrl && (
              <a
                href={citation.articleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--md-primary)] hover:underline"
                onClick={handleSourceClick}
              >
                View source →
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface LakeSourcesWithTrackingProps {
  cardId: string;
  citations: CardCitationWithDetails[];
}

export function LakeSourcesWithTracking({
  cardId,
  citations,
}: LakeSourcesWithTrackingProps) {
  const { logMultipleExposures, markEngaged } = useContentExposure({
    primaryType: 'card',
    primaryId: cardId,
  });

  const hasLoggedRef = useRef(false);

  // Log exposures when citations are rendered
  useEffect(() => {
    if (citations.length === 0 || hasLoggedRef.current) return;

    hasLoggedRef.current = true;

    // Log all lake citations as exposures
    logMultipleExposures({
      exposedType: 'lake_chunk',
      exposureReason: 'semantic_similarity',
      exposures: citations.map((c) => ({
        exposedId: c.chunkId,
        // Note: similarity score not available from content lake storage
      })),
    });
  }, [citations, logMultipleExposures]);

  // Handle engagement when user interacts with a citation
  const handleEngage = async (chunkId: string) => {
    await markEngaged(chunkId);
  };

  if (citations.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-sm font-medium text-[var(--md-on-surface)] mb-3 uppercase tracking-wide">
        Source Material
      </h2>
      <div className="text-xs text-[var(--md-on-surface-variant)] mb-3">
        Matched from content lake ({citations.length} sources)
      </div>
      <div className="space-y-2">
        {citations.map((citation) => (
          <LakeCitationCard
            key={citation.chunkId}
            citation={citation}
            onEngage={handleEngage}
          />
        ))}
      </div>
    </section>
  );
}
