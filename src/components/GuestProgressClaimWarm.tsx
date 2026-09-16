'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';
import {
  GUEST_CLAIM_REQUEST_DEADLINE_MS,
  GUEST_CLAIM_RETRY_MS,
  GUEST_CLAIM_START_DEFER_MS,
  interpretGuestClaimResponse,
  reportGuestClaimClientOutcome,
  shouldScheduleGuestClaimAutoRetry,
} from '@/lib/guest-progress-claim-client';

type ClaimUiState = 'idle' | 'working' | 'retrying' | 'imported';

export {
  GUEST_CLAIM_START_DEFER_MS,
} from '@/lib/guest-progress-claim-client';

/**
 * Durable, visible retry for the bounded guest-progress claim.
 *
 * The sign-in callback still gets one short attempt so the common case is
 * complete before redirect. If it times out, the HttpOnly guest cookie remains
 * and this component retries after the authenticated app has painted — deferred
 * so it does not contend with the first unified-session / cache-refresh on Neon.
 *
 * Terminal `not-eligible` responses (including stale guest-missing cookies) stop
 * the loop. Auto-retries are capped so a Neon outage cannot nag every minute.
 */
interface GuestProgressClaimWarmProps {
  /**
   * Whether the server saw a guest cookie when it rendered this document.
   * Defaults to true so an omitted prop keeps the recovery path.
   */
  claimPending?: boolean;
}

