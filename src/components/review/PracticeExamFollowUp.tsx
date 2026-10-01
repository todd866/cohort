'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PracticeReviewMissedQuestion, PracticeReviewProvenance } from '@/lib/study/practice-review-focus';

function stageLabel(stage: PracticeReviewProvenance['stage'], priority: PracticeReviewProvenance['priority']): string {
  if (stage === 'exact-retest') return 'Try this question again';
  if (stage === 'prerequisite') return 'Review the key idea first';
  if (stage === 'transfer') return 'Try the same decision in a new case';
  return priority === 'wrong' ? 'Missed topic' : 'Unanswered topic';
}

function readableMiss(missed: PracticeReviewMissedQuestion | undefined): PracticeReviewMissedQuestion | null {
  if (!missed || missed.options.length < 2 || missed.options.length > 8) return null;
  if (!Number.isInteger(missed.selectedIndex) || missed.selectedIndex < 0 || missed.selectedIndex >= missed.options.length) return null;
  if (missed.options.some(option => option.trim().length === 0) || missed.stem.trim().length === 0) return null;
  const figure = missed.promptFigure;
  if (figure && !/^\/practice-exam-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(figure.src)) return { ...missed, promptFigure: undefined };
  return missed;
}

const LABEL = 'Exam follow-up';

export function PracticeExamFollowUp({ provenance, compact = false }: { provenance?: PracticeReviewProvenance; compact?: boolean }) {
  const missed = readableMiss(provenance?.source?.missed);
  const source = provenance?.source;
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!provenance) return null;
  const stage = stageLabel(provenance.stage, provenance.priority);
  const className = `inline-flex min-h-6 items-center font-medium text-[var(--md-primary)] ${compact ? 'text-xs' : 'text-sm'} leading-5`;
  const heading = source ? `${source.paperTitle} · Question ${source.questionNumber}` : LABEL;
  return (
    <aside aria-label="Practice exam follow-up" title={stage} className="text-[var(--md-on-surface-variant)]">
      {missed ? (
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          title={heading}
          className={`${className} underline decoration-[var(--md-outline-variant)] underline-offset-2 hover:text-[var(--md-primary)]`}
          onClick={() => setOpen(value => !value)}
        >
          {LABEL}
        </button>
      ) : <span className={className}>{LABEL}</span>}
      <span className="sr-only">{stage}</span>
      {missed && open && (
        <div
          ref={panelRef}
          id={panelId}
          role="region"
          tabIndex={-1}
          aria-label={heading}
          className="mt-2 max-h-[min(50vh,24rem)] overflow-y-auto rounded-lg border p-3 outline-none"
          style={{ borderColor: 'var(--md-outline-variant)', background: 'var(--md-surface-container-low)' }}
        >
          <p className="text-sm font-medium text-[var(--md-on-surface)]">{heading}</p>
          {missed.promptFigure && (
            <img
              src={missed.promptFigure.src}
              alt={missed.promptFigure.alt}
              width={missed.promptFigure.width}
              height={missed.promptFigure.height}
              className="mt-2 h-auto max-h-48 w-full rounded-md object-contain"
            />
          )}
          <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--md-on-surface)]">{missed.stem}</p>
          <ol className="mt-2 space-y-1">
            {missed.options.map((text, index) => {
              const chosen = index === missed.selectedIndex;
              return (
                <li
                  key={index}
                  className="rounded-md px-2 py-1 text-sm text-[var(--md-on-surface)]"
                  style={chosen ? { background: 'var(--md-surface-container-high)' } : undefined}
                >
                  <span className="font-medium">{String.fromCharCode(65 + index)}.</span> {text}
                  {chosen && <span className="ml-2 text-xs text-[var(--md-on-surface-variant)]">Your answer</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </aside>
  );
}
