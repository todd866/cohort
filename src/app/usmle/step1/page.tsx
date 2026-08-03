'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Step1Progress } from '@/lib/usmle/step1-contract';

function domainLabel(domain: string): string {
  const raw = domain.split('/').at(-1) ?? domain;
  return raw
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function USMLEStep1Page() {
  const [progress, setProgress] = useState<Step1Progress | null>(null);
  const [error, setError] = useState(false);
  const [requestKey, setRequestKey] = useState(0);

  const retry = useCallback(() => {
    setError(false);
    setProgress(null);
    setRequestKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    void fetch(`/api/usmle/step1/progress?tz=${encodeURIComponent(timezone)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Progress request failed');
        return response.json() as Promise<Step1Progress>;
      })
      .then((body) => {
        setProgress(body);
        setError(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(true);
      });

    return () => controller.abort();
  }, [requestKey]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-8 max-w-3xl">
        <p className="mb-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--md-primary)]">
          Open Step 1 — cited MCQs
        </p>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Build durable recall, one cited MCQ at a time.
        </h1>
        <p className="mt-3 text-[var(--md-on-surface-variant)]">
          25 original, redistributable MCQs with a visible source trail after every answer.
          Blueprint coverage is incomplete. Progress is descriptive only — not a score or pass
          prediction. Study as a guest, or{' '}
          <Link href="/auth/signin" className="underline underline-offset-2">
            sign in
          </Link>{' '}
          to keep progress.
        </p>
      </header>

      {error ? (
        <section
          role="alert"
          className="rounded-2xl border border-[var(--md-error)] p-5"
        >
          <h2 className="font-semibold">We could not load your Step 1 progress.</h2>
          <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
            Nothing was changed. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={retry}
            className="mt-4 rounded-full bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-[var(--md-on-primary)]"
          >
            Retry progress
          </button>
        </section>
      ) : progress ? (
        <>
          <section aria-label="Step 1 progress" className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-[var(--md-outline-variant)] p-5">
              <p className="text-2xl font-bold">{progress.corpus.eligible} open questions</p>
              <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                Passed the public provenance gate
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--md-outline-variant)] p-5">
              <p className="text-2xl font-bold">
                {progress.baseline.attempted} of {progress.baseline.total} attempted
              </p>
              <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                {progress.baseline.remaining} remain in baseline v1
              </p>
            </div>
            <div className="rounded-2xl border border-[var(--md-outline-variant)] p-5">
              <p className="text-2xl font-bold">{progress.activity.todayAttempts} today</p>
              <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                {progress.activity.recent7dAttempts} attempts in the past 7 days
              </p>
            </div>
          </section>

          <section className="mt-6 grid gap-4 md:grid-cols-2">
            <article className="rounded-2xl bg-[var(--md-primary-container)] p-6 text-[var(--md-on-primary-container)]">
              <p className="text-sm font-semibold uppercase tracking-wide">Fixed starting point</p>
              <h2 className="mt-2 text-2xl font-bold">Baseline v1</h2>
              <p className="mt-2 text-sm">
                Work through the same pinned set once. This records coverage only—it is not a
                simulated exam or score prediction.
              </p>
              <Link
                href="/usmle/step1/study?mode=baseline"
                className="mt-5 inline-flex rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-on-primary)]"
              >
                {progress.baseline.attempted > 0 ? 'Continue baseline' : 'Start baseline'}
              </Link>
            </article>

            <article className="rounded-2xl border border-[var(--md-outline-variant)] p-6">
              <p className="text-sm font-semibold uppercase tracking-wide text-[var(--md-primary)]">Ongoing practice</p>
              <h2 className="mt-2 text-2xl font-bold">Daily session</h2>
              <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
                A short set of up to {progress.dailyTarget} eligible questions, favoring unseen
                material and then recent gaps.
              </p>
              <Link
                href="/usmle/step1/study?mode=daily"
                className="mt-5 inline-flex rounded-full border border-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-primary)]"
              >
                Start daily session
              </Link>
            </article>
          </section>

          <section className="mt-8">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-xl font-bold">Coverage by domain</h2>
                <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                  Descriptive counts from the current open corpus.
                </p>
              </div>
              <p className="text-sm text-[var(--md-on-surface-variant)]">
                {progress.coverage.unseen} unseen overall
              </p>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {progress.domains.map((domain) => {
                const percent = domain.eligible === 0
                  ? 0
                  : Math.round((domain.attempted / domain.eligible) * 100);
                return (
                  <article
                    key={domain.domain}
                    className="rounded-xl border border-[var(--md-outline-variant)] p-4"
                  >
                    <div className="flex justify-between gap-3">
                      <h3 className="font-semibold">{domainLabel(domain.domain)}</h3>
                      <span className="text-sm text-[var(--md-on-surface-variant)]">
                        {domain.attempted}/{domain.eligible}
                      </span>
                    </div>
                    <div
                      className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--md-surface-container-high)]"
                      role="progressbar"
                      aria-label={`${domainLabel(domain.domain)} coverage`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent}
                    >
                      <div
                        className="h-full rounded-full bg-[var(--md-primary)]"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <aside className="mt-8 rounded-xl bg-[var(--md-surface-container)] p-5">
            <h2 className="font-semibold">What these numbers mean</h2>
            <ul className="mt-2 space-y-1 text-sm text-[var(--md-on-surface-variant)]">
              {progress.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </aside>
        </>
      ) : (
        <section aria-live="polite" className="rounded-2xl border border-[var(--md-outline-variant)] p-6">
          <p className="font-medium">Loading your Step 1 workspace…</p>
        </section>
      )}
    </main>
  );
}
