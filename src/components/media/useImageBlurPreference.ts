'use client';

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'md3:blur-images';
const listeners = new Set<() => void>();
let lastKnownPreference = true;
// A failed write must still take effect in this tab, even if an older saved
// value remains readable (for example when the storage quota is exhausted).
let unsavedPreference: boolean | undefined;

function getSnapshot(): boolean {
  if (typeof window === 'undefined') return true;
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    lastKnownPreference = window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private browsing or browser policy can make localStorage unavailable.
  }
  return lastKnownPreference;
}

function getServerSnapshot(): boolean {
  return true;
}

function emitChange() {
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
  } catch {
    // The event can still update this tab if access to storage was revoked.
  }
  unsavedPreference = undefined;
  lastKnownPreference = event.newValue !== 'off';
  emitChange();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', handleStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', handleStorage);
  };
}

function setBlurImages(blurImages: boolean) {
  if (typeof window === 'undefined') return;
  lastKnownPreference = blurImages;
  try {
    window.localStorage.setItem(STORAGE_KEY, blurImages ? 'on' : 'off');
    unsavedPreference = undefined;
  } catch {
    unsavedPreference = blurImages;
  }
  emitChange();
}

/** Device/browser preference; answer progress and per-image tracking are separate. */
export function useImageBlurPreference() {
  const blurImages = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { blurImages, setBlurImages };
}
