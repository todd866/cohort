'use client';

import Link from 'next/link';

export function OfflineTabShell() {
  return (
    <section className="mx-auto flex min-h-[70svh] max-w-xl flex-col justify-center px-6 py-12 text-center">
      <p className="text-sm font-semibold uppercase tracking-wide text-[var(--md-primary)]">
        Offline
      </p>
      <h1 className="mt-3 text-3xl font-bold text-[var(--md-on-surface)]">
        Reconnect to continue Step 1
      </h1>
      <p className="mt-4 text-[var(--md-on-surface-variant)]">
        This application shell can be cached for a clearer offline failure state, but the current
        public alpha does not download answer-bearing study sessions for offline use.
      </p>
      <Link
        href="/usmle/step1"
        className="mx-auto mt-7 rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-medium text-[var(--md-on-primary)]"
      >
        Return to Step 1
      </Link>
    </section>
  );
}