export function GuestProgressClaimWarm({
  claimPending = true,
}: GuestProgressClaimWarmProps) {
  const { data: session, status } = useSession();
  const [uiState, setUiState] = useState<ClaimUiState>('idle');
  const runningRef = useRef(false);
  // The server flag is frozen at render time, but App Router client navigations
  // reuse the root layout, so a long-lived tab can hold `false` while the same
  // browser later signs out, studies as a guest, and signs back in elsewhere.
  // Observing that transition here re-arms the claim without a periodic no-op
  // POST — the thing that produced a warning banner when nothing was wrong.
  const signedInHereRef = useRef(false);
  const prevStatusRef = useRef<string | null>(null);
  const needsRetryRef = useRef(false);
  const autoRetryCountRef = useRef(0);
  const retryRef = useRef<number | null>(null);
  const revealRef = useRef<number | null>(null);
  const deferRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    if (revealRef.current !== null) window.clearTimeout(revealRef.current);
    if (deferRef.current !== null) window.clearTimeout(deferRef.current);
    retryRef.current = null;
    revealRef.current = null;
    deferRef.current = null;
  }, []);

  const attempt = useCallback(async (opts?: { manual?: boolean }) => {
    if (status !== 'authenticated' || !session?.user?.id || runningRef.current) return;
    runningRef.current = true;
    clearTimers();
    // Reveal "working" only on an attempt the learner could be waiting on: the
    // first one, or one they asked for. An automatic retry that reveals turns a
    // 15s deadline into another 14.5s banner, so three silent retries would
    // still surface three unexplained banners over ~3 minutes — the very noise
    // this is meant to remove.
    if (autoRetryCountRef.current === 0 || opts?.manual) {
      revealRef.current = window.setTimeout(() => setUiState('working'), 500);
    }

    try {
      const response = await fetchWithDeadline(
        '/api/auth/claim-guest-progress',
        { method: 'POST', cache: 'no-store' },
        GUEST_CLAIM_REQUEST_DEADLINE_MS,
      );
      const body = await response.json().catch(() => ({})) as { status?: string };
      const outcome = interpretGuestClaimResponse({
        ok: response.ok,
        status: body.status,
      });

      clearTimers();
      if (outcome.kind === 'imported') {
        needsRetryRef.current = false;
        autoRetryCountRef.current = 0;
        setUiState('imported');
        retryRef.current = window.setTimeout(() => setUiState('idle'), 4_000);
        return;
      }
      if (outcome.kind === 'done') {
        needsRetryRef.current = false;
        autoRetryCountRef.current = 0;
        setUiState('idle');
        return;
      }

      reportGuestClaimClientOutcome({
        outcome: 'retryable_http',
        autoRetryCount: autoRetryCountRef.current,
        error: body.status ?? `HTTP ${response.status}`,
      });
      needsRetryRef.current = true;
      if (!opts?.manual && shouldScheduleGuestClaimAutoRetry(autoRetryCountRef.current)) {
        // A single transport failure is usually a slow no-op response that the
        // server still completes. Recover quietly before asking the learner to
        // intervene; their history remains under the trusted guest cookie.
        setUiState('idle');
        autoRetryCountRef.current += 1;
        retryRef.current = window.setTimeout(() => {
          runningRef.current = false;
          void attempt();
        }, GUEST_CLAIM_RETRY_MS);
      } else {
        setUiState('retrying');
      }
    } catch (error) {
      clearTimers();
      reportGuestClaimClientOutcome({
        outcome: 'client_timeout',
        autoRetryCount: autoRetryCountRef.current,
        error: error instanceof Error ? error.message : String(error),
      });
      needsRetryRef.current = true;
      if (!opts?.manual && shouldScheduleGuestClaimAutoRetry(autoRetryCountRef.current)) {
        setUiState('idle');
        autoRetryCountRef.current += 1;
        retryRef.current = window.setTimeout(() => {
          runningRef.current = false;
          void attempt();
        }, GUEST_CLAIM_RETRY_MS);
      } else {
        // Automatic recovery is exhausted (or a requested retry failed), so
        // keep one honest, actionable notice instead of promising another
        // automatic attempt that will not happen.
        setUiState('retrying');
      }
      return;
    } finally {
      runningRef.current = false;
    }
  }, [clearTimers, session?.user?.id, status]);

  useEffect(() => {
    // Deliberately computed HERE rather than in its own effect: this is the only
    // reader, and splitting them would make the whole recovery path depend on
    // React running two effects in declaration order — silent to break, and
    // invisible to a test that exercises the transition rather than the order.
    const previousStatus = prevStatusRef.current;
    prevStatusRef.current = status;
    // Only a genuine unauthenticated -> authenticated flip counts. The ordinary
    // loading -> authenticated settle on every page load must not, or this
    // becomes the per-load no-op request all over again.
    if (previousStatus === 'unauthenticated' && status === 'authenticated') {
      signedInHereRef.current = true;
    }

    if (status !== 'authenticated' || !session?.user?.id) {
      clearTimers();
      setUiState('idle');
      needsRetryRef.current = false;
      autoRetryCountRef.current = 0;
      return clearTimers;
    }

    // Nothing to import and no sign-in seen in this tab: stay completely silent.
    // No request means no cold-start timeout, and so no banner on the overwhelming
    // majority of loads, where there was never anything to recover.
    if (!claimPending && !signedInHereRef.current) return clearTimers;

    // Defer the first POST so the review feed owns Neon during cold start.
    deferRef.current = window.setTimeout(() => {
      void attempt();
    }, GUEST_CLAIM_START_DEFER_MS);

    return clearTimers;
  }, [attempt, claimPending, clearTimers, session?.user?.id, status]);

  useEffect(() => {
    const retryNow = () => {
      if (
        !needsRetryRef.current
        || document.visibilityState === 'hidden'
        || navigator.onLine === false
      ) return;
      if (!shouldScheduleGuestClaimAutoRetry(autoRetryCountRef.current)) return;
      runningRef.current = false;
      void attempt();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', retryNow);
    return () => {
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', retryNow);
    };
  }, [attempt]);

  if (uiState === 'idle') return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 top-[max(0.75rem,env(safe-area-inset-top))] z-[120] mx-auto max-w-md rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] px-4 py-3 text-sm text-[var(--md-on-surface)] shadow-lg"
    >
      {uiState === 'working' && 'Finishing your progress import…'}
      {uiState === 'retrying' && (
        <span className="flex items-center justify-between gap-3">
          <span>Progress import is taking longer than expected. Your guest history is safe.</span>
          <button
            type="button"
            onClick={() => {
              runningRef.current = false;
              void attempt({ manual: true });
            }}
            className="min-h-11 shrink-0 rounded-lg px-3 font-medium text-[var(--md-primary)]"
          >
            Retry
          </button>
        </span>
      )}
      {uiState === 'imported' && 'Guest study progress imported.'}
    </div>
  );
}
