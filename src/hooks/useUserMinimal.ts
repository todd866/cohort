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

  const shouldFetch = status === 'authenticated';

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
