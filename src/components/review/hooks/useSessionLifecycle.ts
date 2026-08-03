/**
 * useSessionLifecycle — records one lifecycle session per visible review
 * interval and exposes the current interval's sessionId to target-crossed
 * analytics.
 *
 * Why client-side rather than server-inferred: the server can guess
 * sessions from event-sequence gaps but the boundary is fuzzy. The
 * client knows exactly when an interval begins (mount/visible) and ends
 * (hidden, unmount, refresh, or tab-close). A return from hidden starts a
 * fresh ID; reusing the ended ID would create activity after its end marker.
 *
 * session_ended is delivered via sendBeacon so it survives navigation /
 * tab-close — a regular fetch in unmount cleanup races browser teardown
 * and frequently never lands.
 */

import { useEffect, useRef, useState } from 'react';

export interface UseSessionLifecycleOptions {
  /** Skip best-effort analytics in the credentialless offline shell. */
  disabled?: boolean;
  rotation?: string;
  /** Metadata stamped on session_started (target, todayReviewed, etc.). */
  startMetadata?: Record<string, unknown>;
  /** Function returning current session stats — called at unmount for end metadata. */
  getEndMetadata?: () => Record<string, unknown>;
}

export interface UseSessionLifecycleReturn {
  /** UUID for the current visible interval. Changes after a hidden→visible resume. */
  sessionId: string;
}

const SESSION_EVENT_URL = '/api/study/session-event';

function genSessionId(): string {
  // crypto.randomUUID is in all modern browsers; fall back for very old envs.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function useSessionLifecycle({
  disabled = false,
  rotation,
  startMetadata,
  getEndMetadata,
}: UseSessionLifecycleOptions = {}): UseSessionLifecycleReturn {
  // The first ID is generated during lazy state initialisation. Resumes replace
  // it with a fresh ID while preserving a synchronous value for consumers.
  const [sessionId, setSessionId] = useState(genSessionId);
  const initialSessionIdRef = useRef(sessionId);
  const initialSessionUsedRef = useRef(false);
  const activeSessionRef = useRef<{ id: string; startedAt: number } | null>(null);

  // Latest-value refs let the listener effect stay mounted while props change.
  const rotationRef = useRef(rotation);
  const startMetadataRef = useRef(startMetadata);
  const getEndMetadataRef = useRef(getEndMetadata);
  useEffect(() => {
    rotationRef.current = rotation;
    startMetadataRef.current = startMetadata;
    getEndMetadataRef.current = getEndMetadata;
  });

  useEffect(() => {
    if (disabled) return;

    const startVisibleInterval = () => {
      if (activeSessionRef.current || document.visibilityState === 'hidden') return;

      const isResume = initialSessionUsedRef.current;
      const id = isResume ? genSessionId() : initialSessionIdRef.current;
      initialSessionUsedRef.current = true;
      activeSessionRef.current = { id, startedAt: Date.now() };
      setSessionId(id);

      const startBody = JSON.stringify({
        sessionId: id,
        eventType: 'session_started',
        rotation: rotationRef.current,
        metadata: {
          ...startMetadataRef.current,
          lifecycleResume: isResume,
        },
      });
      fetch(SESSION_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: startBody,
        keepalive: true,
      }).catch(() => {
        // Best-effort analytics; never block the review session.
      });
    };

    const sendEndEvent = (endReason: 'visibility_hidden' | 'pagehide' | 'unmount') => {
      const active = activeSessionRef.current;
      if (!active) return;
      // Clear before transport so visibility/pagehide/unmount races are one-shot.
      activeSessionRef.current = null;

      const durationMs = Math.max(0, Date.now() - active.startedAt);
      const endMeta = getEndMetadataRef.current?.() ?? {};
      const endBody = JSON.stringify({
        sessionId: active.id,
        eventType: 'session_ended',
        rotation: rotationRef.current,
        metadata: { ...endMeta, durationMs, endReason },
      });

      try {
        if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
          const blob = new Blob([endBody], { type: 'application/json' });
          if (navigator.sendBeacon(SESSION_EVENT_URL, blob)) return;
        }
      } catch {
        // Fall through to fetch.
      }
      fetch(SESSION_EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: endBody,
        keepalive: true,
      }).catch(() => {
        // Best-effort.
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        sendEndEvent('visibility_hidden');
      } else if (document.visibilityState === 'visible') {
        startVisibleInterval();
      }
    };
    const handlePageHide = () => sendEndEvent('pagehide');
    const handlePageShow = () => startVisibleInterval();

    startVisibleInterval();
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('pageshow', handlePageShow);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('pageshow', handlePageShow);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      sendEndEvent('unmount');
    };
  }, [disabled]);

  return { sessionId };
}
