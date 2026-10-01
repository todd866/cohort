'use client';

import { type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import type { ReviewItem } from './hooks/types';
import { CardText } from './CardText';
import { CardImage } from './CardImage';
import { usePrefetchImage } from '@/hooks/usePrefetchImage';
import { CardFeedback } from './CardFeedback';
import { GlossaryText } from '../content/GlossaryText';
import { InlineMarkdown, type LeafRenderer } from '@/lib/inline-markdown';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { splitExplanation } from '../content/mcq-utils';
import { reviewImageIsPrompt } from './image-role';
import { clipIsPrompt } from './clip-role';
import { ClipPrompt } from './ClipPrompt';
import { ClipContext } from './ClipContext';
import { RevealActionLabel } from './RevealActionLabel';
import { TutorCardLink } from '@/components/tutor/TutorCardLink';
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

interface CardItemViewProps {
  item: ReviewItem;
  revealedBlanks: number;
  blankCount: number;
  cardFullyRevealed: boolean;
  cardAnswerRef: RefObject<HTMLDivElement | null>;
  /** Reveal handler for the inline/fixed answer control and for choosing to
   *  skip a concealed sensitive prompt without viewing it. */
  handleReveal?: () => void;
  /** Render the in-content reveal button. Default true; UnifiedReview passes
   *  false and uses a fixed bottom bar so the tap target stays in one spot. */
  inlineReveal?: boolean;
  onSuppress: (id: string) => void;
  /** More controls for the post-reveal action row, beside Details and Ask
   *  tutor, at the same size and weight. UnifiedReview passes the clinical
   *  station chip. Shown only once the answer is out. */
  revealActions?: ReactNode;
}

/**
 * An image is the card's PROMPT (rendered ABOVE the cloze, visible pre-reveal)
 * when its sidecar marks it diagnostic and not after-reveal. This is the
 * contract S1 image-as-prompt cards rely on — kept here (DRY) so the two render
 * slots and the lock test agree. Anything else is a supplementary/after-reveal
 * figure (rendered below the answer).
 */
export function imageIsPrompt(
  meta: { class?: string; showWhen?: string } | undefined | null,
  imageRole?: string | null,
  /** The card's own question: one that points at the figure needs it visible. */
  front?: string | null,
): boolean {
  return reviewImageIsPrompt(imageRole, meta, front);
}

export function CardItemView({
  item,
  revealedBlanks,
  blankCount,
  cardFullyRevealed,
  cardAnswerRef,
  handleReveal,
  inlineReveal = true,
  onSuppress,
  revealActions = null,
}: CardItemViewProps) {
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  const figureIsPrompt = imageIsPrompt(item.imageMeta, item.imageRole, item.front);
  // A clip prompt outranks a figure prompt for the media pane: it is the stem,
  // and a card carrying both is an authoring mistake rather than a layout to
  // support. A supplementary figure on a clip card still renders, below the
  // clip and still only after the answer is out.
  const clipPrompt = clipIsPrompt(item.clipRole, item.clip);
  const clipCaptionInQuestionPane = clipPrompt;
  const mediaIsPrompt = clipPrompt || figureIsPrompt;
  // Warm the cache for the after-reveal supplementary figure while the question
  // is still on screen — it's mounted only post-reveal, so without this its
  // <img> starts fetching the instant the user reveals (the load pause).
  usePrefetchImage(
    item.imageUrl && !figureIsPrompt ? item.imageUrl : null,
    !cardFullyRevealed,
  );

  // Prompt images sit beside the question from the start. A supplementary image
  // joins them at reveal — before that there is nothing to show, so the column
  // would just be a gap.
  const sidePane = itemUsesSidePane(item, cardFullyRevealed);

  const stemNode = (
    <div data-card-stem className="text-[var(--md-on-surface)] mb-5 text-[1.03rem] leading-relaxed">
      <CardText
        text={item.front || ''}
        answers={item.backs || (item.back ? item.back.split('; ') : [])}
        revealedCount={revealedBlanks}
        reserveRevealSpace={mediaIsPrompt}
      />
    </div>
  );
  const clipInstructionNode = clipCaptionInQuestionPane && item.clipCaption ? (
    <p className="text-sm text-[var(--md-on-surface-variant)] leading-snug mb-3">
      {item.clipCaption}
    </p>
  ) : null;

  // A supplementary figure still mounts only once the answer is out. Without
  // this gate a non-diagnostic figure with the default `showWhen: 'always'`
  // would render pre-reveal — CardImage's own `visible` test would allow it —
  // and could give the answer away.
  const figureMounted = hasFigure && (figureIsPrompt || cardFullyRevealed);

  // A clip with no prompt role is teaching context: the whole operation, shown
  // after the answer. It mounts only post-reveal and fetches nothing until the
  // learner presses play, so a long video on a card costs a reader who ignores
  // it exactly nothing. See ClipContext for the reasoning.
  const contextClipNode = !clipPrompt && item.clip ? (
    <ClipContext clip={item.clip} caption={item.clipCaption} revealed={cardFullyRevealed} />
  ) : null;

  const clipNode = clipPrompt && item.clip ? (
    <ClipPrompt
      clip={item.clip}
      caption={clipCaptionInQuestionPane ? null : item.clipCaption}
      revealed={cardFullyRevealed}
      inSidePane={sidePane}
    />
  ) : null;

  const figureNode = figureMounted ? (
    <CardImage
      src={item.imageUrl}
      caption={item.imageCaption}
      meta={item.imageMeta}
      prompt={figureIsPrompt}
      revealed={cardFullyRevealed}
      imageKey={item.imageKey ?? null}
      trackingComponentId={item.id}
      onSkipSensitive={figureIsPrompt ? handleReveal : undefined}
      inSidePane={sidePane}
    />
  ) : null;

  const inlineRevealNode =
    /* In-content reveal button — only when inlineReveal (e.g. the sandbox
       harness). The main review hides this and uses a fixed bottom reveal
       bar so the reveal/grade tap target stays in one consistent spot. */
    inlineReveal && !cardFullyRevealed && handleReveal ? (
      <div className="mt-4">
        <button
          onClick={handleReveal}
          className="review-choice w-full min-h-[52px] p-3.5 rounded-lg border border-dashed border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/80 text-[var(--md-on-surface-variant)] font-medium hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30 cursor-pointer transition-colors"
        >
          <RevealActionLabel item={item} remainingAnswers={blankCount - revealedBlanks} />
          {blankCount > 1 ? ` (${revealedBlanks}/${blankCount})` : ''}
        </button>
      </div>
    ) : null;

  // Answer + explanation. A supplementary figure sits BETWEEN this and the
  // links row in the DOM, so the two are separate nodes rather than one block.
  const answerNode = cardFullyRevealed ? (
    <div ref={cardAnswerRef} className="review-reveal">
      {/* Show full answer if there's a back without inline blanks */}
      {item.back && blankCount === 0 && (
        <div className="p-3.5 rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] mb-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.36)]">
          {item.backs && item.backs.length > 0 ? (
            <ul className="list-disc list-inside space-y-1">
              {item.backs.map((b, i) => <li key={i}><CardText text={b} answers={[]} revealedCount={999} /></li>)}
            </ul>
          ) : (
            <CardText text={item.back} answers={[]} revealedCount={999} />
          )}
        </div>
      )}

      {/* Context — grade buttons are in the sticky footer */}
      {item.context && (
        <div className="text-sm text-[var(--md-on-surface-variant)] mb-3 space-y-2 border-l-2 border-[var(--md-outline-soft)] pl-3">
          {splitExplanation(normalizeAngleBracketEscapes(item.context).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')).map((block, i) => (
            <p key={i}><InlineMarkdown text={block} leafRenderer={glossaryLeaf} /></p>
          ))}
        </div>
      )}
    </div>
  ) : null;

  const linksNode = cardFullyRevealed ? (
    <div className="review-reveal mt-4 flex items-center justify-between text-xs">
      {/* Wraps rather than overflowing when a phone row runs out of width. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {item.crosslinks?.primary && (
          <Link
            href={item.crosslinks.primary}
            className="text-[var(--md-primary)] hover:underline"
          >
            Learn more →
          </Link>
        )}
        <Link
          href={`/cards/${item.id}`}
          target="_blank"
          className="text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)] opacity-60 hover:opacity-100"
        >
          Details ↗
        </Link>
        <TutorCardLink cardId={item.id} />
        {revealActions}
      </div>
      <CardFeedback
        cardId={item.id}
        serveDecisionId={item.serveDecisionId}
        sourceComponent={item.sourceComponent || 'Card'}
        onFeedback={(action) => {
          if (action === 'suppress') onSuppress(item.id);
        }}
      />
    </div>
  ) : null;

  // The figure keeps its real DOM slot; only the grid moves it. A PROMPT figure
  // follows the stem (so it is still read as part of the question); a
  // SUPPLEMENTARY one follows the explanation and precedes the links, exactly
  // where it sits today. Both leave the media pane as the middle child, which
  // is why the two cells either side are all the layout needs.
  const paneTop = mediaIsPrompt ? <>{stemNode}{clipInstructionNode}</> : <>{stemNode}{inlineRevealNode}{answerNode}</>;
  const paneBottom = mediaIsPrompt
    ? <>{inlineRevealNode}{answerNode}{linksNode}</>
    : linksNode;
  const mediaNode = clipNode || figureNode || contextClipNode
    ? <>{clipNode}{clipNode && figureIsPrompt ? null : figureNode}{contextClipNode}</>
    : null;

  // At short tablet/landscape heights a prompt clip gets a compact two-column
  // treatment before the normal `lg` pane breakpoint. Keeping the question in
  // one column and the clip in the other preserves a useful surgical image
  // height while the fixed reveal control remains reachable.
  const compactLandscape = clipPrompt
    ? '[@media(min-width:768px)_and_(max-height:500px)]:grid [@media(min-width:768px)_and_(max-height:500px)]:grid-cols-[minmax(0,1fr)_minmax(300px,50%)] [@media(min-width:768px)_and_(max-height:500px)]:gap-x-4'
    : '';
  const compactLandscapeTop = clipPrompt
    ? '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1'
    : '';
  const compactLandscapeMedia = clipPrompt
    ? '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-2 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-span-2'
    : '';
  const compactLandscapeBottom = clipPrompt
    ? '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-2'
    : '';

  return (
    <div className={`${sidePane ? reviewPaneGridClass(reviewPaneKind(item)) : REVIEW_PANE_CELL_FLAT} ${compactLandscape}`}>
      <div className={`${sidePane ? REVIEW_PANE_TEXT_TOP : REVIEW_PANE_CELL_FLAT} ${compactLandscapeTop}`}>{paneTop}</div>
      {mediaNode && (
        <div className={`${sidePane ? REVIEW_PANE_MEDIA : REVIEW_PANE_CELL_FLAT} ${compactLandscapeMedia}`}>{mediaNode}</div>
      )}
      <div className={`${sidePane ? REVIEW_PANE_TEXT_BOTTOM : REVIEW_PANE_CELL_FLAT} ${compactLandscapeBottom}`}>{paneBottom}</div>
    </div>
  );
}
