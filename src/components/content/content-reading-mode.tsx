'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'md3.content.showAnswers';
const listeners = new Set<() => void>();
let lastKnownPreference = true;
// A failed write must still take effect in this tab, even if an older saved
// value remains readable (for example when the storage quota is exhausted).
let unsavedPreference: boolean | undefined;

function getSnapshot(): boolean {
  if (typeof window === 'undefined') return true;
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    lastKnownPreference = window.localStorage.getItem(STORAGE_KEY) !== '0';
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
  lastKnownPreference = event.newValue !== '0';
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

function setShowAnswers(showAnswers: boolean) {
  if (typeof window === 'undefined') return;
  lastKnownPreference = showAnswers;
  try {
    window.localStorage.setItem(STORAGE_KEY, showAnswers ? '1' : '0');
    unsavedPreference = undefined;
  } catch {
    unsavedPreference = showAnswers;
  }
  emitChange();
}

interface ContentReadingModeValue {
  showAnswers: boolean;
  toggleShowAnswers: () => void;
}

const ContentReadingModeContext = createContext<ContentReadingModeValue | null>(null);

export function ContentReadingModeProvider({ children }: { children: ReactNode }) {
  const showAnswers = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleShowAnswers = useCallback(() => {
    setShowAnswers(!getSnapshot());
  }, []);

  const value = useMemo(
    () => ({ showAnswers, toggleShowAnswers }),
    [showAnswers, toggleShowAnswers],
  );

  return (
    <ContentReadingModeContext.Provider value={value}>
      {children}
    </ContentReadingModeContext.Provider>
  );
}

export function useContentReadingMode(): ContentReadingModeValue {
  return useContext(ContentReadingModeContext) ?? {
    showAnswers: false,
    toggleShowAnswers: () => {},
  };
}
