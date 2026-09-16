'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CLIENT_FETCH_DEADLINE_MS,
  STUDY_SESSION_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { CheckIcon, XIcon, ChevronIcon } from '@/components/content/mcq-icons';
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
  const [loadError, setLoadError] = useState<'retry' | 'restart' | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [index, setIndex] = useState(0);
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [skipSelected, setSkipSelected] = useState(false);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [expandedOptions, setExpandedOptions] = useState<Set<string>>(new Set());
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
  const sessionRequest = useRef<{ mode: Step1SessionMode; serveRequestId: string } | null>(null);

  const item = session?.items[index] ?? null;

  const resetAnswerState = useCallback(() => {
    setSelectedLabel(null);
    setSkipSelected(false);
    setConfidence(null);
    setExpandedOptions(new Set());
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
    setLoadError(null);
    setSession(null);
    setIndex(0);
    setComplete(false);
    resetAnswerState();

    if (!sessionRequest.current || sessionRequest.current.mode !== mode) {
      sessionRequest.current = { mode, serveRequestId: crypto.randomUUID() };
    }
    void fetchWithDeadline('/api/usmle/step1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sessionRequest.current, size: 10 }),
      cache: 'no-store',
      signal: controller.signal,
    }, STUDY_SESSION_FETCH_DEADLINE_MS)
      .then(async (response) => {
        if (controller.signal.aborted) return null;
        if (!response.ok) {
          if ([400, 409, 410].includes(response.status)) {
            setLoadError('restart');
            return null;
          }
          throw new Error('Session request failed');
        }
        return response.json() as Promise<Step1SessionResult>;
      })
      .then((body) => {
        if (controller.signal.aborted || !body) return;
        if (!Array.isArray(body.items)) throw new Error('Invalid session response');
        setSession(body);
        if (body.items.length === 0) setComplete(true);
        startedAt.current = Date.now();
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setLoadError('retry');
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

  const hasChoice = selectedLabel != null || skipSelected;
  const canSubmit = !!item
    && hasChoice
    && !reveal
    && answerError !== 'terminal'
    && !submitting;

  /** Confidence IS the grade, as it is on md3.info: pressing it submits the
   *  answer and reveals. It is still captured pre-reveal, so the calibration
   *  contract in the FOSS slice design is unchanged — only the gate is gone. */
  const submitAnswer = useCallback(async (grade?: number) => {
    const level = grade ?? confidence;
    if (!item || level == null || (!selectedLabel && !skipSelected) || reveal || submitting) {
      return;
    }
    setConfidence(level);
    setSubmitting(true);
    setAnswerError(null);
    const payload = pendingAnswer.current ?? {
      deliveryId: item.deliveryId,
      selectedDisplayLabel: skipSelected ? null : selectedLabel,
      responseTimeMs: Math.max(0, Date.now() - startedAt.current),
      confidence: level,
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
      if (/^[1-4]$/.test(event.key) && canSubmit) {
        event.preventDefault();
        void submitAnswer(Number(event.key));
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
            rotation: 'usmle-step1-open',
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
            {loadError === 'restart'
              ? 'This session is no longer available. Start a new session with currently eligible questions.'
              : `No answer was recorded. Retry the same ${mode} request.`}
          </p>
          <button
            type="button"
            onClick={() => {
              if (loadError === 'restart') sessionRequest.current = null;
              setLoadKey((key) => key + 1);
            }}
            className="mt-4 rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-on-primary)]"
          >
            {loadError === 'restart' ? 'Start new session' : 'Retry session'}
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

        <fieldset className="mt-6 space-y-2" disabled={submitting || answerError === 'terminal'}>
          <legend className="sr-only">Choose one answer</legend>
          {item.options.map((option) => {
            const selected = selectedLabel === option.label;
            const correct = reveal?.correctDisplayLabel === option.label;
            const wrongSelection = !!reveal && selected && !correct;
            const rationale = explanationByLabel.get(option.label);
            const rationaleText = reveal && rationale
              ? [rationale.explanation, rationale.misconception].filter(Boolean).join(' ')
              : '';
            const expanded = expandedOptions.has(option.label);

            // Post-reveal the card becomes the disclosure for its own rationale,
            // which is md3's pattern — read the ones you got wrong, skip the rest.
            let optionClass = 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/90';
            let labelClass = 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';
            if (correct) {
              optionClass = 'border-[var(--md-success)]/55 bg-[var(--md-success-container)]/45';
              labelClass = 'bg-[var(--md-success)] text-[var(--md-on-success)]';
            } else if (wrongSelection) {
              optionClass = 'border-[var(--md-error)]/55 bg-[var(--md-error-container)]/45';
              labelClass = 'bg-[var(--md-error)] text-[var(--md-on-error)]';
            } else if (selected) {
              optionClass = 'border-[var(--md-primary)] bg-[var(--md-primary-container)]/40';
              labelClass = 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]';
            } else if (!reveal) {
              optionClass += ' hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30';
            }

            return (
              <div key={option.label}>
                <button
                  type="button"
                  onClick={() => {
                    if (!reveal) chooseOption(option.label);
                    else if (rationaleText) {
                      setExpandedOptions((current) => {
                        const next = new Set(current);
                        if (!next.delete(option.label)) next.add(option.label);
                        return next;
                      });
                    }
                  }}
                  disabled={!!reveal && !rationaleText}
                  aria-label={`${option.label}. ${option.text}`}
                  aria-pressed={!reveal ? selected : undefined}
                  aria-expanded={reveal && rationaleText ? expanded : undefined}
                  className={`review-choice group flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-all ${optionClass}`}
                >
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs transition-colors ${labelClass}`}>
                    {option.label}
                  </span>
                  <span className="min-w-0 flex-1 pt-0.5">
                    {option.text}
                    {correct && <CheckIcon className="ml-1 inline-block h-4 w-4 align-text-bottom text-[var(--md-success)]" />}
                    {wrongSelection && <XIcon className="ml-1 inline-block h-4 w-4 align-text-bottom text-[var(--md-error)]" />}
                    {reveal && rationaleText && (
                      <ChevronIcon
                        className={`ml-2 inline-block h-4 w-4 align-text-bottom text-[var(--md-on-surface-variant)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                      />
                    )}
                  </span>
                </button>
                {reveal && rationaleText && expanded && (
                  <div className="mt-1 ml-10 mr-2 rounded-lg bg-[var(--md-surface-container)] px-3 py-2 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                    {rationaleText}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>

        {!reveal && (
          <section className="mt-6">
            {!hasChoice && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-[var(--md-on-surface-variant)] opacity-70">
                  pick an answer, then rate how well you knew it
                </p>
                <button
                  type="button"
                  onClick={chooseSkip}
                  className="rounded-full border border-[var(--md-outline-variant)] px-4 py-2 text-sm text-[var(--md-on-surface-variant)] hover:border-[var(--md-primary)]"
                >
                  Skip this question
                </button>
              </div>
            )}

            {answerError === 'retry' && (
              <div role="alert" className="mt-4 rounded-xl border border-[var(--md-error)] p-4 text-sm">
                <p className="text-[var(--md-error)]">
                  Your answer could not be confirmed. Retry to safely replay the same delivery.
                </p>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitAnswer()}
                  className="mt-3 rounded-full bg-[var(--md-primary)] px-5 py-2.5 font-semibold text-[var(--md-on-primary)] disabled:opacity-40"
                >
                  {submitting ? 'Recording…' : 'Retry answer'}
                </button>
              </div>
            )}
            {answerError === 'terminal' && (
              <div role="alert" className="mt-4 rounded-xl border border-[var(--md-error)] p-4 text-sm">
                <p className="text-[var(--md-error)]">
                  This delivery can no longer be graded safely. Return to Step 1 and start a fresh session.
                </p>
                <Link href="/usmle/step1" className="mt-3 inline-block font-semibold text-[var(--md-primary)] underline">
                  Return to Step 1
                </Link>
              </div>
            )}

            {hasChoice && !answerError && (
              <>
                <p className="text-center text-xs text-[var(--md-on-surface-variant)] opacity-70">
                  how well did you know it? 1 guessing → 4 certain
                </p>
                {/* Fixed footer, so reserve its height rather than let it cover the options. */}
                <div aria-hidden className="h-24" />
              </>
            )}
          </section>
        )}

        {!reveal && hasChoice && !answerError && (
          <ConfidenceButtons
            mode="footer"
            onSelect={(level) => void submitAnswer(level)}
            selected={confidence}
            status={submitting ? 'saving' : 'idle'}
          />
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
