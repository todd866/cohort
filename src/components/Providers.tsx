'use client';

import { SessionProvider } from 'next-auth/react';
import { ThemeProvider } from './ThemeProvider';
import { TrackingProvider } from './TrackingProvider';
import { TermProvider } from './TermProvider';
import { type ReactNode } from 'react';
import { OFFLINE_SHELL_WINDOW_KEY } from '@/lib/review/session-preload';
import { GuestProgressClaimWarm } from './GuestProgressClaimWarm';
import { ReviewBootstrapSafetyWarm } from './ReviewBootstrapSafetyWarm';

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const isCredentiallessOfflineShell =
    typeof window !== 'undefined'
    && (window as unknown as Record<string, unknown>)[OFFLINE_SHELL_WINDOW_KEY] === true;

  const appProviders = isCredentiallessOfflineShell
    ? children
    : (
      <TrackingProvider>
        {/* Default to medicine domain; future: make domain-aware based on route */}
        <TermProvider domain="medicine">{children}</TermProvider>
      </TrackingProvider>
    );

  return (
    // Roll the session forward so active users never get logged out: an open or
    // resumed PWA pings /api/auth/session, which makes next-auth re-issue the
    // rolling session cookie (the real "stay logged in" fix). refetchWhenOffline
    // is off so we don't spam a dead endpoint while offline — it can't roll then.
    <SessionProvider
      session={isCredentiallessOfflineShell ? null : undefined}
      refetchInterval={isCredentiallessOfflineShell ? 0 : 60 * 60}
      refetchOnWindowFocus={!isCredentiallessOfflineShell}
      refetchWhenOffline={false}
    >
      <ThemeProvider>
        {appProviders}
        {!isCredentiallessOfflineShell ? <GuestProgressClaimWarm /> : null}
        {!isCredentiallessOfflineShell ? <ReviewBootstrapSafetyWarm /> : null}
      </ThemeProvider>
    </SessionProvider>
  );
}
