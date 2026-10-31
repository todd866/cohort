'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import {
  normalizeReviewMediaPreferences,
  type StoredReviewMediaPreferences,
} from '@/lib/study/review-media-preferences';

/**
 * "No videos" / "No images" on this device. The mirror makes a toggle take
 * effect at once; a signed-in learner's choice is also saved to the account
 * (see `saveReviewMediaPreferencesToAccount`), and an account value newer than
 * this device's is adopted from the session response.
 */
const STORAGE_KEY = 'md3:review-media';
const DEFAULT: StoredReviewMediaPreferences = Object.freeze({ hideVideos: false, hideImages: false, rev: 0 });
const listeners = new Set<() => void>();
let snapshot: StoredReviewMediaPreferences = DEFAULT;
let snapshotSource: string | null | undefined;
// A failed write must still take effect in this tab.
let unsaved: StoredReviewMediaPreferences | undefined;
let sequence = 0;

function read(): StoredReviewMediaPreferences {
  if (typeof window === 'undefined') return DEFAULT;
  if (unsaved) return unsaved;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return snapshot;
  }
  // useSyncExternalStore needs a stable object while the stored text is unchanged.
  if (raw === snapshotSource) return snapshot;
  snapshotSource = raw;
  try {
    snapshot = raw ? normalizeReviewMediaPreferences(JSON.parse(raw)) : DEFAULT;
  } catch {
    snapshot = DEFAULT;
  }
  return snapshot;
}

function emit() {
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  unsaved = undefined;
  emit();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', handleStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', handleStorage);
  };
}

function write(next: StoredReviewMediaPreferences) {
  const text = JSON.stringify(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, text);
    unsaved = undefined;
    snapshotSource = text;
    snapshot = next;
  } catch {
    unsaved = next;
  }
  emit();
}

/** Microsecond clock plus a sequence: strictly increasing within a tab. */
function nextRevision(current: number): number {
  sequence = (sequence + 1) % 1000;
  return Math.max(current + 1, Date.now() * 1000 + sequence);
}

export function useReviewMediaPreferences() {
  const preferences = useSyncExternalStore(subscribe, read, () => DEFAULT);
  const setPreference = useCallback((kind: 'hideVideos' | 'hideImages', on: boolean) => {
    const current = read();
    const next = { ...current, [kind]: on, rev: nextRevision(current.rev) };
    write(next);
    return next;
  }, []);
  /** Adopt the account's saved choice when it is newer than this device's. */
  const adoptServer = useCallback((value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const incoming = normalizeReviewMediaPreferences(value);
    if (incoming.rev <= read().rev) return false;
    write(incoming);
    return true;
  }, []);
  return { preferences, setPreference, adoptServer };
}

/** Best effort: the device copy still applies (and rides on `hide=`) if this fails. */
export async function saveReviewMediaPreferencesToAccount(preferences: StoredReviewMediaPreferences): Promise<boolean> {
  try {
    const response = await fetchWithDeadline('/api/study/media-preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ hideVideos: preferences.hideVideos, hideImages: preferences.hideImages, rev: preferences.rev }),
    }, CLIENT_FETCH_DEADLINE_MS);
    return response.ok;
  } catch {
    return false;
  }
}
