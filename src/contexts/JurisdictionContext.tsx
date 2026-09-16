'use client';

import { createContext, useContext, useMemo, ReactNode } from 'react';
import { useSession } from 'next-auth/react';

export type Jurisdiction = 'nsw' | 'wa' | 'national' | null;

interface JurisdictionContextValue {
  /** User's explicit jurisdiction setting, or inferred from institution */
  jurisdiction: Jurisdiction;
  /** Whether content with this jurisdiction tag should be shown */
  shouldShow: (contentJurisdiction: string | null | undefined) => boolean;
  /** All jurisdictions (for admin/comparison views) */
  allJurisdictions: readonly Jurisdiction[];
}

const JurisdictionContext = createContext<JurisdictionContextValue | null>(null);

/**
 * Infer jurisdiction from institution if not explicitly set
 */
function inferJurisdiction(
  explicit: string | null | undefined,
  institution: string | null | undefined
): Jurisdiction {
  // Explicit setting takes priority
  if (explicit === 'nsw' || explicit === 'wa' || explicit === 'national') {
    return explicit;
  }

  // Infer from institution
  if (institution === 'usyd') return 'nsw';
  if (institution === 'usmle') return 'national';

  // Default to national (shows all non-jurisdiction-specific content)
  return 'national';
}

/**
 * Determine if content should be shown based on jurisdiction
 *
 * Rules:
 * - Content with no jurisdiction tag → show to everyone
 * - Content tagged 'national' → show to everyone
 * - Content tagged with specific jurisdiction → only show if user matches
 */
function createShouldShow(userJurisdiction: Jurisdiction) {
  return (contentJurisdiction: string | null | undefined): boolean => {
    // No jurisdiction tag = universal content
    if (!contentJurisdiction) return true;

    // National content shows for everyone
    if (contentJurisdiction === 'national') return true;

    // User on 'national' sees everything
    if (userJurisdiction === 'national') return true;

    // Otherwise, must match
    return contentJurisdiction === userJurisdiction;
  };
}

const ALL_JURISDICTIONS: readonly Jurisdiction[] = ['nsw', 'wa', 'national', null];

interface JurisdictionProviderProps {
  children: ReactNode;
  /** Override jurisdiction (useful for preview/admin) */
  override?: Jurisdiction;
}

export function JurisdictionProvider({ children, override }: JurisdictionProviderProps) {
  const { data: session } = useSession();

  const value = useMemo<JurisdictionContextValue>(() => {
    const user = session?.user as { jurisdiction?: string; institution?: string } | undefined;

    const jurisdiction = override ?? inferJurisdiction(user?.jurisdiction, user?.institution);

    return {
      jurisdiction,
      shouldShow: createShouldShow(jurisdiction),
      allJurisdictions: ALL_JURISDICTIONS,
    };
  }, [session, override]);

  return (
    <JurisdictionContext.Provider value={value}>
      {children}
    </JurisdictionContext.Provider>
  );
}

export function useJurisdiction(): JurisdictionContextValue {
  const context = useContext(JurisdictionContext);

  if (!context) {
    // Return sensible defaults if used outside provider (e.g., SSR)
    return {
      jurisdiction: 'national',
      shouldShow: () => true,
      allJurisdictions: ALL_JURISDICTIONS,
    };
  }

  return context;
}

/**
 * Hook for conditional rendering based on jurisdiction
 *
 * Usage:
 * const show = useJurisdictionFilter('nsw');
 * if (!show) return null;
 */
export function useJurisdictionFilter(contentJurisdiction: string | null | undefined): boolean {
  const { shouldShow } = useJurisdiction();
  return shouldShow(contentJurisdiction);
}

/**
 * Jurisdiction display names
 */
export const JURISDICTION_LABELS: Record<string, string> = {
  nsw: 'New South Wales',
  wa: 'Western Australia',
  national: 'National (Australia)',
};

/**
 * Jurisdiction badge colors
 */
export const JURISDICTION_COLORS: Record<string, string> = {
  nsw: 'bg-blue-100 text-blue-800',
  wa: 'bg-amber-100 text-amber-800',
  national: 'bg-green-100 text-green-800',
};
