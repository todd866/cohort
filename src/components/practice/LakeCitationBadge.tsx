'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

export interface LakeCitationData {
  chunkId: string;
  heading: string;
  content: string;
  sourceName: string;
  articleTitle: string;
  articleUrl: string;
  reliabilityTier: 'gold' | 'silver' | 'bronze';
  citationType: 'supports' | 'derived_from';
}

interface LakeCitationBadgeProps extends LakeCitationData {
  // Optional engagement tracking
  onEngagementStart?: (chunkId: string) => void;
  onEngagementEnd?: (chunkId: string, durationMs: number) => void;
}

const tierColors = {
  gold: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-800 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700',
  silver: 'bg-gray-100 dark:bg-gray-800/40 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600',
  bronze: 'bg-orange-100 dark:bg-orange-900/40 text-orange-800 dark:text-orange-200 border-orange-300 dark:border-orange-700',
};

const tierIcons = {
  gold: '★',
  silver: '◆',
  bronze: '●',
};

export function LakeCitationBadge({
  chunkId,
  heading,
  content,
  sourceName,
  articleTitle,
  articleUrl,
  reliabilityTier,
  onEngagementStart,
  onEngagementEnd,
}: LakeCitationBadgeProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const engageStartTime = useRef<number | null>(null);

  // Handle expand/collapse with engagement tracking
  const handleToggle = useCallback(() => {
    if (!isExpanded) {
      // Starting engagement
      engageStartTime.current = Date.now();
      onEngagementStart?.(chunkId);
    } else {
      // Ending engagement
      if (engageStartTime.current) {
        const durationMs = Date.now() - engageStartTime.current;
        onEngagementEnd?.(chunkId, durationMs);
        engageStartTime.current = null;
      }
    }
    setIsExpanded(!isExpanded);
  }, [isExpanded, chunkId, onEngagementStart, onEngagementEnd]);

  // Truncate content for preview
  const previewLength = 150;
  const contentPreview =
    content.length > previewLength ? content.substring(0, previewLength) + '...' : content;

  return (
    <div
      className={`rounded-lg border ${tierColors[reliabilityTier]} overflow-hidden transition-all duration-200`}
    >
      {/* Header - always visible */}
      <button
        onClick={handleToggle}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
      >
        <span className="text-sm font-medium">{tierIcons[reliabilityTier]}</span>
        <span className="flex-1 text-sm font-medium truncate">{sourceName}</span>
        <span className="text-xs opacity-75 truncate max-w-[120px]">{heading}</span>
        <span className="text-xs ml-1">{isExpanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-3 py-2 border-t border-current/10 bg-white/50 dark:bg-black/20">
          <p className="text-xs font-medium mb-1 opacity-75">{articleTitle}</p>
          <p className="text-sm leading-relaxed">{contentPreview}</p>
          {articleUrl && (
            <a
              href={articleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              View source →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

interface LakeCitationsListProps {
  citations: LakeCitationData[];
  className?: string;
  // Tracking context - if provided, exposures will be logged
  trackingContext?: {
    primaryType: 'card' | 'question' | 'page' | 'deep_dive';
    primaryId: string;
    sessionId?: string;
  };
}

export function LakeCitationsList({
  citations,
  className = '',
  trackingContext,
}: LakeCitationsListProps) {
  // Track which citations have been engaged with
  const engagedCitations = useRef<Map<string, { exposureId?: string }>>(new Map());

  // Log exposure when list mounts (if tracking enabled)
  const hasLoggedExposures = useRef(false);

  // Log all citations as exposed when the list is first rendered
  const logExposures = useCallback(async () => {
    if (!trackingContext || hasLoggedExposures.current || citations.length === 0) return;
    hasLoggedExposures.current = true;

    try {
      const response = await fetch('/api/analytics/exposure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          primaryType: trackingContext.primaryType,
          primaryId: trackingContext.primaryId,
          sessionId: trackingContext.sessionId,
          exposedType: 'lake_chunk',
          exposureReason: 'semantic_similarity',
          exposures: citations.map((c) => ({
            exposedId: c.chunkId,
            similarityScore: undefined, // Could be added if available
          })),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        citations.forEach((c, i) => {
          engagedCitations.current.set(c.chunkId, {
            exposureId: data.exposureIds?.[i],
          });
        });
      }
    } catch (error) {
      console.error('Failed to log citation exposures:', error);
    }
  }, [trackingContext, citations]);

  // Log exposures on mount
  useEffect(() => {
    logExposures();
  }, [logExposures]);

  // Handle engagement start
  const handleEngagementStart = useCallback((chunkId: string) => {
    const tracked = engagedCitations.current.get(chunkId);
    if (tracked) {
      void tracked.exposureId; // Placeholder: could add start time tracking
    }
  }, []);

  // Handle engagement end
  const handleEngagementEnd = useCallback(async (chunkId: string, durationMs: number) => {
    const tracked = engagedCitations.current.get(chunkId);
    if (!tracked?.exposureId) return;

    try {
      await fetch('/api/analytics/exposure', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exposureId: tracked.exposureId,
          engagementMs: durationMs,
        }),
      });
    } catch (error) {
      console.error('Failed to log citation engagement:', error);
    }
  }, []);

  if (citations.length === 0) {
    return null;
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <p className="text-xs font-medium text-[var(--md-on-surface-variant)] uppercase tracking-wide">
        Sources ({citations.length})
      </p>
      <div className="space-y-1">
        {citations.map((citation) => (
          <LakeCitationBadge
            key={citation.chunkId}
            {...citation}
            onEngagementStart={trackingContext ? handleEngagementStart : undefined}
            onEngagementEnd={trackingContext ? handleEngagementEnd : undefined}
          />
        ))}
      </div>
    </div>
  );
}
