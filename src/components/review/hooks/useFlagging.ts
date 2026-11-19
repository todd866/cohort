'use client';

import { useFlagImage } from '@/components/content/FlagImageInput';
import { useState, useCallback, useEffect, useRef, type SetStateAction } from 'react';
import { queueFlag, type QueuedFlag } from '@/lib/flag-submit';
import type { ReviewFeedbackSubmissionStatus } from '@/lib/review/review-actions';
import { harvestFlagDiagnostics } from '@/lib/flag-diagnostics';
import type { PracticeReviewProvenance } from '@/lib/study/practice-review-focus';
import { genClientRequestId } from '@/lib/client-request-id';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

interface FlagItem {
  id: string;
  type: string;
  deliveryId?: string;
  answerSource?: 'practice-exam-follow-up';
  practiceReview?: PracticeReviewProvenance;
}

interface UseFlaggingOpts {
  /** The currently displayed item — used to address the flag submission. */
  item: FlagItem | undefined;
  /** Subscribe a reset callback to be called when the session advances to the next item. */
  registerResetCallback: (cb: () => void) => () => void;
  /** Cohort deliveries use the opaque delivery feedback endpoint. */
  publicSurface?: boolean;
}

/**
 * Owns the "F to flag" UI state: open the input, type a note (optional), submit, reset.
 * Submission is write-ahead: `queueFlag` puts the flag (and any image) in the durable
 * outbox, the input closes at once, and delivery runs in the background. Failures stay
 * queued and replay. The ✓ is shown only on confirmed delivery.
 */
