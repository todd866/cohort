'use client';

import Link from 'next/link';
import { useState } from 'react';
import type {
  ClinicalExam,
  ExamPhase,
  ExamPrinciple,
  ExamStep,
} from '@/lib/clinical-exams';

/**
 * Bedside renderer. Deliberately reads as a clinical protocol card, not an app:
 * typographic, high contrast, no progress bars, no scoring, no failure states.
 * The screen may be seen by a parent over your shoulder — nothing on it should
 * be embarrassing.
 */

/** Number steps continuously across phases, without mutating during render. */
function numberPhases(
  phases: ExamPhase[],
  startAt = 0,
): { name: string; steps: (ExamStep & { n: number })[] }[] {
  let n = startAt;
  return phases.map((p) => ({
    name: p.name,
    steps: p.steps.map((s) => {
      n += 1;
      return { ...s, n };
    }),
  }));
}

function Rule({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 mt-8 mb-4 first:mt-0">
      <h2 className="text-[0.7rem] font-bold uppercase tracking-[0.14em] text-[var(--md-on-surface-variant)] whitespace-nowrap">
        {label}
      </h2>
      <span className="h-px flex-1 bg-[var(--md-outline-soft)]" aria-hidden />
    </div>
  );
}

function trackLabel(track: string): string {
  return track.charAt(0).toUpperCase() + track.slice(1);
}

