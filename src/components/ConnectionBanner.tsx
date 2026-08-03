'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { bindOfflineOwner } from '@/lib/offline/device-state';
import { offlineUserKey } from '@/lib/offline/pack';
import { readOfflineOwner } from '@/lib/offline/owner';
import { flushReviewQueue } from '@/lib/review-queue';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

const DISMISS_KEY = 'md3:offline-notice-dismissed';

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function storeDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // The in-memory state still dismisses the notice for this page lifetime.
  }
}

function clearDismissed(): void {
  try {
    window.sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    // Storage can be unavailable in private browsing; state still resets.
  }
}

export function ConnectionBanner() {
  const { data: session, status: sessionStatus } = useSession();
  const userKey = sessionStatus === 'authenticated'
    ? offlineUserKey(session?.user)
    : null;
  const [offline, setOffline] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !window.navigator.onLine;
  });
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined' || window.navigator.onLine) return false;
    return readDismissed();
  });

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
          if (
            provedOwnerKey !== owner.ownerKey
            || !currentOwner?.verified
            || currentOwner.ownerKey !== owner.ownerKey
            || currentOwner.generation !== owner.generation
          ) {
            return;
          }
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

    const goOffline = () => setOffline(true);
    const goOnline = () => {
      setOffline(false);
      setDismissed(false);
      clearDismissed();
      // A visibility/online callback may close over a session from before
      // another tab changed accounts. Never let it rebind device ownership.
      flushAlreadyBoundOwner();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') flushAlreadyBoundOwner();
    };

    // Do not let an old episode's dismissal suppress a later drop in signal.
    if (window.navigator.onLine) clearDismissed();

    // Flush on mount (covers app reload after magic-link re-login).
    bindResolvedSessionAndFlush();

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionStatus, userKey]);

  const dismiss = () => {
    storeDismissed();
    setDismissed(true);
  };

  if (!offline || dismissed) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] bg-[var(--md-tertiary-container)] pt-[env(safe-area-inset-top)] text-[var(--md-on-tertiary-container)]"
    >
      <div className="mx-auto flex min-h-11 max-w-3xl items-center gap-2 pl-4 text-sm">
        <span role="status" className="flex-1 text-center">
          Offline — answers will sync when connected.
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss offline notice"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl leading-none hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-current dark:hover:bg-white/10"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
