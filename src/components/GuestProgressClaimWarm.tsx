'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';

type ClaimUiState = 'idle' | 'working' | 'retrying' | 'imported';
const CLAIM_REQUEST_DEADLINE_MS = 7_000;
const CLAIM_RETRY_MS = 15_000;

/**
 * Durable, visible retry for the bounded guest-progress claim.
 *
 * The sign-in callback still gets one short attempt so the common case is
 * complete before redirect. If it times out, the HttpOnly guest cookie remains
 * and this component retries after the authenticated app has painted.
 */
export function GuestProgressClaimWarm() {
  const { data: session, status } = useSession();
  const [uiState, setUiState] = useState<ClaimUiState>('idle');
  const runningRef = useRef(false);
  const needsRetryRef = useRef(false);
  const retryRef = useRef<number | null>(null);
  const revealRef = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    if (revealRef.current !== null) window.clearTimeout(revealRef.current);
    retryRef.current = null;
    revealRef.current = null;
  }, []);

  const attempt = useCallback(async () => {
    if (status !== 'authenticated' || !session?.user?.id || runningRef.current) return;
    runningRef.current = true;
    clearTimers();
    revealRef.current = window.setTimeout(() => setUiState('working'), 500);

    try {
      const response = await fetchWithDeadline(
        '/api/auth/claim-guest-progress',
        { method: 'POST', cache: 'no-store' },
        CLAIM_REQUEST_DEADLINE_MS,
      );
      const body = await response.json().catch(() => ({})) as { status?: string };
      if (!response.ok) throw new Error(body.status ?? `HTTP ${response.status}`);

      clearTimers();
      needsRetryRef.current = false;
      if (body.status === 'claimed' || body.status === 'nothing-to-claim') {
        setUiState(body.status === 'claimed' ? 'imported' : 'idle');
        if (body.status === 'claimed') {
          retryRef.current = window.setTimeout(() => setUiState('idle'), 4_000);
        }
      } else {
        setUiState('idle');
      }
    } catch {
      clearTimers();
      needsRetryRef.current = true;
      setUiState('retrying');
      retryRef.current = window.setTimeout(() => {
        runningRef.current = false;
        void attempt();
      }, CLAIM_RETRY_MS);
      return;
    } finally {
      runningRef.current = false;
    }
  }, [clearTimers, session?.user?.id, status]);

  useEffect(() => {
    if (status === 'authenticated' && session?.user?.id) void attempt();
    if (status === 'unauthenticated') {
      clearTimers();
      setUiState('idle');
    }
    return clearTimers;
  }, [attempt, clearTimers, session?.user?.id, status]);

  useEffect(() => {
    const retryNow = () => {
      if (
        !needsRetryRef.current
        || document.visibilityState === 'hidden'
        || navigator.onLine === false
      ) return;
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
          <span>Progress import paused. Your guest history is safe and will retry.</span>
          <button
            type="button"
            onClick={() => {
              runningRef.current = false;
              void attempt();
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
