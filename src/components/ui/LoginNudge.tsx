'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { safeInternalCallback } from '@/lib/auth-callback';
import { useInteractionTracking } from '@/hooks/useTracking';

interface LoginNudgeProps {
  message?: string;
  variant?: 'banner' | 'modal' | 'inline';
  onDismiss?: () => void;
  callbackUrl?: string;
  source?: string;
  reviewsCompleted?: number;
}

const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const DISMISS_KEY = 'md3_login_nudge_dismissed';
const DISMISS_EVENT = 'md3_login_nudge_dismissed_changed';

function getIsDismissedSnapshot(): boolean {
  if (typeof window === 'undefined') return true;

  const dismissedAt = window.localStorage.getItem(DISMISS_KEY);
  if (!dismissedAt) return false;

  const dismissedAtMs = parseInt(dismissedAt, 10);
  if (!Number.isFinite(dismissedAtMs)) return false;

  return Date.now() - dismissedAtMs < DISMISS_COOLDOWN_MS;
}

function subscribeToDismissedChanges(callback: () => void) {
  if (typeof window === 'undefined') return () => {};

  const handleStorage = (e: StorageEvent) => {
    if (e.key === DISMISS_KEY) callback();
  };

  const handleLocal = () => callback();

  window.addEventListener('storage', handleStorage);
  window.addEventListener(DISMISS_EVENT, handleLocal as EventListener);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(DISMISS_EVENT, handleLocal as EventListener);
  };
}

export function LoginNudge({
  message = 'Sign in to keep this review history with your account and sync across devices.',
  variant = 'banner',
  onDismiss,
  callbackUrl,
  source = 'review-nudge',
  reviewsCompleted,
}: LoginNudgeProps) {
  const router = useRouter();
  const { trackInteraction } = useInteractionTracking();
  const dismissed = useSyncExternalStore(
    subscribeToDismissedChanges,
    getIsDismissedSnapshot,
    () => true
  );

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    window.dispatchEvent(new Event(DISMISS_EVENT));
    onDismiss?.();
  };

  const handleLogin = () => {
    const currentPath = typeof window === 'undefined'
      ? '/'
      : `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const safeCallbackUrl = safeInternalCallback(callbackUrl ?? currentPath);
    trackInteraction(
      'AuthCTA',
      'signup_click',
      source,
      reviewsCompleted == null ? undefined : { reviewsCompleted },
    );
    const params = new URLSearchParams({
      source,
      callbackUrl: safeCallbackUrl,
    });
    router.push(`/auth/signin?${params.toString()}`);
  };

  if (dismissed) return null;

  if (variant === 'inline') {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container)] px-3 py-2 text-sm text-[var(--md-on-surface-variant)]"
      >
        <span className="min-w-0 flex-1">{message}</span>
        <button
          onClick={handleLogin}
          className="min-h-11 shrink-0 px-3 font-medium text-[var(--md-primary)] hover:underline"
        >
          Sign in
        </button>
        <button
          onClick={handleDismiss}
          className="min-h-11 min-w-11 shrink-0 rounded-lg text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]"
          aria-label="Dismiss sign-in suggestion"
        >
          {'\u00d7'}
        </button>
      </div>
    );
  }

  if (variant === 'modal') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-background rounded-lg p-6 max-w-md mx-4 shadow-lg">
          <h3 className="text-lg font-semibold mb-2">Save Your Progress</h3>
          <p className="text-muted-foreground mb-4">{message}</p>
          <div className="flex gap-2">
            <button
              onClick={handleLogin}
              className="flex-1 bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90"
            >
              Sign in
            </button>
            <button
              onClick={handleDismiss}
              className="px-4 py-2 text-muted-foreground hover:text-foreground"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Default: banner
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-primary text-primary-foreground p-3">
      <div className="container mx-auto flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{message}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleLogin}
            className="bg-background text-foreground px-3 py-1.5 rounded-md text-sm font-medium hover:bg-background/90"
          >
            Sign in
          </button>
          <button
            onClick={handleDismiss}
            className="text-primary-foreground/80 hover:text-primary-foreground text-sm"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export const GUEST_REVIEW_LOGIN_NUDGE_THRESHOLD = 5;

export function GuestReviewLoginNudge({
  isGuest,
  reviewCount,
  callbackUrl,
}: {
  isGuest: boolean;
  reviewCount: number;
  callbackUrl?: string;
}) {
  if (!isGuest || reviewCount < GUEST_REVIEW_LOGIN_NUDGE_THRESHOLD) {
    return null;
  }

  const noun = reviewCount === 1 ? 'review' : 'reviews';
  return (
    <LoginNudge
      variant="inline"
      callbackUrl={callbackUrl}
      reviewsCompleted={reviewCount}
      message={`${reviewCount} ${noun} saved on this device. Sign in to keep them with your account and sync across devices.`}
    />
  );
}

/**
 * Hook to check if we should show login nudge based on tracking API response.
 */
export function useLoginNudge() {
  const [nudgeMessage, setNudgeMessage] = useState<string | null>(null);

  // Called when tracking API returns a nudge message
  const checkNudge = (response: { nudge?: string }) => {
    if (response.nudge) {
      // Check cooldown
      const dismissedAt = localStorage.getItem(DISMISS_KEY);
      if (dismissedAt) {
        const elapsed = Date.now() - parseInt(dismissedAt, 10);
        if (elapsed < DISMISS_COOLDOWN_MS) {
          return;
        }
      }
      setNudgeMessage(response.nudge);
    }
  };

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    window.dispatchEvent(new Event(DISMISS_EVENT));
    setNudgeMessage(null);
  };

  return { nudgeMessage, checkNudge, dismiss };
}
