'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';

/**
 * The signed-in learner's "No exam follow-ups" switch, shared by the review
 * options chip and the follow-up panel's "Stop exam follow-ups" button so the
 * two never disagree. Read once from the account; a change shows at once and
 * is saved behind it. `null` means not yet known: neither control renders.
 */
type Snapshot = { off: boolean | null; saving: boolean };
let snapshot: Snapshot = { off: null, saving: false };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

async function load(): Promise<void> {
  try {
    const response = await fetchWithDeadline('/api/study/follow-up-preference', {
      credentials: 'same-origin',
    }, CLIENT_FETCH_DEADLINE_MS);
    if (!response.ok) return;
    const body = await response.json() as { off?: unknown };
    if (typeof body.off === 'boolean' && snapshot.off === null) set({ ...snapshot, off: body.off });
  } catch {
    // Unknown stays unknown: the controls stay hidden rather than guess.
  } finally {
    loading = null;
  }
}

/** Test seam: forget the cached choice. */
export function resetPracticeFollowUpPreferenceForTests() {
  snapshot = { off: null, saving: false };
  loading = null;
}

export function usePracticeFollowUpPreference(enabled: boolean) {
  const state = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  useEffect(() => {
    if (enabled && snapshot.off === null && !loading) loading = load();
  }, [enabled]);
  const setOff = useCallback(async (off: boolean): Promise<boolean> => {
    const previous = snapshot.off;
    set({ off, saving: true });
    try {
      const response = await fetchWithDeadline('/api/study/follow-up-preference', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ off }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!response.ok) throw new Error(String(response.status));
      set({ off, saving: false });
      return true;
    } catch {
      set({ off: previous, saving: false });
      return false;
    }
  }, []);
  return { off: enabled ? state.off : null, saving: state.saving, setOff };
}
