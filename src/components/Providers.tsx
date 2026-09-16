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
  /**
   * Whether this request arrived with a guest cookie that might still need
   * importing, resolved by the server layout from the request's own HttpOnly
   * cookie. Defaults to true so a caller that omits it fails closed and keeps
   * the recovery path rather than silently stranding a pending import.
   */
  guestClaimPending?: boolean;
}

export function Providers({ children, guestClaimPending = true }: ProvidersProps) {
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
        {/*
          Always mounted, but it only issues a request when there is something
          to recover: a browser still holding a guest cookie after its sign-in
          claim did not complete. Every other authenticated load has nothing to
          import, so the POST was a pure no-op whose only outcomes were silence
          or — on a cold function — a timeout and a warning banner.

          Mounting unconditionally (rather than gating on the server flag) keeps
          the component able to observe a later sign-in in this tab. The root
          layout does not re-render on client navigation, so a gated-off tab
          could otherwise never learn that a claim became pending.
        */}
        {!isCredentiallessOfflineShell
          ? <GuestProgressClaimWarm claimPending={guestClaimPending} />
          : null}
        {!isCredentiallessOfflineShell ? <ReviewBootstrapSafetyWarm /> : null}
      </ThemeProvider>
    </SessionProvider>
  );
}
