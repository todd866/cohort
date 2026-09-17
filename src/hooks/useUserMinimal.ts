'use client';

import useSWR from 'swr';
import { useSession } from 'next-auth/react';
import {
  fetchWithDeadline,
  REVIEW_CONTEXT_FETCH_DEADLINE_MS,
} from '@/lib/fetch-with-deadline';

export interface MinimalUserData {
  institution: string | null;
  track: number | null;
  enabledModules: string[];
  activeModules: string[];
  reviewTopicRotations?: Record<string, string>;
  /** True once the learner has described a course md3 does not cover. */
  curriculumRequested?: boolean;
}

const fetcher = async (url: string): Promise<MinimalUserData> => {
  const res = await fetchWithDeadline(url, {}, REVIEW_CONTEXT_FETCH_DEADLINE_MS);
  if (!res.ok) throw new Error(`Failed to load user context (${res.status})`);
  return res.json();
};

/**
 * Shared hook for minimal user data with SWR caching.
 * Both useInstitution and useUserTrack use this to avoid duplicate fetches.
 */
export function useUserMinimal() {
  const { status } = useSession();

  // Fetch for guests too, not just authenticated users. A guest can choose a
  // rotation before signing up, and this is the read that tells the review page
  // the choice was saved — gating on 'authenticated' meant the answer never came
  // back and the chooser re-opened on every load (2026-08-23). The route returns
  // an empty context rather than a 401 when there is no identity at all, so an
  // anonymous first paint costs one small request and no error.
  const shouldFetch = status !== 'loading';

  const { data, error, isLoading, mutate } = useSWR<MinimalUserData>(
    shouldFetch ? '/api/user/minimal' : null,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000, // 1 minute deduplication
      shouldRetryOnError: false,
    }
  );

  return {
    data,
    error,
    isLoading: status === 'loading' || (shouldFetch && isLoading),
    isAuthenticated: status === 'authenticated',
    mutate,
  };
}
