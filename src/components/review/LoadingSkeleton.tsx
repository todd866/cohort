'use client';

import { useEffect, useState } from 'react';

type LoadingSkeletonVariant = 'page' | 'session';

interface LoadingSkeletonProps {
  variant?: LoadingSkeletonVariant;
}

/**
 * Card-shaped skeleton + progressive "still loading..." / "taking longer" messages
 * after 4s and 10s. Caller mounts this only while the session is loading; the
 * timers tear down on unmount.
 */
export function LoadingSkeleton({ variant = 'session' }: LoadingSkeletonProps) {
  const initialMessage = variant === 'page' ? 'Preparing review...' : 'Loading review...';
  const [loadingMessage, setLoadingMessage] = useState(initialMessage);

  useEffect(() => {
    const t1 = setTimeout(() => setLoadingMessage('Still loading...'), 4_000);
    const t2 = setTimeout(() => setLoadingMessage('Taking longer than usual...'), 10_000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className="px-4 pt-4 pb-48 md:pt-6">
      <div className="mx-auto max-w-2xl">
        <div aria-hidden="true">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="review-skeleton-line h-9 w-28 rounded-full" />
            <div className="review-skeleton-line h-9 w-24 rounded-full" />
          </div>

          <div className="review-card-shell overflow-hidden">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-[var(--md-tertiary)] opacity-70" />
                <div className="review-skeleton-line h-3 w-24 rounded-full" />
              </div>
              <div className="review-skeleton-line h-6 w-16 rounded-full" />
            </div>

            <div className="space-y-3">
              <div className="review-skeleton-line h-5 w-full rounded" />
              <div className="review-skeleton-line h-5 w-[86%] rounded" />
              <div className="review-skeleton-line h-5 w-[64%] rounded" />
            </div>

            <div className="my-7 h-px bg-[var(--md-outline-soft)]" />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="review-skeleton-line h-12 rounded-[var(--md-radius-sm)]" />
              <div className="review-skeleton-line hidden h-12 rounded-[var(--md-radius-sm)] sm:block" />
            </div>
          </div>

          <div className="mt-5 grid grid-cols-4 gap-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="review-skeleton-line h-11 rounded-full" />
            ))}
          </div>
        </div>

        <p
          role="status"
          aria-live="polite"
          className="mt-5 text-center text-sm text-[var(--md-on-surface-variant)]"
        >
          {loadingMessage}
        </p>
      </div>
    </div>
  );
}
