import { useEffect, useRef, useState } from 'react';
import type { TopicReadinessSummary } from '@/lib/knowledge/topic-heat';
import {
  fetchWithDeadline,
  REVIEW_CONTEXT_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

/** Load the lightweight readiness summary once, when the drawer first opens. */
export function useTopicReadiness(
  open: boolean,
  rotation: string | null,
): TopicReadinessSummary | null {
  const [summary, setSummary] = useState<TopicReadinessSummary | null>(null);
  const loadedRotation = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !rotation || loadedRotation.current === rotation) return;
    let cancelled = false;

    fetchWithDeadline(
      `/api/study/topic-readiness?rotation=${encodeURIComponent(rotation)}`,
      {},
      REVIEW_CONTEXT_FETCH_DEADLINE_MS,
    )
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to fetch (${response.status})`);
        return response.json() as Promise<TopicReadinessSummary>;
      })
      .then((next) => {
        if (cancelled || next.rotation !== rotation) return;
        loadedRotation.current = rotation;
        setSummary(next);
      })
      .catch(() => {
        // Readiness is supporting context. Keep the already-rendered progress
        // drawer usable when auth expires or the background read times out.
      });

    return () => {
      cancelled = true;
    };
  }, [open, rotation]);

  return summary?.rotation === rotation ? summary : null;
}
