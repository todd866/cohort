'use client';

import { useEffect, useRef, useState } from 'react';
import { GlossaryText } from '../content/GlossaryText';
import { CheckIcon, XIcon, ChevronIcon } from '../content/mcq-icons';
import { InlineMarkdown } from '@/lib/inline-markdown';
import { encodeTypeXAnswer, K_TYPE_KEY, missedStatementsForKType } from '@/lib/question-bank/statement-items';

/**
 * A Type X / NSA Type 1 statement set: four statements, each judged true or
 * false on its own. Before answering, every row asks for a call; after, every
 * row shows its own result in place — the learner's eyes are already there —
 * and the teaching for each statement they got wrong is open, not behind a tap.
 */

interface StatementOption {
  label: string;
  text: string;
  explanation?: string;
}

interface StatementSetViewProps {
  options: StatementOption[];
  result: { isCorrect: boolean; correctOption: string } | null;
  /** The submitted judgements, e.g. 'TFFT'; null when skipped. */
  selectedOption: string | null;
  onSubmit: (judgements: string) => void;
  disabled?: boolean;
}

const verdictButton = 'min-h-10 min-w-16 rounded-lg border px-3 text-sm font-medium transition-colors disabled:opacity-60';

export function StatementSetView({ options, result, selectedOption, onSubmit, disabled = false }: StatementSetViewProps) {
  const [judgements, setJudgements] = useState<Array<boolean | null>>([null, null, null, null]);
  const [submitted, setSubmitted] = useState(false);
  const [toggled, setToggled] = useState<Set<number>>(new Set());
  const marksRef = useRef<HTMLDivElement>(null);
  const revealed = result !== null;

  // "Check answers" sits below the four statements, so on a phone the learner
  // has scrolled down to tap it and the result then opens above the fold. Bring
  // the marks back under the header; never scroll a result that is already in
  // view (the review loop's reveal scroll only ever moves down).
  useEffect(() => {
    const el = marksRef.current;
    if (!revealed || !el || typeof window === 'undefined') return;
    if (el.getBoundingClientRect().top >= 0) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }, [revealed]);

  if (!result) {
    const answer = encodeTypeXAnswer(judgements);
    return (
      <div className="space-y-2">
        {options.map((option, index) => (
          <div
            key={option.label}
            role="group"
            aria-label={`Statement ${index + 1}`}
            className="flex flex-col gap-2 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/90 p-3.5 sm:flex-row sm:items-center"
          >
            <span className="flex min-w-0 flex-1 items-start gap-3">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-surface-container-high)] font-mono text-xs text-[var(--md-on-surface-variant)]">
                {index + 1}
              </span>
              <span className="pt-0.5"><GlossaryText text={option.text} /></span>
            </span>
            <span className="flex shrink-0 gap-2 self-end sm:self-auto">
              {([true, false] as const).map((value) => {
                const chosen = judgements[index] === value;
                return (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={chosen}
                    disabled={disabled || submitted}
                    onClick={() => setJudgements((prev) => prev.map((j, i) => (i === index ? value : j)))}
                    className={`${verdictButton} ${
                      chosen
                        ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)]'
                        : 'border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)] hover:border-[var(--md-primary)]'
                    }`}
                  >
                    {value ? 'True' : 'False'}
                  </button>
                );
              })}
            </span>
          </div>
        ))}
        <button
          type="button"
          disabled={disabled || submitted || answer === null}
          onClick={() => {
            if (answer === null || submitted) return;
            setSubmitted(true);
            onSubmit(answer);
          }}
          className="min-h-11 w-full rounded-lg bg-[var(--md-primary)] px-3 py-2 text-sm font-medium text-[var(--md-on-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Check answers
        </button>
      </div>
    );
  }

  const key = result.correctOption.toUpperCase();
  const given = selectedOption?.toUpperCase() ?? null;
  const missed = options.map((_, index) => given === null || given[index] !== key[index]);
  const marks = missed.filter((m) => !m).length;

  return (
    <div className="space-y-2">
      <div
        ref={marksRef}
        role="status"
        aria-label={`${marks} of 4 statements correct`}
        className={`scroll-mt-24 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-medium ${
          marks === 4
            ? 'bg-[var(--md-success-container)] text-[var(--md-on-success-container)]'
            : 'bg-[var(--md-error-container)] text-[var(--md-on-error-container)]'
        }`}
      >
        {marks === 4 ? <CheckIcon className="h-4 w-4" /> : <XIcon className="h-4 w-4" />} {marks} / 4
      </div>
      {options.map((option, index) => {
        const wrong = missed[index];
        const teaching = option.explanation?.trim() ?? '';
        const open = teaching.length > 0 && (wrong !== toggled.has(index));
        const truth = key[index] === 'T' ? 'True' : 'False';
        return (
          <div key={option.label}>
            <button
              type="button"
              disabled={teaching.length === 0}
              aria-expanded={teaching.length > 0 ? open : undefined}
              onClick={() => setToggled((prev) => {
                const next = new Set(prev);
                if (next.has(index)) next.delete(index); else next.add(index);
                return next;
              })}
              className={`review-choice flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-colors ${
                wrong
                  ? 'border-[var(--md-error)]/55 bg-[var(--md-error-container)]/45'
                  : 'border-[var(--md-success)]/55 bg-[var(--md-success-container)]/45'
              }`}
            >
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs ${
                wrong ? 'bg-[var(--md-error)] text-[var(--md-on-error)]' : 'bg-[var(--md-success)] text-[var(--md-on-success)]'
              }`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 pt-0.5">
                <GlossaryText text={option.text} />
                <span className="ml-2 whitespace-nowrap text-xs font-medium text-[var(--md-on-surface-variant)]">
                  {truth}
                  {wrong && given ? ` · you said ${given[index] === 'T' ? 'true' : 'false'}` : ''}
                </span>
                {teaching.length > 0 && (
                  <ChevronIcon className={`ml-2 inline-block h-4 w-4 align-text-bottom text-[var(--md-on-surface-variant)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                )}
              </span>
            </button>
            {open && (
              <div className="ml-10 mr-2 mt-1 space-y-2 rounded-lg bg-[var(--md-surface-container)] px-3 py-2 text-sm leading-relaxed text-[var(--md-on-surface-variant)]">
                {teaching.split(/\n\s*\n/).map((block, i) => <p key={i}><InlineMarkdown text={block} /></p>)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** NSA Type 2: after a wrong letter, name the statements it misjudged. */
export function KTypeVerdict({ selectedOption, correctOption }: { selectedOption: string | null; correctOption: string }) {
  const correct = K_TYPE_KEY.find((k) => k.label === correctOption.trim().toUpperCase());
  if (!correct) return null;
  const missed = missedStatementsForKType(correct.pattern, selectedOption);
  if (missed.length === 0) return null;
  const names = missed.map((i) => String(i + 1));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return (
    <p className="text-sm font-medium text-[var(--md-on-error-container)]">
      {selectedOption ? `Your answer misjudged statement${names.length === 1 ? '' : 's'} ${list}.` : `Statements ${list} are explained below.`}
    </p>
  );
}
