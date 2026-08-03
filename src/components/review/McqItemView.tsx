'use client';

import { type RefObject } from 'react';
import Link from 'next/link';
import type { ReviewItem } from './hooks/types';
import { CardImage } from './CardImage';
import { CardFeedback } from './CardFeedback';
import { usePrefetchImage } from '@/hooks/usePrefetchImage';
import { GlossaryText } from '../content/GlossaryText';
import { InlineMarkdown, type LeafRenderer } from '@/lib/inline-markdown';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { splitExplanation } from '../content/mcq-utils';
import { CheckIcon, XIcon, ChevronIcon } from '../content/mcq-icons';

const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

interface McqResult {
  isCorrect: boolean;
  correctOption: string;
}

interface McqItemViewProps {
  item: ReviewItem;
  selectedOption: string | null;
  mcqResult: McqResult | null;
  context: string | null | undefined;
  expandedOptionExplanations: Set<string>;
  mcqConfidenceRef?: RefObject<HTMLDivElement | null>;
  /** Explanation zone (result + context + figure) — the post-answer scroll target. */
  mcqAnswerRef?: RefObject<HTMLDivElement | null>;
  handleSelectOption: (label: string) => void;
  toggleOptionExplanation: (label: string) => void;
  onSuppress: (id: string) => void;
}

