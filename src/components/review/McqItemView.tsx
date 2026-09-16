'use client';

import { type RefObject } from 'react';
import Link from 'next/link';
import type { ReviewItem } from './hooks/types';
import { CardImage } from './CardImage';
import { CardFeedback } from './CardFeedback';
import { usePrefetchImage } from '@/hooks/usePrefetchImage';
import { GlossaryText } from '../content/GlossaryText';
import { InlineMarkdown, MarkdownTable, extractMarkdownTable, type LeafRenderer } from '@/lib/inline-markdown';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { splitExplanation } from '../content/mcq-utils';
import { CheckIcon, XIcon, ChevronIcon } from '../content/mcq-icons';
import { RevealActionLabel } from './RevealActionLabel';
import { reviewImageIsPrompt } from './image-role';
import {
  itemUsesSidePane,
  REVIEW_PANE_CELL_FLAT,
  reviewPaneGridClass,
  reviewPaneKind,
  REVIEW_PANE_MEDIA,
  REVIEW_PANE_TEXT_BOTTOM,
  REVIEW_PANE_TEXT_TOP,
} from './review-panes';

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
  /** Reveal-only, reviewed accessibility description from opaque grading. */
  postAnswerAlt?: string | null;
  /** Reveal-only source page when its URI would identify the diagnosis. */
  postAnswerSourcePageUrl?: string | null;
  expandedOptionExplanations: Set<string>;
  mcqConfidenceRef?: RefObject<HTMLDivElement | null>;
  /** Explanation zone (result + context + figure) — the post-answer scroll target. */
  mcqAnswerRef?: RefObject<HTMLDivElement | null>;
  handleSelectOption: (label: string) => void;
  /** The existing Space/Enter answer action; also skips a concealed prompt. */
  handleRevealAnswer?: () => void;
  toggleOptionExplanation: (label: string) => void;
  onSuppress: (id: string) => void;
  /** Option chosen but not yet revealed (opaque public grading). */
  selectedPending?: boolean;
  /** A product gate owns interaction while profile/onboarding state resolves. */
  interactionDisabled?: boolean;
}

