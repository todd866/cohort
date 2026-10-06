'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname, useSearchParams } from 'next/navigation';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import type { CohortFeedProfile } from '@/lib/cohort/feed-profile';
import type { CohortSearchTopicV1 } from '@/lib/cohort/search-topic-contract';
import { parseCohortReviewIntent } from '@/lib/cohort/review-intent';
import { PublicReviewClient } from './PublicReviewClient';

export interface PublicReviewProfile {
  profile: CohortFeedProfile;
  deep: boolean;
  searchTopics: CohortSearchTopicV1[];
  demandTopics: {id: string; label: string}[];
}

/** Every public entry waits for one identity, then uses the same controller. */
export function PublicReviewEntry() {
  const {data: session, status} = useSession();
  if (status === 'loading') return <p role="status" className="p-6">Preparing review…</p>;
  return <IdentityReview key={session?.user?.id ?? 'guest'} />;
}

function IdentityReview() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [snapshot, setSnapshot] = useState<PublicReviewProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setError(null);
      // Establish the cookie before profile/turn requests run concurrently.
      const identity = await fetchWithDeadline('/api/session/bootstrap', {cache: 'no-store', signal: controller.signal}, CLIENT_FETCH_DEADLINE_MS);
      if (!identity.ok) throw new Error('Could not prepare your study session');
      const response = await fetchWithDeadline('/api/cohort/profile', {cache: 'no-store', signal: controller.signal}, CLIENT_FETCH_DEADLINE_MS);
      const body = await response.json();
      if (!response.ok || !body.profile || !Array.isArray(body.searchTopics)) throw new Error(body.error || 'Could not load your study profile');
      if (!controller.signal.aborted) setSnapshot(body);
    })().catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not prepare review'); });
    return () => controller.abort();
  }, [attempt]);
  if (!snapshot) return <main className="mx-auto max-w-2xl p-6">{error ? <><p role="alert">{error}</p><button className="mt-3 underline" onClick={() => setAttempt(value => value + 1)}>Retry</button></> : <p role="status">Preparing review…</p>}</main>;
  const intent = parseCohortReviewIntent(`${pathname}?${params.toString()}`, snapshot.searchTopics);
  if (!intent.valid) return <main className="p-6"><p role="alert">This module is not available.</p><Link href="/" className="underline">Choose a module</Link></main>;
  // Changing scope discards pending local state, never writes an old delivery
  // under a new module label, and ignores late responses on the old controller.
  return <PublicReviewClient key={intent.topicId ?? 'all'} topicId={intent.topicId} snapshot={snapshot} onProfile={setSnapshot} />;
}