export function McqItemView({
  item,
  selectedOption,
  mcqResult,
  context,
  expandedOptionExplanations,
  mcqAnswerRef,
  handleSelectOption,
  toggleOptionExplanation,
  onSuppress,
}: McqItemViewProps) {
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  const figureIsPrompt =
    item.imageMeta?.class === 'diagnostic'
    && item.imageMeta?.showWhen !== 'after-reveal';
  // Warm the cache for an after-reveal supplementary figure while the stem is on
  // screen — it's mounted only after the user answers, so without this its <img>
  // starts fetching the instant the answer is shown (the load pause).
  usePrefetchImage(
    item.imageUrl && (item.imageMeta?.class !== 'diagnostic' || item.imageMeta?.showWhen === 'after-reveal')
      ? item.imageUrl
      : null,
    !mcqResult,
  );
  if (!item.options) return null;

  return (
    <>
      <div className="text-[var(--md-on-surface)] mb-5 space-y-2 text-[1.03rem] leading-relaxed">
        {splitExplanation(normalizeAngleBracketEscapes(item.stem ?? '').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')).map((block, i) => (
          <p key={i}><InlineMarkdown text={block} leafRenderer={glossaryLeaf} /></p>
        ))}
      </div>

      {hasFigure && figureIsPrompt && (
        <CardImage
          src={item.imageUrl}
          caption={item.imageCaption}
          meta={item.imageMeta}
          revealed={!!mcqResult}
          imageKey={item.imageKey ?? null}
          trackingComponentId={item.id}
        />
      )}

      {/* Inline options - before answering */}
      {!mcqResult && (
        <div className="space-y-2">
          {item.options.map((option, idx) => (
            <button
              key={option.label}
              onClick={() => handleSelectOption(option.label)}
              className="review-choice group flex w-full items-start gap-3 text-left p-3.5 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/90 hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30 cursor-pointer transition-all"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-surface-container-high)] font-mono text-xs text-[var(--md-on-surface-variant)] group-hover:bg-[var(--md-primary-container)] group-hover:text-[var(--md-on-primary-container)] transition-colors">
                {idx + 1}
              </span>
              <span className="pt-0.5"><GlossaryText text={option.text} /></span>
            </button>
          ))}
          <div className="text-xs text-[var(--md-on-surface-variant)] text-center opacity-70 mt-2">
            space to reveal answer
          </div>
        </div>
      )}

      {/* Options shown after answering (with correct/wrong highlighting) */}
      {mcqResult && (
        <div className="space-y-2">
          {item.options.map((option, idx) => {
            const isSelected = selectedOption === option.label;
            const isCorrect = option.label === mcqResult.correctOption;
            const isWrong = isSelected && !mcqResult.isCorrect;
            const optionExplanation = option.explanation?.trim() ?? '';
            const hasOptionExplanation = optionExplanation.length > 0;
            const isExpanded = expandedOptionExplanations.has(option.label);

            let optionClass = 'border-[var(--md-outline-soft)] bg-[var(--md-surface-container-lowest)]/80';
            let labelClass = 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';
            if (isCorrect) {
              optionClass = 'border-[var(--md-success)]/55 bg-[var(--md-success-container)]/45';
              labelClass = 'bg-[var(--md-success)] text-[var(--md-on-success)]';
            } else if (isWrong) {
              optionClass = 'border-[var(--md-error)]/55 bg-[var(--md-error-container)]/45';
              labelClass = 'bg-[var(--md-error)] text-[var(--md-on-error)]';
            }
            if (hasOptionExplanation) optionClass += ' cursor-pointer hover:brightness-95';
            else optionClass += ' cursor-default';

            return (
              <div key={option.label}>
                <button
                  type="button"
                  onClick={() => {
                    if (hasOptionExplanation) toggleOptionExplanation(option.label);
                  }}
                  disabled={!hasOptionExplanation}
                  aria-expanded={hasOptionExplanation ? isExpanded : undefined}
                  className={`review-choice flex w-full items-start gap-3 text-left p-3.5 rounded-lg border transition-all ${optionClass}`}
                >
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-xs transition-colors ${labelClass}`}>
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1 pt-0.5">
                    <GlossaryText text={option.text} />
                    {isCorrect && <CheckIcon className="ml-1 inline-block w-4 h-4 align-text-bottom text-[var(--md-success)]" />}
                    {isWrong && <XIcon className="ml-1 inline-block w-4 h-4 align-text-bottom text-[var(--md-error)]" />}
                    {hasOptionExplanation && (
                      <ChevronIcon
                        className={`ml-2 inline-block w-4 h-4 align-text-bottom text-[var(--md-on-surface-variant)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    )}
                  </span>
                </button>
                {hasOptionExplanation && isExpanded && (
                  <div className="mt-1 ml-10 mr-2 px-3 py-2 text-sm text-[var(--md-on-surface-variant)] bg-[var(--md-surface-container)] rounded-lg leading-relaxed">
                    <InlineMarkdown text={optionExplanation} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MCQ result */}
      {mcqResult && (
        <div ref={mcqAnswerRef} className="mt-3 space-y-2 review-reveal">
          {/* Result indicator - brief */}
          {mcqResult.isCorrect ? (
            <div role="status" aria-label="Correct" className="inline-flex items-center gap-1 rounded-full bg-[var(--md-success-container)] px-2.5 py-1 text-sm text-[var(--md-on-success-container)] font-medium"><CheckIcon className="w-4 h-4" /> Correct</div>
          ) : (
            <div role="status" aria-label="Incorrect" className="inline-flex items-center gap-1 rounded-full bg-[var(--md-error-container)] px-2.5 py-1 text-sm text-[var(--md-on-error-container)] font-medium"><XIcon className="w-4 h-4" /> Incorrect</div>
          )}

          {/* Explanation — shown on both correct and incorrect */}
          {context && (
            <div className="text-sm pt-1 text-[var(--md-on-surface-variant)] space-y-3 border-l-2 border-[var(--md-outline-soft)] pl-3">
              {splitExplanation(context).map((block, i) => (
                <p key={i}><InlineMarkdown text={block} /></p>
              ))}
            </div>
          )}

          {/* Supplementary context in the explanation zone — non-diagnostic
              images, plus diagnostic images opted into post-reveal via
              showWhen:'after-reveal'. Not part of the question. */}
          {hasFigure && !figureIsPrompt && (
            <CardImage
              src={item.imageUrl}
              caption={item.imageCaption}
              meta={item.imageMeta}
              revealed
              imageKey={item.imageKey ?? null}
              trackingComponentId={item.id}
            />
          )}

          {/* Links row */}
          <div className="mt-4 flex items-center gap-3 text-xs">
            {item.crosslinks?.primary && (
              <Link
                href={item.crosslinks.primary}
                className="text-[var(--md-primary)] hover:underline"
              >
                Learn more →
              </Link>
            )}
            <Link
              href={`/questions/${item.id}`}
              target="_blank"
              className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)] opacity-60 hover:opacity-100"
            >
              Details ↗
            </Link>
          </div>
        </div>
      )}

      {/* Feedback buttons — same level as card feedback */}
      {mcqResult && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div />
          <CardFeedback
            cardId={item.id}
            itemType="question"
            sourceComponent="MCQ"
            onFeedback={(action) => {
              if (action === 'suppress') onSuppress(item.id);
            }}
          />
        </div>
      )}
    </>
  );
}
