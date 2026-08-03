'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { useUserMinimal } from './useUserMinimal';
import {
  ROTATIONS,
  type TrackNumber,
  type RotationId,
  getCurrentWeek,
  getActiveRotations,
} from '@/lib/rotation-context';

const STORAGE_KEY = 'md3_track';
const STORAGE_EVENT = 'md3_track_changed';

function safeLocalStorageGetItem(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSetItem(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode / disabled).
  }
}

function getStoredTrack(): TrackNumber | null {
  const stored = safeLocalStorageGetItem(STORAGE_KEY);
  if (stored) {
    const track = parseInt(stored, 10);
    if (track >= 1 && track <= 4) return track as TrackNumber;
  }
  return null;
}

function setStoredTrack(track: TrackNumber): void {
  if (typeof window === 'undefined') return;
  safeLocalStorageSetItem(STORAGE_KEY, track.toString());
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function subscribeToTrackChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  const handleLocal = () => callback();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(STORAGE_EVENT, handleLocal);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(STORAGE_EVENT, handleLocal);
  };
}

interface UseUserTrackReturn {
  /** User's track (1-4), null if not set */
  track: TrackNumber | null;
  /** Current rotation ID derived from track + date */
  currentRotation: RotationId | null;
  /** Active rotations — single current rotation (matches block calendar) */
  activeRotations: RotationId[];
  /** Current week (1-7) */
  currentWeek: number;
  /** Whether we're still loading user data */
  loading: boolean;
  /** Whether user is logged in */
  isLoggedIn: boolean;
  /** Whether user needs to pick a track (no track set) */
  needsTrackPicker: boolean;
  /** Set the user's track */
  setTrack: (track: TrackNumber) => Promise<void>;
  /** Get rotation metadata */
  getRotationInfo: (id: RotationId) => typeof ROTATIONS[number] | undefined;
}

/**
 * Hook to manage user's track preference.
 * Works for both anonymous (localStorage) and logged-in (API) users.
 */
export function useUserTrack(): UseUserTrackReturn {
  const { data: session, status } = useSession();
  const { data: serverData, isLoading: serverLoading, mutate } = useUserMinimal();

  // Get localStorage track with useSyncExternalStore for SSR safety
  const localTrack = useSyncExternalStore(
    subscribeToTrackChanges,
    getStoredTrack,
    () => null
  );

  const loading = status === 'loading' || serverLoading;

  // Determine effective track (server takes precedence over local)
  const track = (serverData?.track as TrackNumber) ?? localTrack;
  const isLoggedIn = status === 'authenticated';
  const needsTrackPicker = !loading && track === null;

  // Derive active rotations from track + date
  const activeRotations = track ? getActiveRotations(track) : [];
  const currentRotation = activeRotations[0] ?? null;
  const currentWeek = getCurrentWeek();

  const setTrack = useCallback(
    async (newTrack: TrackNumber) => {
      // Always save to localStorage (works offline, fast)
      setStoredTrack(newTrack);

      // If logged in, also save to server
      if (session?.user) {
        try {
          await fetch('/api/user/rotation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track: newTrack }),
          });
          // Revalidate SWR cache
          mutate();
        } catch (err) {
          console.error('Failed to save track preference:', err);
        }
      }
    },
    [session, mutate]
  );

  const getRotationInfo = useCallback(
    (id: RotationId) => ROTATIONS.find((r) => r.id === id),
    []
  );

  return {
    track,
    currentRotation,
    activeRotations,
    currentWeek,
    loading,
    isLoggedIn,
    needsTrackPicker,
    setTrack,
    getRotationInfo,
  };
}

// Re-export for convenience
export { type TrackNumber, type RotationId } from '@/lib/rotation-context';
