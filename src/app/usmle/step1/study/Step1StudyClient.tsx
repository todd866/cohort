'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';
import type {
  Step1AnswerResponse,
  Step1AnswerReveal,
  Step1SessionMode,
  Step1SessionResult,
} from '@/lib/usmle/step1-contract';

interface PendingAnswer {
  deliveryId: string;
  selectedDisplayLabel: string | null;
  responseTimeMs: number;
  confidence: number;
}

const CONFIDENCE_LEVELS = [
  { value: 1, label: 'Guessing' },
  { value: 2, label: 'Unsure' },
  { value: 3, label: 'Fairly sure' },
  { value: 4, label: 'Certain' },
] as const;

function shortDomain(domain: string): string {
  const segment = domain.split('/').at(-1) ?? domain;
  return segment.charAt(0).toUpperCase() + segment.slice(1).replaceAll('-', ' ');
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

export default function Step1StudyClient({ mode }: { mode: Step1SessionMode }) {
  const [session, setSession] = useState<Step1SessionResult | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadKey, setLoadKey] = useState(0);
  const [index, setIndex] = useState(0);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [skipSelected, setSkipSelected] = useState(false);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [reveal, setReveal] = useState<Step1AnswerReveal | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [answerError, setAnswerError] = useState<'retry' | 'terminal' | null>(null);
  const [complete, setComplete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('Incorrect');
  const [reportMessage, setReportMessage] = useState('');
  const [reportState, setReportState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const startedAt = useRef(Date.now());
  const pendingAnswer = useRef<PendingAnswer | null>(null);

  const item = session?.items[index] ?? null;

  const resetAnswerState = useCallback(() => {
    setSelectedLabel(null);
    setSkipSelected(false);
    setConfidence(null);
    setReveal(null);
    setAnswerError(null);
    setReportOpen(false);
    setReportReason('Incorrect');
    setReportMessage('');
    setReportState('idle');
    pendingAnswer.current = null;
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(false);
    setSession(null);
    setIndex(0);
    setComplete(false);
    resetAnswerState();

    void fetch(`/api/usmle/step1/session?mode=${mode}&size=10`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Session request failed');
        return response.json() as Promise<Step1SessionResult>;
      })
      .then((body) => {
        if (!Array.isArray(body.items)) throw new Error('Invalid session response');
        setSession(body);
        if (body.items.length === 0) setComplete(true);
        startedAt.current = Date.now();
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadError(true);
      });

    return () => controller.abort();
  }, [loadKey, mode, resetAnswerState]);

  const chooseOption = useCallback((label: string) => {
    if (reveal || submitting || answerError) return;
    setSelectedLabel(label);
    setSkipSelected(false);
  }, [answerError, reveal, submitting]);

  const chooseSkip = useCallback(() => {
    if (reveal || submitting || answerError) return;
    setSelectedLabel(null);
    setSkipSelected(true);
  }, [answerError, reveal, submitting]);

  const canSubmit = !!item
    && confidence != null
    && (selectedLabel != null || skipSelected)
    && !reveal
    && answerError !== 'terminal'
    && !submitting;

  const submitAnswer = useCallback(async () => {
    if (!item || confidence == null || (!selectedLabel && !skipSelected) || reveal || submitting) {
      return;
    }
    setSubmitting(true);
    setAnswerError(null);
    const payload = pendingAnswer.current ?? {
      deliveryId: item.deliveryId,
      selectedDisplayLabel: skipSelected ? null : selectedLabel,
      responseTimeMs: Math.max(0, Date.now() - startedAt.current),
      confidence,
    };
    pendingAnswer.current = payload;
    try {
      const response = await fetchWithDeadline('/api/usmle/step1/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!response.ok) {
        setAnswerError([400, 404, 409, 410].includes(response.status) ? 'terminal' : 'retry');
        return;
      }
      const body = await response.json() as Partial<Step1AnswerResponse>;
      if (!body.answer || body.answer.deliveryId !== item.deliveryId) {
        throw new Error('Invalid answer response');
      }
      setReveal(body.answer);
    } catch {
      setAnswerError('retry');
    } finally {
      setSubmitting(false);
    }
  }, [confidence, item, reveal, selectedLabel, skipSelected, submitting]);

  const nextQuestion = useCallback(() => {
    if (!reveal || !session) return;
    if (index + 1 >= session.items.length) {
      setComplete(true);
      return;
    }
    setIndex((current) => current + 1);
    resetAnswerState();
  }, [index, resetAnswerState, reveal, session]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || complete || loadError) return;
      if (reveal) {
        if (event.key === 'Enter') {
          event.preventDefault();
          nextQuestion();
        }
        return;
      }
      const normalized = event.key.toUpperCase();
      if (item?.options.some((option) => option.label === normalized)) {
        event.preventDefault();
        chooseOption(normalized);
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        event.preventDefault();
        setConfidence(Number(event.key));
        return;
      }
      if (event.key === 'Enter' && canSubmit) {
        event.preventDefault();
        void submitAnswer();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSubmit, chooseOption, complete, item, loadError, nextQuestion, reveal, submitAnswer]);

  const submitReport = useCallback(async () => {
    if (!reveal || reportState === 'sending' || reportState === 'sent') return;
    setReportState('sending');
    try {
      const response = await fetchWithDeadline('/api/content/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'question',
          id: reveal.questionId,
          reason: reportReason,
          ...(reportMessage.trim() ? { message: reportMessage.trim() } : {}),
          context: {
            path: `/usmle/step1/study?mode=${mode}`,
            rotation: 'usmle-step1',
            componentType: 'step1-study',
          },
          clientRequestId: `usmle:${reveal.deliveryId}:report`,
        }),
      }, CLIENT_FETCH_DEADLINE_MS);
      if (!response.ok) throw new Error('Report request failed');
      setReportState('sent');
    } catch {
      setReportState('error');
    }
  }, [mode, reportMessage, reportReason, reportState, reveal]);

  if (loadError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <section role="alert" className="rounded-2xl border border-[var(--md-error)] p-6">
          <h1 className="text-xl font-bold">We could not build this session.</h1>
          <p className="mt-2 text-sm text-[var(--md-on-surface-variant)]">
            No answer was recorded. Retry the same {mode} request.
          </p>
          <button
            type="button"
            onClick={() => setLoadKey((key) => key + 1)}
            className="mt-4 rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-on-primary)]"
          >
            Retry session
          </button>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6" aria-live="polite">
        <p className="rounded-2xl border border-[var(--md-outline-variant)] p-6 font-medium">
          Building a cited {mode} session…
        </p>
      </main>
    );
  }

  if (complete || !item) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12 text-center sm:px-6">
        <p className="text-sm font-semibold uppercase tracking-wide text-[var(--md-primary)]">Session complete</p>
        <h1 className="mt-2 text-3xl font-bold">
          {session.items.length === 0 ? 'Nothing is due in this set.' : `You completed ${session.items.length} questions.`}
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[var(--md-on-surface-variant)]">
          Progress is descriptive coverage of the current open corpus, not an exam score or pass prediction.
        </p>
        <Link
          href="/usmle/step1"
          className="mt-6 inline-flex rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-on-primary)]"
        >
          Back to Step 1
        </Link>
      </main>
    );
  }

  const explanationByLabel = new Map(
    reveal?.optionExplanations.map((option) => [option.label, option]) ?? [],
  );

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link href="/usmle/step1" className="font-medium text-[var(--md-primary)]">← Step 1</Link>
        <p className="text-[var(--md-on-surface-variant)]">
          {mode === 'baseline' ? 'Baseline v1' : 'Daily session'} · Question {index + 1} of {session.items.length}
        </p>
      </header>

      <article>
        <div className="flex flex-wrap gap-2 text-xs text-[var(--md-on-surface-variant)]">
          <span className="rounded-full bg-[var(--md-surface-container)] px-2.5 py-1">{shortDomain(item.domain)}</span>
          <span className="rounded-full bg-[var(--md-surface-container)] px-2.5 py-1">{item.questionType}</span>
        </div>
        <h1 className="mt-5 text-xl font-semibold leading-relaxed sm:text-2xl">{item.stem}</h1>

        <fieldset className="mt-6 space-y-3" disabled={!!reveal || submitting || !!answerError}>
          <legend className="sr-only">Choose one answer</legend>
          {item.options.map((option) => {
            const selected = selectedLabel === option.label;
            const correct = reveal?.correctDisplayLabel === option.label;
            const wrongSelection = !!reveal && selected && !correct;
            const rationale = explanationByLabel.get(option.label);
            return (
              <div key={option.label}>
                <button
                  type="button"
                  onClick={() => chooseOption(option.label)}
                  aria-label={`${option.label}. ${option.text}`}
                  aria-pressed={selected}
                  className={`w-full rounded-xl border p-4 text-left transition-colors ${
                    correct
                      ? 'border-[var(--md-success)] bg-[color-mix(in_srgb,var(--md-success)_10%,transparent)]'
                      : wrongSelection
                        ? 'border-[var(--md-error)] bg-[color-mix(in_srgb,var(--md-error)_8%,transparent)]'
                        : selected
                          ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]'
                          : 'border-[var(--md-outline-variant)] hover:border-[var(--md-primary)]'
                  }`}
                >
                  <span className="mr-2 font-bold">{option.label}.</span>
                  {option.text}
                </button>
                {reveal && rationale && (rationale.explanation || rationale.misconception) && (
                  <p className="px-4 pt-2 text-sm text-[var(--md-on-surface-variant)]">
                    {rationale.explanation}
                    {rationale.misconception ? ` ${rationale.misconception}` : ''}
                  </p>
                )}
              </div>
            );
          })}
        </fieldset>

        {!reveal && (
          <section className="mt-7 rounded-2xl bg-[var(--md-surface-container)] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold">How confident are you?</h2>
                <p className="text-sm text-[var(--md-on-surface-variant)]">Required before grading · keys 1–4</p>
              </div>
              <button
                type="button"
                onClick={chooseSkip}
                aria-pressed={skipSelected}
                className={`rounded-full border px-4 py-2 text-sm ${
                  skipSelected ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]' : 'border-[var(--md-outline-variant)]'
                }`}
              >
                Skip this question
              </button>
            </div>
            <div role="group" aria-label="Confidence" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CONFIDENCE_LEVELS.map((level) => (
                <button
                  key={level.value}
                  type="button"
                  aria-label={`Confidence ${level.value}: ${level.label}`}
                  aria-pressed={confidence === level.value}
                  disabled={!!answerError || submitting}
                  onClick={() => setConfidence(level.value)}
                  className={`min-h-12 rounded-lg border px-2 py-2 text-sm ${
                    confidence === level.value
                      ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)] font-semibold'
                      : 'border-[var(--md-outline-variant)]'
                  }`}
                >
                  <span className="block font-bold">{level.value}</span>{level.label}
                </button>
              ))}
            </div>
            {answerError === 'retry' && (
              <p role="alert" className="mt-4 text-sm text-[var(--md-error)]">
                Your answer could not be confirmed. Retry to safely replay the same delivery.
              </p>
            )}
            {answerError === 'terminal' && (
              <p role="alert" className="mt-4 text-sm text-[var(--md-error)]">
                This delivery can no longer be graded safely. Return to Step 1 and start a fresh session.
              </p>
            )}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submitAnswer()}
              className="mt-5 w-full rounded-full bg-[var(--md-primary)] px-5 py-3 font-semibold text-[var(--md-on-primary)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Recording…' : answerError === 'retry' ? 'Retry answer' : 'Check answer'}
            </button>
            {answerError === 'terminal' && (
              <Link href="/usmle/step1" className="mt-3 block text-center text-sm text-[var(--md-primary)] underline">
                Return to Step 1
              </Link>
            )}
          </section>
        )}

        {reveal && (
          <section className="mt-7" aria-live="polite">
            <div className={`rounded-2xl border p-5 ${
              reveal.isCorrect ? 'border-[var(--md-success)]' : 'border-[var(--md-error)]'
            }`}>
              <p className="text-lg font-bold">{reveal.isCorrect ? 'Correct' : `Correct answer: ${reveal.correctDisplayLabel}`}</p>
              {reveal.explanation && <p className="mt-2 leading-relaxed">{reveal.explanation}</p>}
            </div>

            {reveal.citation && (
              <aside className="mt-4 rounded-2xl bg-[var(--md-surface-container)] p-5">
                <p className="text-sm font-semibold uppercase tracking-wide">Evidence trail</p>
                <a
                  href={reveal.citation.canonicalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block font-semibold text-[var(--md-primary)] underline"
                >
                  {reveal.citation.title}
                </a>
                <p className="mt-1 text-sm text-[var(--md-on-surface-variant)]">
                  {reveal.citation.publisher}
                  {reveal.citation.passageLocator ? ` · ${reveal.citation.passageLocator}` : ''}
                </p>
                {reveal.citation.quote && (
                  <blockquote className="mt-3 border-l-2 border-[var(--md-outline)] pl-3 text-sm">
                    “{reveal.citation.quote}”
                  </blockquote>
                )}
                <p className="mt-3 text-sm text-[var(--md-on-surface-variant)]">
                  {reveal.citation.attribution}
                </p>
                <p className="mt-2 text-xs text-[var(--md-on-surface-variant)]">
                  Source licence:{' '}
                  <a href={reveal.citation.licence.url} target="_blank" rel="noopener noreferrer" className="underline">
                    {reveal.citation.licence.id}
                  </a>
                  {' '}· Item text: {reveal.attribution.text}, {reveal.attribution.licence}
                </p>
              </aside>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setReportOpen((open) => !open)}
                className="text-sm text-[var(--md-on-surface-variant)] underline"
              >
                Report an issue
              </button>
              <button
                type="button"
                onClick={nextQuestion}
                className="rounded-full bg-[var(--md-primary)] px-6 py-3 font-semibold text-[var(--md-on-primary)]"
              >
                {index + 1 >= session.items.length ? 'Finish session' : 'Next question'}
              </button>
            </div>

            {reportOpen && (
              <div className="mt-4 rounded-xl border border-[var(--md-outline-variant)] p-4">
                <h2 className="font-semibold">Report this question</h2>
                <label className="mt-3 block text-sm">
                  Issue type
                  <select
                    value={reportReason}
                    onChange={(event) => setReportReason(event.target.value)}
                    disabled={reportState === 'sending' || reportState === 'sent'}
                    className="mt-1 block w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-2"
                  >
                    <option>Incorrect</option>
                    <option>Confusing</option>
                    <option>Outdated</option>
                    <option>Formatting</option>
                    <option>Other</option>
                  </select>
                </label>
                <label className="mt-3 block text-sm">
                  Optional detail
                  <textarea
                    value={reportMessage}
                    onChange={(event) => setReportMessage(event.target.value.slice(0, 1000))}
                    disabled={reportState === 'sending' || reportState === 'sent'}
                    maxLength={1000}
                    rows={3}
                    className="mt-1 block w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-2"
                  />
                </label>
                {reportState === 'sent' ? (
                  <p role="status" className="mt-3 text-sm text-[var(--md-success)]">Report saved. Thank you.</p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void submitReport()}
                    disabled={reportState === 'sending'}
                    className="mt-3 rounded-full border border-[var(--md-primary)] px-4 py-2 text-sm font-semibold text-[var(--md-primary)] disabled:opacity-50"
                  >
                    {reportState === 'sending' ? 'Sending…' : reportState === 'error' ? 'Retry report' : 'Send report'}
                  </button>
                )}
              </div>
            )}
          </section>
        )}
      </article>

      <p className="mt-8 text-xs text-[var(--md-on-surface-variant)]">
        Original item text: {item.attribution.text} · {item.attribution.licence}
      </p>
    </main>
  );
}
