import { useState, useCallback, useRef, useEffect } from 'react';
import { submitWithRetry } from '@/lib/submit-with-retry';
import { acknowledgeReview, enqueueReview } from '@/lib/review-queue';
import { genClientRequestId } from '@/lib/client-request-id';
import { isRetriableWriteStatus } from '@/lib/write-retry-policy';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from '@/lib/offline/owner';
import { captureReviewWriteClientContext } from '@/lib/review/review-write-observability';

type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

/** Maps user-facing confidence 1-4 to scheduler quality 0-5 */
const CONFIDENCE_TO_QUALITY: Record<number, number> = {
  1: 0,  // Again
  2: 1,  // Hard
  3: 3,  // Good
  4: 5,  // Easy
};

export { CONFIDENCE_TO_QUALITY };

export interface UseGradingOptions {
  itemId: string;
  itemType: 'card' | 'question' | 'video';
  metadata?: Record<string, unknown>;
  getResponseTimeMs?: () => number;
  onGraded?: (confidence: number) => void;
  onError?: (message: string) => void;
  /** Walk-audit traceability — echoed back to POST /api/study/record */
  sessionId?: string | null;
  batchId?: string | null;
  /** Per-item serve-decision trace ID — echoed back to POST /api/study/record */
  serveDecisionId?: string;
}

export interface UseGradingReturn {
  grade: (confidence: number) => void;
  selected: number | null;
  status: SaveState;
  reset: () => void;
}

export function useGrading({
  itemId,
  itemType,
  metadata,
  getResponseTimeMs,
  onGraded,
  onError,
  sessionId,
  batchId,
  serveDecisionId,
}: UseGradingOptions): UseGradingReturn {
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<SaveState>('idle');

  // Track current itemId via ref so async callbacks can detect stale responses.
  // When the item changes (itemId prop updates), the ref updates immediately,
  // and any in-flight API response can compare its captured ID against the ref
  // to detect that the user has already moved on.
  const itemIdRef = useRef(itemId);
  useEffect(() => {
    itemIdRef.current = itemId;
  }, [itemId]);

  const grade = useCallback((confidence: number) => {
    if (status === 'saving' || status === 'saved' || status === 'queued') return;

    const ownerLease = captureOfflineOwner();
    const gradingItemId = itemIdRef.current; // capture at grade-time
    setSelected(confidence);
    setStatus('saving');

    const quality = CONFIDENCE_TO_QUALITY[confidence] ?? confidence;
    const clientRequestId = genClientRequestId();

    let url: string;
    let body: Record<string, unknown>;

    if (itemType === 'question') {
      url = '/api/questions/confidence';
      body = { questionId: itemId, confidence, clientRequestId };
    } else {
      url = '/api/study/record';
      // Stable idempotency key so an outbox replay / lost-ack retry of this grade
      // is deduped server-side instead of double-counting the attempt.
      body = { type: itemType, id: itemId, quality, clientRequestId };
      if (itemType === 'card') {
        Object.assign(body, captureReviewWriteClientContext());
      }
      const responseTimeMs = getResponseTimeMs?.();
      if (responseTimeMs != null) body.responseTimeMs = responseTimeMs;
      if (metadata) body.metadata = metadata;
      if (sessionId != null) body.sessionId = sessionId;
      if (batchId != null) body.batchId = batchId;
      if (serveDecisionId != null) body.serveDecisionId = serveDecisionId;
    }

    // Persist synchronously before transport. navigator.onLine can remain true
    // behind a dead radio/captive network, and a suspended PWA may never finish
    // retries. A late 2xx removes this exact idempotent row.
    enqueueReview(url, body, ownerLease.ownerKey);

    // Advance immediately without waiting for the API round-trip, but only
    // after the synchronous durable write. A callback error or abrupt page
    // suspension can no longer strand an answer that already left the screen.
    onGraded?.(confidence);

    submitWithRetry(url, body, { ownerLease })
      .then((res) => {
        // An account switch invalidates the whole local continuation. The
        // request may already have reached the server, but its response must
        // never update or enqueue work under the next signed-in account.
        if (!isOfflineOwnerCurrent(ownerLease)) return;

        const isStale = gradingItemId !== itemIdRef.current;
        if (res.ok) {
          acknowledgeReview(url, clientRequestId, ownerLease.ownerKey);
        }

        if (!res.ok) {
          if (res.status === 401) {
            // Auth failure — grade will be queued, report for monitoring
            try {
              navigator.sendBeacon(
                '/api/log/client-error',
                JSON.stringify({
                  url,
                  error: 'grade-auth-failure',
                  status: 401,
                  itemType,
                  ts: Date.now(),
                }),
              );
            } catch {}
          }
          if (isRetriableWriteStatus(res.status)) {
            // Durability is independent of whether the UI has advanced. A
            // resolved 5xx/429/auth response still represents an unsaved grade.
            if (isStale) return;
            setStatus('queued');
          } else {
            // A 400 can be a short old-client/new-server schema window during
            // a deploy. Preserve the grade in the bounded review outbox; after
            // its compatibility budget is exhausted the outbox reports and
            // drops the poison entry rather than retrying forever.
            try {
              navigator.sendBeacon(
                '/api/log/client-error',
                JSON.stringify({
                  url,
                  error: 'grade-deferred',
                  status: res.status,
                  itemType,
                  ts: Date.now(),
                }),
              );
            } catch {}
            if (isStale) return;
            setStatus('queued');
            onError?.(`HTTP ${res.status}`);
          }
          return;
        }

        // The item may have advanced while this successful write was in
        // flight. Do not let the old response overwrite the new item's state.
        if (isStale) return;
        setStatus('saved');
      })
      .catch((err) => {
        if (!isOfflineOwnerCurrent(ownerLease)) return;

        // Same stale-item guard for network errors / offline queueing
        if (gradingItemId !== itemIdRef.current) {
          // The write-ahead row already preserves the stale item's grade.
          return;
        }

        setStatus('queued');
        onError?.(String(err));
      });
  }, [status, itemId, itemType, metadata, getResponseTimeMs, onGraded, onError, sessionId, batchId, serveDecisionId]);

  const reset = useCallback(() => {
    setSelected(null);
    setStatus('idle');
  }, []);

  return { grade, selected, status, reset };
}
