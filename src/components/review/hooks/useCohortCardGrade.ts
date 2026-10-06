import { useCallback, useEffect, useRef, useState } from 'react';

import { genClientRequestId } from '@/lib/client-request-id';
import { fetchWithDeadline } from '@/lib/fetch-with-deadline';

type GradeStatus = 'idle' | 'saving' | 'saved' | 'error';

const CARD_GRADE_DEADLINE_MS = 15_000;

/**
 * Grade a Cohort module card and WAIT for the server before moving on.
 *
 * md3's useGrading advances optimistically, which is right on a feed it
 * prefetched. On Cohort the next turn is chosen after this one is answered:
 * the server refuses to continue past an ungraded delivery, so moving on
 * before the grade landed would ask for a turn it must refuse. The grade
 * buttons stay disabled while saving, and a retry of the same grade reuses its
 * request id, so the server's idempotent review never double-counts it.
 */
export function useCohortCardGrade({
  deliveryId,
  getResponseTimeMs,
  onGraded,
  onError,
}: {
  deliveryId: string | null | undefined;
  getResponseTimeMs?: () => number;
  onGraded?: (confidence: number) => void;
  onError?: (message: string) => void;
}) {
  // State is keyed to the delivery it belongs to: a new delivery reads as idle
  // without an effect, and a late reply for an old one changes nothing visible.
  const [state, setState] = useState<{ deliveryId: string | null | undefined; status: GradeStatus; selected: number | null }>(
    { deliveryId, status: 'idle', selected: null },
  );
  const current = state.deliveryId === deliveryId ? state : { deliveryId, status: 'idle' as GradeStatus, selected: null };
  const statusRef = useRef<{ deliveryId: string | null | undefined; status: GradeStatus }>({ deliveryId, status: 'idle' });
  const deliveryIdRef = useRef(deliveryId);
  deliveryIdRef.current = deliveryId;
  const mountedRef = useRef(true);
  const requestRef = useRef<{ deliveryId: string; confidence: number; id: string; responseTimeMs?: number } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reset = useCallback(() => {
    statusRef.current = { deliveryId, status: 'idle' };
    requestRef.current = null;
    setState({ deliveryId, status: 'idle', selected: null });
  }, [deliveryId]);

  const grade = useCallback((confidence: number) => {
    if (!deliveryId) return;
    const prior = statusRef.current;
    if (prior.deliveryId === deliveryId && (prior.status === 'saving' || prior.status === 'saved')) return;
    const priorRequest = requestRef.current;
    const clientRequestId = priorRequest && priorRequest.deliveryId === deliveryId && priorRequest.confidence === confidence
      ? priorRequest.id
      : genClientRequestId();
    const priorIsSameGrade = priorRequest
      && priorRequest.deliveryId === deliveryId
      && priorRequest.confidence === confidence;
    const measuredResponseTimeMs = priorIsSameGrade
      ? priorRequest.responseTimeMs
      : getResponseTimeMs?.();
    const responseTimeMs = measuredResponseTimeMs != null
      && Number.isFinite(measuredResponseTimeMs)
      && measuredResponseTimeMs >= 0
      ? Math.round(measuredResponseTimeMs)
      : undefined;
    requestRef.current = { deliveryId, confidence, id: clientRequestId, ...(responseTimeMs != null ? { responseTimeMs } : {}) };
    const activeRequest = requestRef.current;
    const settle = (status: GradeStatus) => {
      statusRef.current = { deliveryId, status };
      setState({ deliveryId, status, selected: confidence });
    };
    settle('saving');

    const body = {
      deliveryId,
      confidence,
      clientRequestId,
      ...(responseTimeMs != null
        ? { responseTimeMs }
        : {}),
    };
    void fetchWithDeadline('/api/cohort/card-grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, CARD_GRADE_DEADLINE_MS)
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error ?? `Grade not saved (${response.status})`);
        }
        if (!mountedRef.current || deliveryIdRef.current !== deliveryId || requestRef.current !== activeRequest) return;
        settle('saved');
        onGraded?.(confidence);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || deliveryIdRef.current !== deliveryId || requestRef.current !== activeRequest) return;
        settle('error');
        onError?.(error instanceof Error ? error.message : 'Grade not saved');
      });
  }, [deliveryId, getResponseTimeMs, onError, onGraded]);

  return { grade, selected: current.selected, status: current.status, reset };
}
