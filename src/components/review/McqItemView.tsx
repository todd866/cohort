'use client';

import { type RefObject } from 'react';
import Link from 'next/link';
import type { ReviewItem } from './hooks/types';
import { CardImage } from './CardImage';
import { ClipPrompt, clipIsPrompt } from './ClipPrompt';
import { ClipContext } from './ClipContext';
import { InlineCalculator } from './InlineCalculator';
import { isCalculationItem } from '@/lib/calc/evaluate';
import { PracticePromptFigure } from '@/components/practice-exam/PracticePromptFigure';
import type { PreparedPromptFigure } from '@/components/practice-exam/usePreparedPromptFigures';
import type { PromptFigure } from '@/lib/practice-exam/prompt-figure';
import { CardFeedback } from './CardFeedback';
import { usePrefetchImage } from '@/hooks/usePrefetchImage';
import { GlossaryScope } from '../content/GlossaryScope';
import { GlossaryText } from '../content/GlossaryText';
import { type LeafRenderer } from '@/lib/inline-markdown';
import { RevealActionLabel } from './RevealActionLabel';
import { StatementSetView, KTypeVerdict } from './StatementSetView';
import { responseFormatOfOptions } from '@/lib/question-bank/statement-items';
import { reviewImageIsPrompt } from './image-role';
import { ReviewQuestionContent, ReviewQuestionOptions, ReviewQuestionResultBody } from '@/components/shared/ReviewQuestionContent';
import { ReviewQuestionStem, ReviewQuestionStemTable, parseReviewQuestionStem } from '@/components/shared/ReviewQuestionStem';
import {
  itemUsesSidePane,
  reviewPaneKind,
} from './review-panes';

const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

interface McqResult {
  isCorrect: boolean;
  correctOption: string;
}

interface McqItemViewProps {
  publicSurface?: boolean;
  item: ReviewItem;
  preparedPrompt?: PreparedPromptFigure;
  onRetryPrompt?: (src: string) => void;
  onPromptError?: (src: string) => void;
  postAnswerPromptFigure?: PromptFigure | null;
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
  preparedPrompt,
  onRetryPrompt,
  onPromptError,
  postAnswerPromptFigure,
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
  publicSurface = false,
}: McqItemViewProps) {
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  const figureIsPrompt = Boolean(item.promptFigure) || reviewImageIsPrompt(item.imageRole, item.imageMeta, item.stem);
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
  const stemTables = parseReviewQuestionStem(item.stem ?? '');
  const liftTables = stemTables.liftTables;
  const stemNode = (
    <><ReviewQuestionStem text={liftTables ? stemTables.prose : (item.stem ?? '')} leafRenderer={glossaryLeaf} className="text-[var(--md-on-surface)] mb-5 text-[1.03rem]" />
      {isCalculationItem(item) && <InlineCalculator key={item.id} />}</>
  );
  const resultsNode = liftTables ? (
    <ReviewQuestionStemTable text={item.stem ?? ''} leafRenderer={glossaryLeaf} className="mb-4" />
  ) : null;

  // A prompt clip is the question's media ("as the clip shows"), shown before
  // the options; any other clip is the whole operation, offered after the
  // answer. Same contract as CardItemView. Until 2026-10-01 this view rendered
  // neither, so clip questions arrived beside an empty pane.
  const clipPrompt = clipIsPrompt(item.clipRole, item.clip);
  const clipNode = item.clip
    ? clipPrompt
      ? <ClipPrompt clip={item.clip} caption={item.clipCaption} revealed={Boolean(mcqResult)} inSidePane={sidePane} />
      : mcqResult ? <ClipContext clip={item.clip} caption={item.clipCaption} revealed /> : null
    : null;

  const promptBlocked = Boolean(item.promptFigure) && preparedPrompt?.status !== 'ready';
  const figureNode = item.promptFigure ? (
    <PracticePromptFigure
      key={item.promptFigure.src}
      figure={mcqResult && postAnswerPromptFigure ? postAnswerPromptFigure : item.promptFigure}
      prepared={preparedPrompt}
      onRetry={onRetryPrompt}
      onImageError={onPromptError}
      showAttribution={Boolean(mcqResult)}
    />
  ) : figureMounted ? (
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

  const responseFormat = responseFormatOfOptions(item.options);
  // A statement set's result is its four rows: the reveal scroll lands on
  // them (marks first), not on the summary below.
  const optionsNode = responseFormat === 'typeX' ? (
    <div ref={mcqResult ? mcqAnswerRef : undefined}>
      <StatementSetView
        key={item.id}
        options={item.options}
        result={mcqResult}
        selectedOption={selectedOption}
        onSubmit={handleSelectOption}
        disabled={interactionDisabled || promptBlocked}
      />
    </div>
  ) : (
    <ReviewQuestionOptions
      options={item.options}
      selectedOption={selectedOption}
      result={mcqResult}
      responseFormat={responseFormat === 'kType' ? 'kType' : 'standard'}
      disabled={interactionDisabled || promptBlocked}
      revealDisabled={interactionDisabled}
      selectedPending={selectedPending}
      onSelect={handleSelectOption}
      expandedExplanations={expandedOptionExplanations}
      onToggleExplanation={toggleOptionExplanation}
      onReveal={handleRevealAnswer}
      revealLabel={<RevealActionLabel item={item} />}
    />
  );

  // Result + explanation. The supplementary figure sits between this and the
  // links row in the DOM, so they are separate nodes. `mcqAnswerRef` stays on
  // the HEAD of the reveal — that is what `needsRevealScroll` measures.
  const resultNode = mcqResult ? <div className="review-reveal" ref={responseFormat === 'typeX' ? undefined : mcqAnswerRef}>
    {responseFormat === 'typeX' ? null : <ReviewQuestionResultBody
      result={mcqResult}
      verdict={responseFormat === 'kType' && !mcqResult.isCorrect ? <KTypeVerdict selectedOption={selectedOption} correctOption={mcqResult.correctOption} /> : undefined}
      explanation={context}
    />}
  </div> : null;

  const tailNode = mcqResult ? (
    <>
      {item.attribution && <details className="text-xs text-[var(--md-on-surface-variant)] mt-2">
        <summary className="cursor-pointer">Source</summary>
        <p className="mt-1">{item.attribution.text} · {item.attribution.licence}</p>
      </details>}
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
      {(!item.deliveryId || publicSurface) && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <div />
          <CardFeedback
            cardId={item.id}
            itemType="question"
            publicDeliveryId={publicSurface ? item.deliveryId : undefined}
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
  const mediaIsPrompt = figureIsPrompt || clipPrompt || Boolean(resultsNode);
  const mediaNode = (figureNode || resultsNode || clipNode) ? <>{resultsNode}{clipPrompt && clipNode}{figureNode}{!clipPrompt && clipNode}</> : null;
  return <GlossaryScope abbreviations={item.abbreviations}>
    <ReviewQuestionContent
      layout={mediaIsPrompt ? 'prompt' : (mediaNode ? 'supplementary' : 'flat')}
      paneKind={reviewPaneKind(item)}
      stem={stemNode}
      options={optionsNode}
      result={resultNode}
      media={mediaNode}
      tail={tailNode}
    />
  </GlossaryScope>;
}
