'use client';

import { useFlagImage } from '@/components/content/FlagImageInput';
import { useState, useCallback, useEffect, useRef } from 'react';
import { submitFlag } from '@/lib/flag-submit';
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
 * Submission goes through the durable `submitFlag` outbox — failures are queued and
 * replayed, never silently dropped. The ✓ is shown only on confirmed delivery.
 */
export function useFlagging({ item, registerResetCallback, publicSurface = false }: UseFlaggingOpts) {
  const image = useFlagImage(`${item?.type}:${item?.deliveryId ?? item?.id}`);
  const [flagMode, setFlagMode] = useState(false);
  const [flagged, setFlagged] = useState(false);
  // Durably-queued or in-flight: the flag is safe in the outbox (queued /
  // auth-required) or mid-submit, but not yet confirmed delivered. Drives the
  // amber pending cue and — via pendingRef — blocks duplicate submissions.
  const [flagPending, setFlagPending] = useState(false);
  const [flagMessage, setFlagMessage] = useState('');
  // Session-expired cue. Deliberately NOT reset on item advance — once a write
  // 401s the cue persists across cards until the user re-signs-in (which reloads
  // the app and clears this state).
  const [authExpired, setAuthExpired] = useState(false);
  // Synchronous guard: state updates are async, so a second F-press in the same
  // tick would otherwise mint a second clientRequestId and create a duplicate
  // issue on replay. The ref blocks re-entry while a submit is in-flight or
  // durably queued.
  const pendingRef = useRef(false);
  const publicPendingRef = useRef<{ deliveryId: string; clientRequestId: string; kind: 'flag'; reason: 'Other'; message?: string } | null>(null);
  const publicGenerationRef = useRef(0);

  // Reset per-item flag state when the session advances (authExpired persists).
  useEffect(() => {
    return registerResetCallback(() => {
      setFlagMode(false);
      setFlagged(false);
      setFlagPending(false);
      pendingRef.current = false;
      publicPendingRef.current = null;
      publicGenerationRef.current += 1;
      setFlagMessage('');
    });
  }, [registerResetCallback]);

  const handleFlagSubmit = useCallback(async () => {
    if (!item) return;
    // Block only an in-flight or durably-queued submit (pendingRef) — this stops
    // accidental double-submit of the SAME flag. A delivered flag must NOT block a
    // second, distinct flag on the same card: the user often has a follow-up issue
    // (e.g. flagged "needs image", then notices the cloze is too easy). Each call
    // mints its own clientRequestId, so the second flag is a real new issue.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setFlagPending(true);
    if (publicSurface) {
      const deliveryId = item.deliveryId;
      if (!deliveryId) {
        pendingRef.current = false;
        setFlagPending(false);
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
        publicPendingRef.current = null;
        image.setError(null);
        setFlagMode(false);
        setFlagMessage('');
        setFlagged(true);
        setFlagPending(false);
        pendingRef.current = false;
      } catch {
        if (generation !== publicGenerationRef.current) return;
        setFlagPending(false);
        pendingRef.current = false;
        // The public surface has no image controls, but the shared overlay can
        // still expose the retry state through the same controller error slot.
        image.setError('Feedback was not saved. Your note is kept; try again.');
      }
      return;
    }
    const draft = image.capture();
    const note = flagMessage.trim();
    // Harvest the render environment NOW — at the moment of flagging, with the
    // card revealed and the footer showing — so a rendering complaint ("context
    // cut off") is diagnosable later from viewport/route/overflow/cover, not guesswork.
    const diagnostics = harvestFlagDiagnostics();
    const clear = () => { pendingRef.current = false; setFlagPending(false); };
    // Public questions are addressed exclusively by their opaque delivery
    // capability. Even if a future caller happens to retain the canonical id
    // locally, it must never cross this client boundary.
    const practiceSource = item.answerSource === 'practice-exam-follow-up'
      ? item.practiceReview?.source : undefined;
    const opaqueDeliveryId = item.type === 'question' ? item.deliveryId : undefined;
    // Exact practice retests keep the same opaque question capability as other
    // public questions; the server resolves that capability to the canonical
    // published exam component after checking owner and source fingerprints.
    let attachmentId: string | undefined;
    try { if (image.file) attachmentId = await image.prepare({ type: item.type as 'card' | 'question', id: opaqueDeliveryId ?? item.id, ...(opaqueDeliveryId ? { deliveryId: opaqueDeliveryId } : {}) }); }
    catch { clear(); return; }
    submitFlag({
      type: item.type as 'card' | 'question',
      id: opaqueDeliveryId ?? item.id,
      ...(opaqueDeliveryId ? { deliveryId: opaqueDeliveryId } : {}),
      reason: 'Other',
      ...(attachmentId ? { attachmentId } : {}),
      ...(note ? { message: note } : {}),
      ...((diagnostics || practiceSource) ? { context: {
        ...diagnostics,
        ...(practiceSource ? { componentType: 'practice-exam-item', path: practiceSource.paperPath } : {}),
      } } : {}),
    }).then((result) => {
      if (!image.isCurrent(draft)) return;
      if (result === 'image-unavailable') { image.retryImage(); clear(); return; }
      if (result !== 'dropped') { image.committed(); setFlagMode(false); setFlagMessage(''); }
      else image.setError('Flag was not sent. Your image and note are kept; try again.');
      if (result === 'delivered') { setFlagged(true); clear(); }
      else if (result === 'queued') { /* stays pending — durably queued, awaiting replay */ }
      else if (result === 'auth-required') { setAuthExpired(true); /* stays pending */ }
      else clear(); // 'dropped' — invalid, allow a retry
    }).catch(clear);
  }, [item, flagMessage, image, publicSurface]);

  const closeFlag = useCallback(() => {
    image.remove();
    publicPendingRef.current = null;
    publicGenerationRef.current += 1;
    pendingRef.current = false;
    setFlagPending(false);
    setFlagMode(false);
    setFlagMessage('');
  }, [image]);

  return {
    image,
    flagMode,
    flagged,
    flagPending,
    flagMessage,
    authExpired,
    setFlagMode,
    setFlagMessage,
    handleFlagSubmit,
    closeFlag,
  };
}
