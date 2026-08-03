'use client';

import Link from 'next/link';

export default function USMLEPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-8">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--md-primary)]">
          cohort.md
        </p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Study cited Step 1 MCQs
        </h1>
        <p className="mt-3 text-[var(--md-on-surface-variant)]">
          An early public open corpus of 25 original, redistributable MCQs with a
          source trail after every answer. Spaced practice only — not a score or
          pass prediction. Try as a guest, or sign in to keep progress.
        </p>
      </header>

      <section className="rounded-2xl border border-[var(--md-primary)] bg-[var(--md-primary-container)]/10 p-6">
        <h2 className="text-xl font-semibold">Step 1</h2>
        <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
          Immunology, microbiology, endocrine, renal, hematology, and genetics —
          incomplete blueprint coverage on purpose while the bank grows.
        </p>
        <Link
          href="/usmle/step1"
          className="mt-5 inline-flex rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
        >
          Start Step 1 study
        </Link>
      </section>

      <aside className="mt-8 rounded-xl bg-[var(--md-surface-container)] p-5">
        <h3 className="font-medium mb-2">Current scope</h3>
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          Step 1 ships with 25 original, redistributable questions in a pinned baseline.
          Coverage counts are descriptive only — MD3 does not estimate a score, pass
          probability, or exam readiness.
        </p>
      </aside>
    </div>
  );
}
