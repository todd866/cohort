/**
 * Content Exposure Tracking Hook
 *
 * Tracks when related content is shown and when users engage with it.
 * Uses the analytics API to log exposures for the learning analytics system.
 */

import { useCallback, useRef } from 'react';

export type PrimaryContentType = 'card' | 'question' | 'page' | 'deep_dive';
export type ExposureType = 'lake_chunk' | 'related_card' | 'citation' | 'recommendation';
export type ExposureReason = 'semantic_similarity' | 'same_topic' | 'remediation' | 'random';

interface ExposureContext {
  primaryType: PrimaryContentType;
  primaryId: string;
  sessionId?: string;
  positionInSession?: number;
  daysUntilExam?: number;
}

interface TrackedExposure {
  exposureId: string;
  exposedId: string;
  engageStartTime?: number;
}

/**
 * Hook for tracking content exposures and engagement.
 *
 * Usage:
 * ```tsx
 * const { logExposure, markEngaged } = useContentExposure({
 *   primaryType: 'card',
 *   primaryId: cardId,
 * });
 *
 * // When citation is displayed
 * const exposureId = await logExposure({
 *   exposedType: 'lake_chunk',
 *   exposedId: chunkId,
 *   exposureReason: 'semantic_similarity',
 * });
 *
 * // When user clicks/expands
 * await markEngaged(exposureId, engagementMs);
 * ```
 */
export function useContentExposure(context: ExposureContext) {
  const trackedExposures = useRef<Map<string, TrackedExposure>>(new Map());

  /**
   * Log that content was exposed to the user.
   * Returns the exposure ID for later engagement tracking.
   */
  const logExposure = useCallback(
    async (params: {
      exposedType: ExposureType;
      exposedId: string;
      exposureReason: ExposureReason;
      similarityScore?: number;
    }): Promise<string | null> => {
      try {
        const response = await fetch('/api/analytics/exposure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            primaryType: context.primaryType,
            primaryId: context.primaryId,
            sessionId: context.sessionId,
            positionInSession: context.positionInSession,
            daysUntilExam: context.daysUntilExam,
            ...params,
          }),
        });

        if (!response.ok) {
          console.error('Failed to log exposure:', response.status);
          return null;
        }

        const data = await response.json();
        const exposureId = data.exposureId;

        // Track locally for engagement
        trackedExposures.current.set(params.exposedId, {
          exposureId,
          exposedId: params.exposedId,
        });

        return exposureId;
      } catch (error) {
        console.error('Error logging exposure:', error);
        return null;
      }
    },
    [context]
  );

  /**
   * Log multiple exposures at once (for lists of citations).
   */
  const logMultipleExposures = useCallback(
    async (params: {
      exposedType: ExposureType;
      exposureReason: ExposureReason;
      exposures: Array<{ exposedId: string; similarityScore?: number }>;
    }): Promise<string[]> => {
      try {
        const response = await fetch('/api/analytics/exposure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            primaryType: context.primaryType,
            primaryId: context.primaryId,
            sessionId: context.sessionId,
            positionInSession: context.positionInSession,
            daysUntilExam: context.daysUntilExam,
            exposedType: params.exposedType,
            exposureReason: params.exposureReason,
            exposures: params.exposures,
          }),
        });

        if (!response.ok) {
          console.error('Failed to log exposures:', response.status);
          return [];
        }

        const data = await response.json();
        const exposureIds = data.exposureIds as string[];

        // Track locally for engagement
        params.exposures.forEach((exp, i) => {
          trackedExposures.current.set(exp.exposedId, {
            exposureId: exposureIds[i],
            exposedId: exp.exposedId,
          });
        });

        return exposureIds;
      } catch (error) {
        console.error('Error logging exposures:', error);
        return [];
      }
    },
    [context]
  );

  /**
   * Mark that the user started engaging with exposed content.
   * Call this when user clicks/expands.
   */
  const startEngagement = useCallback((exposedId: string) => {
    const tracked = trackedExposures.current.get(exposedId);
    if (tracked) {
      tracked.engageStartTime = Date.now();
    }
  }, []);

  /**
   * Mark exposure as engaged with duration.
   * Call this when user closes/collapses or navigates away.
   */
  const markEngaged = useCallback(
    async (exposedIdOrExposureId: string, engagementMs?: number): Promise<boolean> => {
      // Try to find by exposedId first
      let exposureId = exposedIdOrExposureId;
      const tracked = trackedExposures.current.get(exposedIdOrExposureId);

      if (tracked) {
        exposureId = tracked.exposureId;

        // Auto-calculate duration if not provided
        if (engagementMs === undefined && tracked.engageStartTime) {
          engagementMs = Date.now() - tracked.engageStartTime;
        }
      }

      try {
        const response = await fetch('/api/analytics/exposure', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exposureId,
            engagementMs,
          }),
        });

        return response.ok;
      } catch (error) {
        console.error('Error marking engagement:', error);
        return false;
      }
    },
    []
  );

  /**
   * Get the exposure ID for a given exposed content ID.
   */
  const getExposureId = useCallback((exposedId: string): string | null => {
    return trackedExposures.current.get(exposedId)?.exposureId ?? null;
  }, []);

  return {
    logExposure,
    logMultipleExposures,
    startEngagement,
    markEngaged,
    getExposureId,
  };
}