export function McqItemView({
  item,
  selectedOption,
  mcqResult,
  context,
  postAnswerAlt,
  postAnswerSourcePageUrl,
  expandedOptionExplanations,
  mcqAnswerRef,
  handleSelectOption,
  handleRevealAnswer,
  toggleOptionExplanation,
  selectedPending = false,
  interactionDisabled = false,
}: McqItemViewProps) {
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  const figureIsPrompt = reviewImageIsPrompt(item.imageRole, item.imageMeta);
  // Warm the cache for an after-reveal supplementary figure while the stem is on
  // screen — it's mounted only after the user answers, so without this its <img>
  // starts fetching the instant the answer is shown (the load pause).
  usePrefetchImage(
    item.imageUrl && !figureIsPrompt ? item.imageUrl : null,
    !mcqResult,
  );
  if (!item.options) return null;

  // Only prompt images need a side pane. An answer illustration must neither
  // leave an empty column before grading nor move the options when revealed.
  // An answered MCQ is "revealed" for pane purposes, exactly as a fully
  // revealed card is. Without the second argument this defaulted to false, so
  // a supplementary figure on a QUESTION never earned the pane and stacked
  // below the explanation — the card-only half of the fix.
  const sidePane = itemUsesSidePane(item, Boolean(mcqResult));

  // A supplementary figure still mounts only once the answer is out, as it does
  // today — CardImage's own `visible` test would let a `showWhen: 'always'`
  // non-diagnostic figure through pre-answer.
  const figureMounted = hasFigure && (figureIsPrompt || !!mcqResult);

  // A results table in the stem (an LP panel, a DKA progress panel) is lifted
  // out of the prose and rendered in the media pane beside it, so the learner
  // reads the question against the numbers instead of scrolling between them.
  // Asked for twice on 2026-09-15. The prose keeps its place in the reading
  // column; on a phone the table sits between the stem and the options.
  const rawStem = normalizeAngleBracketEscapes(item.stem ?? '').replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  const stemTable = extractMarkdownTable(rawStem);
  const stemNode = (
    <div className="text-[var(--md-on-surface)] mb-5 space-y-2 text-[1.03rem] leading-relaxed">
      {splitExplanation(stemTable ? stemTable.prose : rawStem).map((block, i) => (
        <p key={i}><InlineMarkdown text={block} leafRenderer={glossaryLeaf} /></p>
      ))}
    </div>
  );
  const resultsNode = stemTable ? (
    <div
      data-results-table
      className="mb-4 overflow-x-auto rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-2"
    >
      <MarkdownTable table={stemTable.table} leafRenderer={glossaryLeaf} />
    </div>
  ) : null;

  const figureNode = figureMounted ? (
    <CardImage
      src={item.imageUrl}
      caption={item.imageCaption}
      meta={item.imageMeta}
      prompt={figureIsPrompt}
      revealed={!!mcqResult}
      postAnswerAlt={postAnswerAlt}
      postAnswerSourcePageUrl={postAnswerSourcePageUrl}
      imageKey={item.imageKey ?? null}
      trackingComponentId={item.id}
      onSkipSensitive={figureIsPrompt ? handleRevealAnswer : undefined}
      inSidePane={sidePane}
    />
  ) : null;

  const optionsNode = (
    <>
      {/* Inline options - before answering */}
      {!mcqResult && (
        <div className="space-y-2">
          {item.options.map((option, idx) => {
            const isSelected = selectedOption === option.label;
            return (
            <button
              key={option.label}
              type="button"
              disabled={interactionDisabled}
              onClick={() => handleSelectOption(option.label)}
              className={`review-choice group flex w-full items-start gap-3 text-left p-3.5 rounded-lg border transition-colors disabled:cursor-wait disabled:opacity-60 ${
                interactionDisabled ? 'cursor-wait' : 'cursor-pointer'
              } ${
                isSelected
                  ? 'border-[var(--md-primary)] bg-[var(--md-primary-container)]/30'
                  : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/90 hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30'
              }`}
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--md-surface-container-high)] font-mono text-xs text-[var(--md-on-surface-variant)] group-hover:bg-[var(--md-primary-container)] group-hover:text-[var(--md-on-primary-container)] transition-colors">
                {idx + 1}
              </span>
              <span className="pt-0.5"><GlossaryText text={option.text} /></span>
            </button>
            );
          })}
          <div className="text-sm text-[var(--md-on-surface-variant)] text-center mt-2">
            {selectedPending ? 'how sure are you?' : handleRevealAnswer ? (
              <button
                type="button"
                onClick={handleRevealAnswer}
                disabled={interactionDisabled}
                className="review-choice min-h-11 w-full rounded-lg border border-dashed border-[var(--md-outline-variant)] px-3 py-2 hover:bg-[var(--md-surface-container-high)] disabled:cursor-wait disabled:opacity-60"
              >
                <RevealActionLabel item={item} />
              </button>
            ) : <RevealActionLabel item={item} />}
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
                  className={`review-choice flex w-full items-start gap-3 text-left p-3.5 rounded-lg border transition-colors ${optionClass}`}
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
    </>
  );

  // Result + explanation. The supplementary figure sits between this and the
  // links row in the DOM, so they are separate nodes. `mcqAnswerRef` stays on
  // the HEAD of the reveal — that is what `needsRevealScroll` measures.
  const resultNode = mcqResult ? (
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
    </div>
  ) : null;

  const tailNode = mcqResult ? (
    <>
      {/* Links row */}
      <div className="review-reveal mt-4 flex items-center gap-3 text-xs">
        {item.crosslinks?.primary && (
          <Link
            href={item.crosslinks.primary}
            className="text-[var(--md-primary)] hover:underline"
          >
            Learn more →
          </Link>
        )}
        {!item.deliveryId && (
          <Link
            href={`/questions/${item.id}`}
            target="_blank"
            className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)] opacity-60 hover:opacity-100"
          >
            Details ↗
          </Link>
        )}
      </div>

      {/* Feedback buttons — same level as card feedback */}
      {!item.deliveryId && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div />
          <CardFeedback
            cardId={item.id}
            itemType="question"
            serveDecisionId={item.serveDecisionId}
            sourceComponent="MCQ"
          />
        </div>
      )}
    </>
  ) : null;

  // A PROMPT figure splits after the stem — a screen reader must still meet the
  // image before the options, not after the explanation. A SUPPLEMENTARY figure
  // splits before the links row, exactly where it sits today.
  // A results table splits the same way a prompt figure does: it is question
  // content the learner must meet before the options.
  const mediaIsPrompt = figureIsPrompt || Boolean(resultsNode);
  const paneTop = mediaIsPrompt ? stemNode : <>{stemNode}{optionsNode}{resultNode}</>;
  const paneBottom = mediaIsPrompt
    ? <>{optionsNode}{resultNode}{tailNode}</>
    : tailNode;

  return (
    <div className={sidePane ? reviewPaneGridClass(reviewPaneKind(item)) : REVIEW_PANE_CELL_FLAT}>
      <div className={sidePane ? REVIEW_PANE_TEXT_TOP : REVIEW_PANE_CELL_FLAT}>{paneTop}</div>
      {(figureNode || resultsNode) && (
        <div className={sidePane ? REVIEW_PANE_MEDIA : 'mt-2'}>
          {resultsNode}
          {figureNode}
        </div>
      )}
      <div className={sidePane ? REVIEW_PANE_TEXT_BOTTOM : REVIEW_PANE_CELL_FLAT}>{paneBottom}</div>
    </div>
  );
}
