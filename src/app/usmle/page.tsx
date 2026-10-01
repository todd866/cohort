'use client';

import Link from 'next/link';
import {
  USMLE_PUBLIC_SOURCE_CTA,
  USMLE_PUBLIC_SOURCE_URL,
} from '@/lib/usmle/public-source';

export default function USMLEPage() {
  return (
    <main className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight text-[var(--md-on-surface)]">
        cohort.md
      </h1>
      <p className="mt-3 text-[var(--md-on-surface-variant)]">
        Open Step 1 MCQs with a source trail after every answer. Not a score or pass
        prediction.
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Link
          href="/usmle/step1"
          className="inline-flex rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
        >
          Start Step 1 study
        </Link>
        <a
          href={USMLE_PUBLIC_SOURCE_URL}
          className="text-sm font-semibold text-[var(--md-primary)] underline underline-offset-2"
          rel="noopener noreferrer"
          target="_blank"
        >
          {USMLE_PUBLIC_SOURCE_CTA}
        </a>
      </div>
    </main>
  );
}