export function useFlagging({ item, registerResetCallback, publicSurface = false }: UseFlaggingOpts) {
  const image = useFlagImage(`${item?.type}:${item?.deliveryId ?? item?.id}`);
  const [flagMode, setFlagMode] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const [flagPending, setFlagPending] = useState(false);
  const [flagMessage, setFlagMessage] = useState('');
  const [authExpired, setAuthExpired] = useState(false);
  const pendingRef = useRef(false);
  const publicPendingRef = useRef<{ deliveryId: string; clientRequestId: string; kind: 'flag'; reason: 'Other'; message?: string } | null>(null);
  const publicGenerationRef = useRef(0);
  const [submissionGeneration, setSubmissionGeneration] = useState(0);
  const submissionGenerationRef = useRef(0);
  const flagMessageRef = useRef('');
  const [submissionStatus, setSubmissionStatus] = useState<ReviewFeedbackSubmissionStatus>('idle');
  const [submissionError, setSubmissionError] = useState<string | undefined>();

  const releasePendingForAttempt = useCallback((attemptGeneration: number) => {
    if (attemptGeneration !== submissionGenerationRef.current) return;
    pendingRef.current = false;
    setFlagPending(false);
  }, []);

  const bumpSubmissionGeneration = useCallback(() => {
    const next = submissionGenerationRef.current + 1;
    submissionGenerationRef.current = next;
    setSubmissionGeneration(next);
    setSubmissionStatus('idle');
    setSubmissionError(undefined);
    return next;
  }, []);

  const setFlagMessageTracked = useCallback((value: SetStateAction<string>) => {
    // The voice adapter obeys the same disabled state as the visible textarea.
    // Editing a draft must never release a durable submission's duplicate lock.
    if (pendingRef.current || (publicSurface && image.error)) return;
    const previous = flagMessageRef.current;
    const next = typeof value === 'function' ? value(previous) : value;
    flagMessageRef.current = next;
    setFlagMessage(next);
    if (next !== previous) bumpSubmissionGeneration();
  }, [bumpSubmissionGeneration, publicSurface, image.error]);

  useEffect(() => {
    flagMessageRef.current = flagMessage;
  }, [flagMessage]);

  useEffect(() => {
    return registerResetCallback(() => {
      setFlagMode(false);
      setFlagged(false);
      setFlagPending(false);
      pendingRef.current = false;
      publicPendingRef.current = null;
      publicGenerationRef.current += 1;
      setFlagMessage('');
      flagMessageRef.current = '';
      submissionGenerationRef.current = 0;
      setSubmissionGeneration(0);
      setSubmissionStatus('idle');
      setSubmissionError(undefined);
    });
  }, [registerResetCallback]);

  const handleFlagSubmit = useCallback(async () => {
    if (!item) return;
    if (pendingRef.current) return;
    const attemptGeneration = submissionGenerationRef.current + 1;
    submissionGenerationRef.current = attemptGeneration;
    setSubmissionGeneration(attemptGeneration);
    setSubmissionStatus('submitting');
    setSubmissionError(undefined);
    pendingRef.current = true;
    setFlagPending(true);
    if (publicSurface) {
      const deliveryId = item.deliveryId;
      if (!deliveryId) {
        releasePendingForAttempt(attemptGeneration);
        setSubmissionStatus('idle');
        return;
      }
      const generation = publicGenerationRef.current;
      const note = flagMessage.trim();
      const body = publicPendingRef.current ?? {
        deliveryId,
        clientRequestId: genClientRequestId(),
        kind: 'flag' as const,
        reason: 'Other' as const,
        ...(note ? { message: note } : {}),
      };
      publicPendingRef.current = body;
      try {
        const response = await fetchWithDeadline('/api/cohort/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, CLIENT_FETCH_DEADLINE_MS);
        if (!response.ok) throw new Error('Feedback could not be saved');
        if (generation !== publicGenerationRef.current) return;
        if (attemptGeneration !== submissionGenerationRef.current) return;
        publicPendingRef.current = null;
        image.setError(null);
        setFlagMode(false);
        setFlagMessage('');
        flagMessageRef.current = '';
        setFlagged(true);
        releasePendingForAttempt(attemptGeneration);
        setSubmissionStatus('delivered');
      } catch {
        if (generation !== publicGenerationRef.current) return;
        if (attemptGeneration !== submissionGenerationRef.current) return;
        releasePendingForAttempt(attemptGeneration);
        image.setError('Feedback was not saved. Your note is kept; try again.');
        setSubmissionStatus('error');
        setSubmissionError('Feedback was not saved. Your note is kept; try again.');
      }
      return;
    }
    const generation = publicGenerationRef.current;
    const note = flagMessage.trim();
    const diagnostics = harvestFlagDiagnostics();
    const practiceSource = item.answerSource === 'practice-exam-follow-up'
      ? item.practiceReview?.source : undefined;
    const opaqueDeliveryId = item.type === 'question' ? item.deliveryId : undefined;
    let queued: QueuedFlag;
    try {
      queued = await queueFlag({
        type: item.type as 'card' | 'question',
        id: opaqueDeliveryId ?? item.id,
        ...(opaqueDeliveryId ? { deliveryId: opaqueDeliveryId } : {}),
        reason: 'Other',
        ...(note ? { message: note } : {}),
        ...((diagnostics || practiceSource) ? { context: {
          ...diagnostics,
          ...(practiceSource ? { componentType: 'practice-exam-item', path: practiceSource.paperPath } : {}),
        } } : {}),
      }, { image: image.file });
    } catch {
      if (generation !== publicGenerationRef.current) return;
      if (attemptGeneration !== submissionGenerationRef.current) return;
      image.setError('Not saved on this device. Try again.');
      setSubmissionStatus('error');
      setSubmissionError('Not saved on this device. Try again.');
      releasePendingForAttempt(attemptGeneration);
      return;
    }
    if (generation !== publicGenerationRef.current) return;
    if (attemptGeneration !== submissionGenerationRef.current) return;
    image.committed();
    setFlagMode(false);
    setFlagMessage('');
    flagMessageRef.current = '';
    setSubmissionStatus('queued');
    queued.result.then((result) => {
      if (generation !== publicGenerationRef.current) return;
      if (attemptGeneration !== submissionGenerationRef.current) return;
      if (result === 'delivered' || result === 'image-unavailable') {
        setFlagged(true);
        setSubmissionStatus('delivered');
        releasePendingForAttempt(attemptGeneration);
      } else if (result === 'queued') { /* stays pending — durably queued, awaiting replay */ }
      else if (result === 'auth-required') { setAuthExpired(true); /* stays pending */ }
      else {
        setSubmissionStatus('error');
        setSubmissionError('The report could not be delivered.');
        releasePendingForAttempt(attemptGeneration);
      }
    }).catch(() => {
      if (generation !== publicGenerationRef.current) return;
      if (attemptGeneration !== submissionGenerationRef.current) return;
      setSubmissionStatus('error');
      setSubmissionError('The report could not be delivered.');
      releasePendingForAttempt(attemptGeneration);
    });
  }, [item, flagMessage, image, publicSurface, releasePendingForAttempt]);

  const closeFlag = useCallback(() => {
    setFlagMode(false);
    // Closing the form cannot withdraw an in-flight or durably queued report.
    // Its eventual delivery still owns the pending lock and status.
    if (pendingRef.current) return;
    image.remove();
    publicPendingRef.current = null;
    publicGenerationRef.current += 1;
    pendingRef.current = false;
    setFlagPending(false);
    setFlagMessage('');
    flagMessageRef.current = '';
    setSubmissionStatus('idle');
    setSubmissionError(undefined);
  }, [image]);

  const openFlag = useCallback((value: SetStateAction<boolean>) => {
    const previous = flagMode;
    const next = typeof value === 'function' ? value(previous) : value;
    if (next && !previous && !pendingRef.current) {
      setSubmissionStatus('idle');
      setSubmissionError(undefined);
    }
    setFlagMode(next);
  }, [flagMode]);

  return {
    image,
    flagMode,
    flagged,
    flagPending,
    flagMessage,
    authExpired,
    submissionGeneration,
    submissionStatus,
    submissionError,
    setFlagMode: openFlag,
    setFlagMessage: setFlagMessageTracked,
    handleFlagSubmit,
    closeFlag,
  };
}
