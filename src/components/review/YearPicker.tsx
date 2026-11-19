'use client';

import { useState } from 'react';
import { fetchWithDeadline, CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import { SCHEDULED_ROTATIONS } from '@/lib/institution-rotations';
import { STUDY_YEARS, YEAR_LABEL, yearNeedsRotation, type StudyYear } from '@/lib/onboarding/study-year';
import { RotationOnboarding } from './RotationOnboarding';

/**
 * Height the band holds from first paint. The learner's own year read arrives
 * after the first card, so a still-unknown first-run state reserves this space
 * (YearPickerSpace) and the card never moves when the band replaces it.
 */
export const YEAR_BAND_MIN_H = 'min-h-[108px] md:min-h-[61px]';

export function YearPickerSpace() {
  return <div aria-hidden data-testid="year-picker-space" className={`mx-auto w-full max-w-5xl border-b border-transparent ${YEAR_BAND_MIN_H}`} />;
}

interface YearPickerProps {
  /** Called after the choice is saved server-side. The review reloads on it. */
  onDone: () => void;
  /** Hide the picker for this visit (the describe path was submitted or skipped). */
  onDismiss: () => void;
  /** The rotations MD3 and MD4 choose between. Defaults to the four scheduled blocks. */
  rotations?: string[];
}

/**
 * First-run "which year are you in" band for anyone with no enrolment, signed in
 * or guest. One row of choices; MD3 and MD4 swap it in place for the rotation
 * row (the existing chooser, one-row layout); MD1 and MD2 save on the tap.
 * "something else" opens the existing describe-your-course form.
 */
export function YearPicker({ onDone, onDismiss, rotations = SCHEDULED_ROTATIONS.usyd }: YearPickerProps) {
  const [year, setYear] = useState<StudyYear | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [saving, setSaving] = useState<StudyYear | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guest MD1: the year is saved, the main deck needs a signed-in account.
  // One line, Sign in and Continue.
  const [notice, setNotice] = useState(false);

  const choose = async (next: StudyYear) => {
    if (saving) return;
    setError(null);
    if (yearNeedsRotation(next)) {
      setYear(next);
      return;
    }
    setSaving(next);
    try {
      const res = await fetchWithDeadline('/api/user/rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: next }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => null) as { missingDeck?: unknown } | null;
      if (body?.missingDeck) {
        setNotice(true);
        setSaving(null);
        return;
      }
      onDone();
    } catch {
      setError('Could not save your choice — check your connection and tap again.');
      setSaving(null);
    }
  };

  return (
    <section
      aria-label="Which year are you in?"
      className={`mx-auto flex w-full max-w-5xl flex-col justify-center border-b border-[var(--md-outline-variant)] px-4 py-2 ${YEAR_BAND_MIN_H}`}
    >
      {notice ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex-1 text-sm text-[var(--md-on-surface)]">
            MD1 saved. Sign in to unlock the main MD1 deck.
          </span>
          <a
            href="/auth/signin"
            className="inline-flex min-h-11 items-center rounded-xl border border-[var(--md-outline-variant)] px-4 text-sm font-medium text-[var(--md-on-surface)]"
          >
            Sign in
          </a>
          <button
            type="button"
            onClick={onDone}
            className="inline-flex min-h-11 items-center rounded-xl bg-[var(--md-primary)] px-4 text-sm font-medium text-[var(--md-on-primary)]"
          >
            Continue ›
          </button>
        </div>
      ) : elsewhere ? (
        <RotationOnboarding
          describeOnly
          rotations={rotations}
          onDone={onDone}
          onSkip={onDismiss}
        />
      ) : year ? (
        <RotationOnboarding
          layout="row"
          year={year}
          rotations={rotations}
          onDone={onDone}
          onBack={() => setYear(null)}
          onSomethingElse={() => setElsewhere(true)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex-1 text-sm font-medium text-[var(--md-on-surface)] md:flex-none">
            Which year are you in?
          </span>
          <button
            type="button"
            onClick={() => setElsewhere(true)}
            disabled={saving !== null}
            className="inline-flex min-h-11 items-center text-sm text-[var(--md-on-surface-variant)] underline-offset-2 hover:underline disabled:opacity-60 md:order-3"
          >
            something else ›
          </button>
          <div role="group" aria-label="Year" className="grid w-full grid-cols-4 gap-2 md:order-2 md:w-auto">
            {STUDY_YEARS.map((value) => (
              <button
                key={value}
                type="button"
                disabled={saving !== null}
                onClick={() => void choose(value)}
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] px-4 text-sm font-medium text-[var(--md-on-surface)] transition-colors hover:bg-[var(--md-surface-container-high)] disabled:opacity-60"
              >
                {YEAR_LABEL[value]}{saving === value ? '…' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p className="mt-2 text-sm text-[var(--md-error)]" role="alert">{error}</p>
      )}
    </section>
  );
}
