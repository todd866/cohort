'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { submitFlag } from '@/lib/flag-submit';
import { harvestFlagDiagnostics } from '@/lib/flag-diagnostics';

interface FlagItem {
  id: string;
  type: string;
}

interface UseFlaggingOpts {
  /** The currently displayed item — used to address the flag submission. */
  item: FlagItem | undefined;
  /** Subscribe a reset callback to be called when the session advances to the next item. */
  registerResetCallback: (cb: () => void) => () => void;
}

/**
 * Owns the "F to flag" UI state: open the input, type a note (optional), submit, reset.
 * Submission goes through the durable `submitFlag` outbox — failures are queued and
 * replayed, never silently dropped. The ✓ is shown only on confirmed delivery.
 */
export function useFlagging({ item, registerResetCallback }: UseFlaggingOpts) {
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

  // Reset per-item flag state when the session advances (authExpired persists).
  useEffect(() => {
    return registerResetCallback(() => {
      setFlagMode(false);
      setFlagged(false);
      setFlagPending(false);
      pendingRef.current = false;
      setFlagMessage('');
    });
  }, [registerResetCallback]);

  const handleFlagSubmit = useCallback(() => {
    if (!item) return;
    // Block only an in-flight or durably-queued submit (pendingRef) — this stops
    // accidental double-submit of the SAME flag. A delivered flag must NOT block a
    // second, distinct flag on the same card: the user often has a follow-up issue
    // (e.g. flagged "needs image", then notices the cloze is too easy). Each call
    // mints its own clientRequestId, so the second flag is a real new issue.
    if (pendingRef.current) return;
    pendingRef.current = true;
    setFlagPending(true);
    setFlagMode(false);
    const note = flagMessage.trim();
    // Harvest the render environment NOW — at the moment of flagging, with the
    // card revealed and the footer showing — so a rendering complaint ("context
    // cut off") is diagnosable later from viewport/route/overflow/cover, not guesswork.
    const diagnostics = harvestFlagDiagnostics();
    const clear = () => { pendingRef.current = false; setFlagPending(false); };
    submitFlag({
      type: item.type as 'card' | 'question',
      id: item.id,
      reason: 'Other',
      ...(note ? { message: note } : {}),
      ...(diagnostics ? { context: diagnostics } : {}),
    }).then((result) => {
      if (result === 'delivered') { setFlagged(true); clear(); }
      else if (result === 'queued') { /* stays pending — durably queued, awaiting replay */ }
      else if (result === 'auth-required') { setAuthExpired(true); /* stays pending */ }
      else clear(); // 'dropped' — invalid, allow a retry
    }).catch(clear);
    setFlagMessage('');
  }, [item, flagMessage]);

  const closeFlag = useCallback(() => {
    setFlagMode(false);
    setFlagMessage('');
  }, []);

  return {
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
