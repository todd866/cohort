'use client';

import { FlagImageDeliveryNotice } from '@/components/content/FlagImageDeliveryNotice';
import { ConnectionIndicator } from '@/components/offline/ConnectionIndicator';
import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { bindOfflineOwner } from '@/lib/offline/device-state';
import { offlineUserKey } from '@/lib/offline/pack';
import { quarantineOfflineOwner, readOfflineOwner, setTabSessionOwnerKey } from '@/lib/offline/owner';
import { flushReviewQueue } from '@/lib/review-queue';
import { getQueueSize, subscribeOutbox } from '@/lib/outbox';
import { createOutboxRetry } from '@/lib/offline/outbox-retry';
import { recordOffline, recordOnline } from '@/lib/offline/connectivity-log';
import { getLinkState, subscribeLinkState } from '@/lib/offline/connectivity';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

/**
 * Owns the outbox replay for every page, and renders the connection
 * indicator only as a last resort. Reported 12 Oct 2026 as infuriating when it
 * was a full-width bar, and 15 Oct 2026 as "two banners??" when its floating
 * pill sat over the review toolbar beside the offline page's own row. The
 * indicator now lives in a slot of the review toolbar or the main navigation
 * (ConnectionIndicator); this floating copy shows only on pages with neither.
 */
export { OFFLINE_SHOW_AFTER_MS, QUEUED_SHOW_AFTER_MS } from '@/components/offline/ConnectionIndicator';

export function ConnectionBanner({ offlineMessage }: {
  /** Detail line for a surface with no saved review, e.g. the textbook reader. */
  offlineMessage?: string;
} = {}) {
  const { data: session, status: sessionStatus } = useSession();
  const userKey = sessionStatus === 'authenticated'
    ? offlineUserKey(session?.user)
    : null;
  // Tell captureOfflineOwner() which account THIS tab shows (see owner.ts).
  // Assigned during render, not in an effect, so it is set before any grade.
  if (sessionStatus !== 'loading') setTabSessionOwnerKey(userKey);

  useEffect(() => {
    let verifiedOwnerProof: Promise<void> | null = null;

    const proveVerifiedOwnerAndFlush = (
      owner: { ownerKey: string; generation: number },
    ): Promise<void> => {
      if (!window.navigator.onLine) return Promise.resolve();
      if (verifiedOwnerProof) return verifiedOwnerProof;

      verifiedOwnerProof = fetchWithDeadline(
        '/api/auth/session',
        {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        },
        CLIENT_FETCH_DEADLINE_MS,
      )
        .then(async (response) => {
          if (!response.ok) return;
          const payload = await response.json() as {
            user?: { id?: string | null; email?: string | null } | null;
          };
          const provedOwnerKey = offlineUserKey(payload.user);
          const currentOwner = readOfflineOwner();
          const stillOwnsProof = currentOwner?.verified
            && currentOwner.ownerKey === owner.ownerKey
            && currentOwner.generation === owner.generation;
          if (!provedOwnerKey) {
            if (stillOwnsProof) quarantineOfflineOwner();
            return;
          }
          if (
            provedOwnerKey !== owner.ownerKey
            || !currentOwner?.verified
            || currentOwner.ownerKey !== owner.ownerKey
            || currentOwner.generation !== owner.generation
          ) {
            if (stillOwnsProof) quarantineOfflineOwner();
            return;
          }
          // Matching proof releases a same-owner quarantine and advances the
          // lease before any queued plaintext is replayed.
          bindOfflineOwner(owner.ownerKey);
          await flushReviewQueue(owner.ownerKey);
        })
        .catch(() => {
          // A failed proof leaves the verified-owner queue untouched. The live
          // navigation/next visibility event can safely try again.
        })
        .finally(() => {
          verifiedOwnerProof = null;
        });

      return verifiedOwnerProof;
    };

    const flushAlreadyBoundOwner = (): void => {
      // Do not guess an owner before next-auth has resolved the current session.
      if (sessionStatus === 'loading') return;

      if (sessionStatus === 'authenticated') {
        if (!userKey) return;
        const current = readOfflineOwner();
        if (current?.verified && current.ownerKey !== userKey) {
          // A positive identity mismatch invalidates the old partition. Keep it
          // inaccessible until its own identity is proved again.
          quarantineOfflineOwner();
          return;
        }
        const owner = readOfflineOwner();
        if (
          !owner?.verified
          || owner.ownerKey !== userKey
        ) {
          return;
        }
        flushReviewQueue(userKey).catch(() => {});
        return;
      }

      const owner = readOfflineOwner();
      if (owner?.verified) {
        // The cached shell is intentionally credentialless, so next-auth stays
        // `unauthenticated` even after the radio returns. Re-prove the current
        // cookie session before explicitly replaying this verified partition;
        // the local owner key alone is never authentication.
        void proveVerifiedOwnerAndFlush(owner);
      } else {
        // A signed-out/offline guest may still have writes bound to the
        // device's stored guest owner. The outbox resolves that owner itself.
        flushReviewQueue().catch(() => {});
      }
    };

    const bindResolvedSessionAndFlush = () => {
      if (sessionStatus === 'loading') return;
      if (sessionStatus === 'authenticated') {
        if (!userKey) return;
        bindOfflineOwner(userKey);
        flushReviewQueue(userKey).catch(() => {});
        return;
      }
      flushAlreadyBoundOwner();
    };

    const goOffline = () => {
      recordOffline(Date.now());
    };
    // Retry a non-empty queue on a timer: on patchy signal navigator.onLine
    // stays true, no 'online' event fires, and the queue otherwise waits for
    // the app to be backgrounded and reopened (outbox-retry.ts).
    const retry = createOutboxRetry({
      size: () => getQueueSize('review'),
      flush: async () => flushAlreadyBoundOwner(),
      visible: () => document.visibilityState === 'visible',
    });
    const unsubscribeRetry = subscribeOutbox(() => retry.poke());
    const goOnline = () => {
      recordOnline(Date.now());
      // A visibility/online callback may close over a session from before
      // another tab changed accounts. Never let it rebind device ownership.
      flushAlreadyBoundOwner();
      retry.poke();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        flushAlreadyBoundOwner();
        retry.poke();
      }
    };
    // A weak link recovers without any browser 'online' event: replay as soon
    // as requests get through again, not on the outbox's next backoff step.
    let lastLink = getLinkState();
    const unsubscribeLink = subscribeLinkState(() => {
      const link = getLinkState();
      const recovered = link === 'online' && lastLink !== 'online';
      lastLink = link;
      if (recovered) {
        flushAlreadyBoundOwner();
        retry.poke();
      }
    });

    // Flush on mount (covers app reload after magic-link re-login).
    bindResolvedSessionAndFlush();
    retry.poke();

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribeLink();
      retry.stop();
      unsubscribeRetry();
    };
  }, [sessionStatus, userKey]);

  return (
    <>
      <FlagImageDeliveryNotice />
      <ConnectionIndicator host="floating" offlineMessage={offlineMessage} />
    </>
  );
}
