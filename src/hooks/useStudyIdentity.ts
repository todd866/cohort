'use client';

import { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';

export interface StudyIdentity {
  /** Safe to issue study requests. False only while an identity is being established. */
  ready: boolean;
  /** Bootstrap was attempted and did not succeed. Render a signed-out state, not a spinner. */
  identityFailed: boolean;
}

/**
 * Guarantee the caller has a study identity before anything fetches.
 *
 * md3.info never minted a guest. Only three routes could, all on the cohort.md
 * path, and no page called them — so an anonymous visitor held no cookie, every
 * study endpoint answered 401 "load the app first to establish a session", and
 * the review page sat on its skeleton indefinitely. Loading the app was itself
 * the thing that failed to establish the session.
 *
 * The identity has to be minted by a Route Handler: Server Components cannot
 * set cookies in Next.js, so the page render physically cannot do it. Hence a
 * client gate that runs BEFORE the first study fetch — establishing the identity
 * so the 401 never occurs, rather than catching it afterwards.
 *
 * A signed-in visitor is ready immediately and issues no request; adding a round
 * trip to their critical path would be a real regression for the common case.
 */
export function useStudyIdentity(): StudyIdentity {
  const { status } = useSession();
  const [ready, setReady] = useState(false);
  const [identityFailed, setIdentityFailed] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (status === 'authenticated') {
      setReady(true);
      return;
    }
    // 'loading' is not yet an answer — bootstrapping here could mint a guest for
    // someone who turns out to be signed in.
    if (status !== 'unauthenticated' || startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/session/bootstrap', { cache: 'no-store' });
        if (cancelled) return;
        // A refusal is usually the guest-creation rate limit. Release the gate
        // either way: a visitor must never be held on a skeleton by this hook.
        if (!res.ok) setIdentityFailed(true);
      } catch {
        if (!cancelled) setIdentityFailed(true);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, [status]);

  return { ready, identityFailed };
}
