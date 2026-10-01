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

function primaryStudyHref(progress: Step1Progress): string {
  if (progress.nextAction === 'baseline') {
    return '/usmle/step1/study?mode=baseline';
  }
  return '/usmle/step1/study?mode=daily';
}

function primaryStudyLabel(progress: Step1Progress): string {
  if (progress.nextAction === 'baseline') {
    return progress.baseline.attempted > 0 ? 'Continue baseline' : 'Start baseline';
  }
  if (progress.nextAction === 'done-for-today') {
    return 'Practice more';
  }
  return 'Start daily session';
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
    <main className="mx-auto max-w-xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-[var(--md-on-surface)]">
          USMLE Step 1 preparation
        </h1>
        <p className="mt-2 text-[var(--md-on-surface-variant)]">
          Practise exam concepts, understand the reasoning, and revisit weak areas.
          {' '}
          <Link href="/auth/signin" className="underline underline-offset-2">
            Sign in
          </Link>
          {' '}
          to keep progress.
        </p>
      </header>

      {error ? (
        <section role="alert" className="space-y-3">
          <h2 className="font-semibold text-[var(--md-on-surface)]">
            We could not load your Step 1 progress.
          </h2>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Nothing was changed. Check your connection and try again.
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-full bg-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-[var(--md-on-primary)]"
          >
            Retry progress
          </button>
        </section>
      ) : progress ? (
        <>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            {progress.baseline.attempted}/{progress.baseline.total} baseline
            {' · '}
            {progress.activity.todayAttempts} today
            {' · '}
            {progress.corpus.eligible} practice questions
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link
              href={primaryStudyHref(progress)}
              className="inline-flex rounded-full bg-[var(--md-primary)] px-5 py-2.5 text-sm font-semibold text-[var(--md-on-primary)]"
            >
              {primaryStudyLabel(progress)}
            </Link>
            {progress.nextAction === 'baseline' ? (
              <Link
                href="/usmle/step1/study?mode=daily"
                className="text-sm font-medium text-[var(--md-primary)] underline underline-offset-2"
              >
                Daily session
              </Link>
            ) : progress.nextAction !== 'done-for-today' ? (
              <Link
                href="/usmle/step1/study?mode=baseline"
                className="text-sm font-medium text-[var(--md-primary)] underline underline-offset-2"
              >
                Baseline
              </Link>
            ) : null}
          </div>

          {progress.domains.length > 0 ? (
            <details className="mt-10 group">
              <summary className="cursor-pointer list-none text-sm font-medium text-[var(--md-on-surface)] marker:content-none [&::-webkit-details-marker]:hidden">
                <span className="underline underline-offset-2 group-open:no-underline">
                  Coverage by domain
                </span>
                <span className="ml-2 font-normal text-[var(--md-on-surface-variant)]">
                  {progress.coverage.unseen} unseen
                </span>
              </summary>
              <ul className="mt-4 space-y-2 text-sm text-[var(--md-on-surface-variant)]">
                {progress.domains.map((domain) => (
                  <li
                    key={domain.domain}
                    className="flex justify-between gap-4 border-b border-[var(--md-outline-variant)]/60 py-1.5"
                  >
                    <span className="text-[var(--md-on-surface)]">{domainLabel(domain.domain)}</span>
                    <span>
                      {domain.attempted}/{domain.eligible}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {progress.limitations.length > 0 ? (
            <p className="mt-10 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
              {progress.limitations.join(' ')}
            </p>
          ) : null}
        </>
      ) : (
        <p aria-live="polite" className="text-sm text-[var(--md-on-surface-variant)]">
          Loading…
        </p>
      )}
    </main>
  );
}
