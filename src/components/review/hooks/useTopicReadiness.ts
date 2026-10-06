import { useEffect, useRef, useState } from 'react';
import type { TopicReadinessSummary } from '@/lib/knowledge/topic-heat';
import {
  fetchWithDeadline,
  REVIEW_CONTEXT_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

/**
 * Prefetch the lightweight readiness summary as soon as the rotation is known.
 *
 * `open` stays in the signature because the drawer passes it, but the fetch
 * is not gated on it. Waiting for the drawer to open painted a coverage bar
 * and then swapped it for this summary. One success is cached per rotation.
 * A failure stays silent so the drawer can keep the placeholder counts.
 */
export function useTopicReadiness(
  open: boolean,
  rotation: string | null,
): TopicReadinessSummary | null {
  const [summary, setSummary] = useState<TopicReadinessSummary | null>(null);
  const loadedRotation = useRef<string | null>(null);
  void open;

  useEffect(() => {
    if (!rotation || loadedRotation.current === rotation) return;
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
  }, [rotation]);

  return summary?.rotation === rotation ? summary : null;
}
