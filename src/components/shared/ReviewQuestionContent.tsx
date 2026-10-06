'use client';

import type { ReactNode } from 'react';
import { REVIEW_PANE_CELL_FLAT, REVIEW_PANE_MEDIA, REVIEW_PANE_TEXT_BOTTOM, REVIEW_PANE_TEXT_TOP, reviewPaneGridClass } from './review-pane-layout';
import type { ReviewQuestionContentProps } from './review-content-types';
import { ReviewExplanation } from './ReviewCardContent';
import { GlossaryText } from '@/components/content/GlossaryText';
import { CheckIcon, ChevronIcon, XIcon } from '@/components/content/mcq-icons';

export interface ReviewQuestionOption {
  label: string;
  text: string;
  explanation?: string | null;
}

export interface ReviewQuestionResult {
  isCorrect: boolean;
  correctOption: string;
}

export interface ReviewQuestionOptionsProps {
  options: ReviewQuestionOption[];
  selectedOption: string | null;
  result?: ReviewQuestionResult | null;
  responseFormat?: 'standard' | 'kType';
  showIndex?: boolean;
  disabled?: boolean;
  revealDisabled?: boolean;
  selectedPending?: boolean;
  onSelect: (label: string) => void;
  expandedExplanations?: Set<string>;
  onToggleExplanation?: (label: string) => void;
  onReveal?: () => void;
  revealLabel?: ReactNode;
}

export interface ReviewQuestionResultBodyProps {
  result: ReviewQuestionResult;
  verdict?: ReactNode;
  explanation?: string | null;
}

/** Shared correctness/explanation treatment for ordinary MCQs. */
export function ReviewQuestionResultBody({ result, verdict, explanation }: ReviewQuestionResultBodyProps) {
  return <div className="mt-3 space-y-2 review-reveal">
    {result.isCorrect ? <div role="status" aria-label="Correct" className="inline-flex items-center gap-1 rounded-full bg-[var(--md-success-container)] px-2.5 py-1 text-sm text-[var(--md-on-success-container)] font-medium"><CheckIcon className="w-4 h-4" /> Correct</div> : <div role="status" aria-label="Incorrect" className="inline-flex items-center gap-1 rounded-full bg-[var(--md-error-container)] px-2.5 py-1 text-sm text-[var(--md-on-error-container)] font-medium"><XIcon className="w-4 h-4" /> Incorrect</div>}
    {verdict}
    {explanation && <ReviewExplanation text={explanation} className="pt-1 space-y-3" />}
  </div>;
}