export function ExamProtocol({
  exam,
  principles,
  onBack,
}: {
  exam: ClinicalExam;
  principles?: ExamPrinciple[];
  onBack?: () => void;
}) {
  const phases = numberPhases(exam.phases);
  const tracks = Object.keys(exam.tracks ?? {});
  const lessonTracks = exam.lesson ? Object.keys(exam.lesson.tracks) : [];
  const lessonLinkLabel =
    lessonTracks.length === 1
      ? `Learn ${trackLabel(lessonTracks[0])} visually`
      : 'Learn visually';
  const [selection, setSelection] = useState(() => ({
    examSlug: exam.slug,
    track: tracks[0] ?? '',
  }));
  const selectedTrack =
    selection.examSlug === exam.slug && tracks.includes(selection.track)
      ? selection.track
      : tracks[0] ?? '';

  const sharedStepCount = exam.phases.reduce(
    (count, phase) => count + phase.steps.length,
    0,
  );
  const selectedTrackPhases = selectedTrack
    ? exam.tracks?.[selectedTrack]
    : undefined;
  const numberedTrackPhases = selectedTrackPhases
    ? numberPhases(selectedTrackPhases, sharedStepCount)
    : [];

  return (
    <div className="mx-auto max-w-2xl px-5 py-6 pb-28 md:pb-10">
      {/* Header */}
      <header className="mb-6">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="min-h-11 text-xs text-[var(--md-on-surface-variant)] hover:underline"
          >
            ← Protocols
          </button>
        ) : (
          <Link
            href="/exams"
            className="inline-flex min-h-11 items-center text-xs text-[var(--md-on-surface-variant)] hover:underline"
          >
            ← Protocols
          </Link>
        )}
        <h1 className="mt-3 text-[1.75rem] leading-tight font-bold tracking-tight text-[var(--md-on-surface)]">
          {exam.title}
        </h1>
        <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">{exam.subtitle}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {exam.wba.map((w) => (
            <span
              key={w}
              className="rounded border border-[var(--md-outline-soft)] px-2 py-0.5 text-[0.7rem] font-semibold tracking-wide text-[var(--md-on-surface-variant)]"
            >
              {w}
            </span>
          ))}
          <span className="text-[0.7rem] text-[var(--md-on-surface-variant)]">
            ~{exam.durationMin} min
          </span>
        </div>
        {exam.lesson && (
          <Link
            href={`/exams/${exam.slug}/learn`}
            className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--md-primary)] px-3 py-2 text-sm font-semibold text-[var(--md-primary)] transition-colors hover:bg-[var(--md-primary-container)]"
          >
            {lessonLinkLabel}
            <span aria-hidden>→</span>
          </Link>
        )}
      </header>

      {exam.verifyAgainst && (
        <div className="mb-6 rounded-lg border-2 border-[var(--md-error)] p-3">
          <p className="text-[0.7rem] font-bold uppercase tracking-wider text-[var(--md-error)]">
            Confirm locally
          </p>
          <p className="mt-1 text-sm text-[var(--md-on-surface)]">{exam.verifyAgainst}</p>
        </div>
      )}

      {exam.setup && exam.setup.length > 0 && (
        <>
          <Rule label="How it runs" />
          <ul className="space-y-1.5">
            {exam.setup.map((s) => (
              <li key={s} className="flex gap-3 text-[0.95rem] leading-snug text-[var(--md-on-surface)]">
                <span className="text-[var(--md-on-surface-variant)]" aria-hidden>·</span>
                {s}
              </li>
            ))}
          </ul>
        </>
      )}

      {exam.rubricNote && (
        <p className="mt-4 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
          {exam.rubricNote}
        </p>
      )}

      {principles && principles.length > 0 && (
        <>
          <Rule label="Principles" />
          <ul className="space-y-3">
            {principles.map((p) => (
              <li key={p.title}>
                <p className="text-[0.95rem] font-semibold text-[var(--md-on-surface)]">
                  {p.title}
                </p>
                <p className="text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                  {p.detail}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Phases */}
      {phases.map((phase) => (
        <section key={phase.name}>
          <Rule label={phase.name} />
          <ol className="space-y-3.5">
            {phase.steps.map((step) => (
              <li
                key={step.id ?? step.text}
                className={`flex gap-3.5 ${
                  step.critical
                    ? 'border-l-[3px] border-[var(--md-error)] -ml-4 pl-[13px]'
                    : ''
                }`}
              >
                <span
                  className="w-6 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums text-[var(--md-on-surface-variant)]"
                  aria-hidden
                >
                  {step.n}
                </span>
                <div className="min-w-0">
                  <p className="text-[1.02rem] leading-snug text-[var(--md-on-surface)]">
                    {step.text}
                  </p>
                  {step.note && (
                    <p className="mt-1 text-[0.85rem] leading-relaxed text-[var(--md-on-surface-variant)]">
                      {step.note}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}

      {/* Examiner-chosen track. Keep every system one tap away without turning
          the bedside page into three consecutive examinations. */}
      {tracks.length > 0 && (
        <section>
          <div className="mt-10 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-[var(--md-on-surface)]">
                  Examiner-selected system
                </h2>
                <p className="mt-0.5 text-xs text-[var(--md-on-surface-variant)]">
                  Prepare all three. Show the one you are rehearsing or examining.
                </p>
              </div>
              <span className="text-xs font-semibold text-[var(--md-primary)]">
                {trackLabel(selectedTrack)}
              </span>
            </div>
            <div
              className="mt-3 grid grid-cols-3 gap-1 rounded-lg bg-[var(--md-surface-container-high)] p-1"
              role="group"
              aria-label="Choose examination system"
            >
              {tracks.map((track) => {
                const active = track === selectedTrack;
                return (
                  <button
                    key={track}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setSelection({ examSlug: exam.slug, track })
                    }
                    className={`min-h-11 rounded-md px-2 py-2 text-xs font-semibold transition-colors ${
                      active
                        ? 'bg-[var(--md-surface-container-lowest)] text-[var(--md-on-surface)] shadow-sm'
                        : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)]'
                    }`}
                  >
                    {trackLabel(track)}
                  </button>
                );
              })}
            </div>
          </div>

          {numberedTrackPhases.map((phase) => (
            <div key={phase.name}>
              <Rule label={phase.name} />
              <ol className="space-y-3.5" start={phase.steps[0]?.n}>
                {phase.steps.map((step) => (
                  <li
                    key={step.id ?? step.text}
                    className={`flex gap-3.5 ${
                      step.critical
                        ? 'border-l-[3px] border-[var(--md-error)] -ml-4 pl-[13px]'
                        : ''
                    }`}
                  >
                    <span
                      className="w-6 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums text-[var(--md-on-surface-variant)]"
                      aria-hidden
                    >
                      {step.n}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[1.02rem] leading-snug text-[var(--md-on-surface)]">
                        {step.text}
                      </p>
                      {step.note && (
                        <p className="mt-1 text-[0.85rem] leading-relaxed text-[var(--md-on-surface-variant)]">
                          {step.note}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      )}

      {exam.rubricSource && (
        <p className="mt-10 border-t border-[var(--md-outline-soft)] pt-4 text-xs leading-relaxed text-[var(--md-on-surface-variant)]">
          Authored directly from: {exam.rubricSource}
        </p>
      )}

      {/* Discriminator */}
      {exam.keyDiscriminator && (
        <>
          <Rule label={exam.keyDiscriminator.title} />
          {exam.keyDiscriminator.innocentMnemonic && (
            <p className="mb-3 text-sm leading-relaxed text-[var(--md-on-surface)]">
              {exam.keyDiscriminator.innocentMnemonic}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-[var(--md-outline-soft)] p-3">
              <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-wider text-[var(--md-on-surface-variant)]">
                Innocent
              </p>
              <ul className="space-y-1">
                {exam.keyDiscriminator.innocent.map((i) => (
                  <li key={i} className="text-sm text-[var(--md-on-surface)]">
                    {i}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border-2 border-[var(--md-error)] p-3">
              <p className="mb-2 text-[0.7rem] font-bold uppercase tracking-wider text-[var(--md-error)]">
                Pathological
              </p>
              <ul className="space-y-1">
                {exam.keyDiscriminator.pathological.map((i) => (
                  <li key={i} className="text-sm text-[var(--md-on-surface)]">
                    {i}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}

      {/* Narration */}
      {exam.sayThis && exam.sayThis.length > 0 && (
        <>
          <Rule label="Present it like this" />
          {exam.sayThis.map((s) => (
            <blockquote
              key={s}
              className="border-l-[3px] border-[var(--md-primary)] pl-4 text-[0.98rem] leading-relaxed text-[var(--md-on-surface)]"
            >
              {s}
            </blockquote>
          ))}
          <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
            Square brackets are the slots you fill.
          </p>
        </>
      )}

      {/* Red flags */}
      {exam.redFlags && exam.redFlags.length > 0 && (
        <>
          <Rule label="Red flags" />
          <ul className="space-y-1.5">
            {exam.redFlags.map((f) => (
              <li key={f} className="flex gap-3 text-[0.98rem] text-[var(--md-on-surface)]">
                <span className="text-[var(--md-error)]" aria-hidden>
                  ▲
                </span>
                {f}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
