'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { useUserMinimal } from './useUserMinimal';
import {
  Institution,
  InstitutionConfig,
  INSTITUTION_STORAGE_KEY,
  MODULES_STORAGE_KEY,
  DEFAULT_ENABLED_MODULES,
  UNIVERSAL_MODULES,
  getInstitutionConfig,
  isSupportedInstitution,
  detectInstitutionFromPath,
  detectInstitutionFromHostname,
} from '@/lib/institution';

const STORAGE_EVENT = 'md3_institution_changed';

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

function getStoredInstitution(): Institution | null {
  const stored = safeLocalStorageGetItem(INSTITUTION_STORAGE_KEY);
  return isSupportedInstitution(stored) ? stored : null;
}

function setStoredInstitution(institution: Institution): void {
  if (typeof window === 'undefined') return;
  safeLocalStorageSetItem(INSTITUTION_STORAGE_KEY, institution);
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

// useSyncExternalStore requires Object.is-stable snapshots until the backing
// store changes. JSON.parse creates a new array for every read, so cache the
// parsed value by the exact localStorage payload (including null/invalid data).
let storedModulesSnapshotCache:
  | { raw: string | null; value: string[] }
  | undefined;

function getStoredModules(): string[] {
  const stored = safeLocalStorageGetItem(MODULES_STORAGE_KEY);
  if (storedModulesSnapshotCache?.raw === stored) {
    return storedModulesSnapshotCache.value;
  }

  let value = DEFAULT_ENABLED_MODULES;
  if (stored) {
    try {
      const modules = JSON.parse(stored);
      if (Array.isArray(modules)) value = modules;
    } catch {
      // Invalid JSON, use defaults
    }
  }

  storedModulesSnapshotCache = { raw: stored, value };
  return value;
}

function setStoredModules(modules: string[]): void {
  if (typeof window === 'undefined') return;
  safeLocalStorageSetItem(MODULES_STORAGE_KEY, JSON.stringify(modules));
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

function subscribeToChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (e: StorageEvent) => {
    if (e.key === INSTITUTION_STORAGE_KEY || e.key === MODULES_STORAGE_KEY) {
      callback();
    }
  };
  const handleLocal = () => callback();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(STORAGE_EVENT, handleLocal);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(STORAGE_EVENT, handleLocal);
  };
}

export interface UseInstitutionReturn {
  /** Current institution, null if not set */
  institution: Institution | null;
  /** Institution config (name, shortName, etc.) */
  institutionConfig: InstitutionConfig | null;
  /** Whether we're still loading user data */
  loading: boolean;
  /** Whether user is logged in */
  isLoggedIn: boolean;
  /** Convenience checks */
  isUsyd: boolean;
  isUsydMd1: boolean;
  isUsydMd2: boolean;
  isUsmle: boolean;
  /** Universal modules enabled by user */
  enabledModules: string[];
  /** Set the user's institution */
  setInstitution: (institution: Institution) => Promise<void>;
  /** Toggle a universal module */
  toggleModule: (moduleId: string, enabled: boolean) => Promise<void>;
  /** Set all enabled modules at once */
  setEnabledModules: (modules: string[]) => Promise<void>;
  /** Get module info */
  getModuleInfo: (moduleId: string) => typeof UNIVERSAL_MODULES[number] | undefined;
  /** Auto-set institution from current path */
  autoSetFromPath: (path: string) => void;
}

/**
 * Hook to manage user's institution and universal module preferences.
 * Works for both anonymous (localStorage) and logged-in (API) users.
 */
export function useInstitution(): UseInstitutionReturn {
  const { data: session, status } = useSession();
  const { data: serverData, isLoading: serverLoading, mutate } = useUserMinimal();

  // Get localStorage values with useSyncExternalStore for SSR safety
  const localInstitution = useSyncExternalStore(
    subscribeToChanges,
    getStoredInstitution,
    () => null
  );

  const localModules = useSyncExternalStore(
    subscribeToChanges,
    getStoredModules,
    () => DEFAULT_ENABLED_MODULES
  );

  const loading = status === 'loading' || serverLoading;

  // Hostname overrides everything — cohort.md always serves USMLE content
  const hostnameInstitution = typeof window !== 'undefined'
    ? detectInstitutionFromHostname(window.location.hostname)
    : null;

  // Priority: hostname > server preference > localStorage
  const serverInstitution = isSupportedInstitution(serverData?.institution)
    ? serverData.institution
    : null;
  const institution = hostnameInstitution
    ?? serverInstitution
    ?? localInstitution;
  const enabledModules = serverData?.enabledModules ?? localModules;
  const isLoggedIn = status === 'authenticated';
  const institutionConfig = institution ? getInstitutionConfig(institution) : null;

  const setInstitution = useCallback(
    async (newInstitution: Institution) => {
      // Always save to localStorage (works offline, fast)
      setStoredInstitution(newInstitution);

      // If logged in, also save to server
      if (session?.user) {
        try {
          await fetch('/api/user', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ institution: newInstitution }),
          });
          // Update SWR cache
          mutate();
        } catch (err) {
          console.error('Failed to save institution preference:', err);
        }
      }
    },
    [session, mutate]
  );

  const setEnabledModules = useCallback(
    async (modules: string[]) => {
      // Always save to localStorage
      setStoredModules(modules);

      // If logged in, also save to server
      if (session?.user) {
        try {
          await fetch('/api/user', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabledModules: modules }),
          });
          mutate();
        } catch (err) {
          console.error('Failed to save modules preference:', err);
        }
      }
    },
    [session, mutate]
  );

  const toggleModule = useCallback(
    async (moduleId: string, enabled: boolean) => {
      const newModules = enabled
        ? [...enabledModules, moduleId]
        : enabledModules.filter((m) => m !== moduleId);
      await setEnabledModules(newModules);
    },
    [enabledModules, setEnabledModules]
  );

  const getModuleInfo = useCallback(
    (moduleId: string) => UNIVERSAL_MODULES.find((m) => m.id === moduleId),
    []
  );

  const autoSetFromPath = useCallback(
    (path: string) => {
      const detected = detectInstitutionFromPath(path);
      if (detected && (!institution || institution !== detected)) {
        // Auto-set institution based on entry point
        setInstitution(detected);
      }
    },
    [institution, setInstitution]
  );

  return {
    institution,
    institutionConfig,
    loading,
    isLoggedIn,
    isUsyd: institution === 'usyd',
    isUsydMd1: institution === 'usyd-md1',
    isUsydMd2: institution === 'usyd-md2',
    isUsmle: institution === 'usmle',
    enabledModules,
    setInstitution,
    toggleModule,
    setEnabledModules,
    getModuleInfo,
    autoSetFromPath,
  };
}

// Re-export types for convenience
export type { Institution, InstitutionConfig } from '@/lib/institution';
export { INSTITUTIONS, UNIVERSAL_MODULES, DEFAULT_ENABLED_MODULES } from '@/lib/institution';