/** Shared ordinary MCQ option/result body. Statement-set renderers stay slots. */
export function ReviewQuestionOptions({
  options, selectedOption, result = null, responseFormat = 'standard', showIndex = true, disabled = false, revealDisabled = disabled,
  selectedPending = false, onSelect, expandedExplanations = new Set(), onToggleExplanation,
  onReveal, revealLabel,
}: ReviewQuestionOptionsProps) {
  if (!result) return <div className="space-y-2">
    {options.map((option, idx) => {
      const selected = selectedOption === option.label;
      return <button key={option.label} type="button" aria-label={`${option.label}. ${option.text}`} aria-pressed={selected} disabled={disabled} onClick={() => onSelect(option.label)}
        className={`review-choice group flex w-full items-start gap-3 text-left p-3.5 rounded-lg border transition-colors disabled:cursor-wait disabled:opacity-60 ${disabled ? 'cursor-wait' : 'cursor-pointer'} ${selected ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]/30' : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/90 hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30'}`}>
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-surface-container-high)] font-mono text-xs text-[var(--md-on-surface-variant)] group-hover:bg-[var(--md-primary-container)] group-hover:text-[var(--md-on-primary-container)] transition-colors">{showIndex && responseFormat !== 'kType' ? idx + 1 : option.label}</span>
        <span className="pt-0.5"><GlossaryText text={option.text} /></span>
      </button>;
    })}
    <div className="text-sm text-[var(--md-on-surface-variant)] text-center mt-2">
      {selectedPending ? 'how sure are you?' : onReveal ? <button type="button" onClick={onReveal} disabled={revealDisabled} className="review-choice min-h-11 w-full rounded-lg border border-dashed border-[var(--md-outline-variant)] px-3 py-2 hover:bg-[var(--md-surface-container-high)] disabled:cursor-wait disabled:opacity-60">{revealLabel}</button> : revealLabel}
    </div>
  </div>;

  return <div className="space-y-2">{options.map((option, idx) => {
    const selected = selectedOption === option.label;
    const correct = option.label === result.correctOption;
    const wrong = selected && !result.isCorrect;
    const explanation = option.explanation?.trim() ?? '';
    const hasExplanation = explanation.length > 0;
    const expanded = expandedExplanations.has(option.label);
    const optionClass = correct ? 'border-[var(--md-success)]/55 bg-[var(--md-success-container)]/45' : wrong ? 'border-[var(--md-error)]/55 bg-[var(--md-error-container)]/45' : 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)]/80';
    const labelClass = correct ? 'bg-[var(--md-success)] text-[var(--md-on-success)]' : wrong ? 'bg-[var(--md-error)] text-[var(--md-on-error)]' : 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';
    return <div key={option.label}>
      <button type="button" onClick={() => hasExplanation && onToggleExplanation?.(option.label)} disabled={!hasExplanation} aria-label={`${option.label}. ${option.text}`} aria-expanded={hasExplanation ? expanded : undefined} className={`review-choice flex w-full items-start gap-3 text-left p-3.5 rounded-lg border transition-colors ${optionClass} ${hasExplanation ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}`}>
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs transition-colors ${labelClass}`}>{showIndex && responseFormat !== 'kType' ? idx + 1 : option.label}</span>
        <span className="min-w-0 flex-1 pt-0.5"><GlossaryText text={option.text} />{correct && <CheckIcon className="ml-1 inline-block w-4 h-4 align-text-bottom text-[var(--md-success)]" />}{wrong && <XIcon className="ml-1 inline-block w-4 h-4 align-text-bottom text-[var(--md-error)]" />}{hasExplanation && <ChevronIcon className={`ml-2 inline-block w-4 h-4 align-text-bottom text-[var(--md-on-surface-variant)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />}</span>
      </button>
      {hasExplanation && expanded && <ReviewExplanation text={explanation} className="mt-1 ml-10 mr-2 px-3 py-2 bg-[var(--md-surface-container)] rounded-lg leading-relaxed border-0 pl-3" />}
    </div>;
  })}</div>;
}

/** Neutral MCQ content compositor. Option/result renderers remain supplied by
 * the adapter so statement sets and opaque grading retain their semantics. */
export function ReviewQuestionContent({ layout, paneKind, className = '', cellClassName, stem, options, result, media, tail, answerRef }: ReviewQuestionContentProps) {
  const sidePane = layout !== 'flat';
  const prompt = layout === 'prompt';
  const top = prompt ? stem : <>{stem}{options}{result}</>;
  const bottom = prompt ? <>{options}{result}{tail}</> : tail;
  const grid = sidePane ? reviewPaneGridClass(paneKind ?? (prompt ? 'prompt-question' : 'supplementary')) : REVIEW_PANE_CELL_FLAT;
  return <div className={`${grid} ${className}`}>
    <div className={`${sidePane ? REVIEW_PANE_TEXT_TOP : REVIEW_PANE_CELL_FLAT} ${cellClassName?.top ?? ''}`}>{top}</div>
    {media && <div className={`${sidePane ? REVIEW_PANE_MEDIA : REVIEW_PANE_CELL_FLAT} ${cellClassName?.media ?? ''}`}>{media}</div>}
    <div ref={answerRef} className={`${sidePane ? REVIEW_PANE_TEXT_BOTTOM : REVIEW_PANE_CELL_FLAT} ${cellClassName?.bottom ?? ''}`}>{bottom}</div>
  </div>;
}
