'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { reportClientError } from '@/lib/report-client-error';

export default function ReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Review session error:', error);
    reportClientError(error, 'route-error');
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
      <div className="max-w-md space-y-4">
        <h2 className="text-xl font-semibold text-[var(--md-on-surface)]">
          Something went wrong
        </h2>
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          The review session hit an unexpected error. Your progress has been saved.
        </p>
        <div className="flex gap-3 justify-center pt-2">
          <button
            onClick={reset}
            className="px-4 py-2 rounded-full text-sm font-medium bg-[var(--md-primary)] text-[var(--md-on-primary)]"
          >
            Try again
          </button>
          <Link
            href="/"
            className="px-4 py-2 rounded-full text-sm font-medium border border-[var(--md-outline)] text-[var(--md-primary)]"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
