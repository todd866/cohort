'use client';

import { type ReactNode, type RefObject } from 'react';
import Link from 'next/link';
import type { ReviewItem } from './hooks/types';
import { CardText } from './CardText';
import { CardImage } from './CardImage';
import { usePrefetchImage } from '@/hooks/usePrefetchImage';
import { CardFeedback } from './CardFeedback';
import { GlossaryScope } from '../content/GlossaryScope';
import { GlossaryText } from '../content/GlossaryText';
import { type LeafRenderer } from '@/lib/inline-markdown';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { reviewImageIsPrompt } from './image-role';
import { clipIsPrompt } from './clip-role';
import { ClipPrompt } from './ClipPrompt';
import { ClipContext } from './ClipContext';
import { RevealActionLabel } from './RevealActionLabel';
import { TutorCardLink } from '@/components/tutor/TutorCardLink';
import { ReviewCardBody, ReviewCardContent, ReviewExplanation } from '@/components/shared/ReviewCardContent';
import { AnatomyReviewFigure } from '@/components/shared/AnatomyReviewFigure';
import {
  itemUsesSidePane,
  reviewPaneKind,
} from './review-panes';

const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

const ROHEN_INSTRUCTION = 'Rohen, Yokochi & Lutjen-Drecoll, Anatomy: A Photographic Atlas. The numbers are printed on the photograph; name the structure the leader line points to.';

/** Presentation only: keep stored prompts/answers and review identities intact. */
export function numberedAnatomyPresentation(front: string, context: string, caption?: string | null) {
  const match = /^(.*?) — name structure \*\*(\d+)\*\* in the photograph\.\s*(\[[_\\]+\])$/.exec(front);
  if (!match || !context.includes(ROHEN_INSTRUCTION)) return { front, context, caption, source: null };
  return {
    front: `Identify structure **${match[2]}**. ${match[3]}`,
    context: context.replace(ROHEN_INSTRUCTION, '').replace(/(?:\\n|\s)+$/, '').trim(),
    caption: caption?.trim() === match[1].trim() ? null : caption,
    source: ROHEN_INSTRUCTION.split('. The numbers')[0] + '.',
    targetNumber: match[2],
  };
}

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
  /** Optional public-surface feedback control, shown only after reveal. */
  publicFeedback?: ReactNode;
  /**
   * A public surface (Cohort): the card's id is an opaque delivery, and the
   * Details page, tutor link and like/hide feedback are md3 routes keyed to an
   * md3 card. Show none of them.
   */
  publicSurface?: boolean;
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
  publicSurface = false,
  publicFeedback = null,
}: CardItemViewProps) {
  const publicAnatomy = item.publicAnatomyMedia;
  const attribution = item.attribution ?? publicAnatomy?.attribution;
  const hasFigure = Boolean(item.imageUrl || item.imageKey || publicAnatomy);
  const figureIsPrompt = imageIsPrompt(item.imageMeta, item.imageRole, item.front);
  const anatomyIsPrompt = publicAnatomy?.role === 'prompt';
  // A clip prompt outranks a figure prompt for the media pane: it is the stem,
  // and a card carrying both is an authoring mistake rather than a layout to
  // support. A supplementary figure on a clip card still renders, below the
  // clip and still only after the answer is out.
  const clipPrompt = clipIsPrompt(item.clipRole, item.clip);
  const clipCaptionInQuestionPane = clipPrompt;
  const mediaIsPrompt = clipPrompt || figureIsPrompt || anatomyIsPrompt;
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
  const presentation = numberedAnatomyPresentation(item.front || '', item.context || '', item.imageCaption);

  const stemNode = <ReviewCardBody
    front={presentation.front}
    answers={item.backs || (item.back ? item.back.split('; ') : [])}
    revealedBlanks={revealedBlanks}
    reserveRevealSpace={mediaIsPrompt}
    revealed={false}
  />;
  const clipInstructionNode = clipCaptionInQuestionPane && item.clipCaption ? (
    <p className="text-sm text-[var(--md-on-surface-variant)] leading-snug mb-3">
      {item.clipCaption}
    </p>
  ) : null;

  // A supplementary figure still mounts only once the answer is out. Without
  // this gate a non-diagnostic figure with the default `showWhen: 'always'`
  // would render pre-reveal — CardImage's own `visible` test would allow it —
  // and could give the answer away.
  const figureMounted = !publicAnatomy && hasFigure && (figureIsPrompt || cardFullyRevealed);
  const anatomyMounted = Boolean(publicAnatomy && (anatomyIsPrompt || cardFullyRevealed));

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
      caption={presentation.caption}
      meta={item.imageMeta}
      prompt={figureIsPrompt}
      revealed={cardFullyRevealed}
      imageKey={item.imageKey ?? null}
      trackingComponentId={item.id}
      onSkipSensitive={figureIsPrompt ? handleReveal : undefined}
      inSidePane={sidePane}
      targetNumber={presentation.targetNumber}
    />
  ) : null;

  const anatomyNode = anatomyMounted && publicAnatomy ? (
    <AnatomyReviewFigure
      figureId={publicAnatomy.figureId}
      target={publicAnatomy.target}
      revealed={cardFullyRevealed}
      alt={cardFullyRevealed ? publicAnatomy.postAnswerAlt : publicAnatomy.preAnswerAlt}
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
      {presentation.context && <ReviewExplanation
        text={normalizeAngleBracketEscapes(presentation.context).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')}
        leafRenderer={glossaryLeaf}
        className="mb-3"
      />}
      {presentation.source && !item.imageMeta?.attributionText && (
        <details className="text-xs text-[var(--md-on-surface-variant)] mt-2">
          <summary className="cursor-pointer">Source</summary>
          <p className="mt-1">{presentation.source}</p>
        </details>
      )}
      {attribution && (
        <details className="text-xs text-[var(--md-on-surface-variant)] mt-2">
          <summary className="cursor-pointer">Source</summary>
          <p className="mt-1">{attribution.text} · {attribution.licence}</p>
        </details>
      )}
    </div>
  ) : null;

  const linksNode = cardFullyRevealed && publicSurface ? publicFeedback : cardFullyRevealed && !publicSurface ? (
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
  const mediaFigureNode = anatomyNode || (clipNode && figureIsPrompt ? null : figureNode);
  const mediaNode = clipNode || mediaFigureNode || contextClipNode
    ? <>{clipNode}{mediaFigureNode}{contextClipNode}</>
    : null;

  // Keep the compact prompt treatment used by MD3 on short landscape screens.
  // This is presentation metadata so public adapters can opt into the same
  // geometry without importing the private review pane implementation.
  const compactPrompt = clipPrompt || Boolean(presentation.targetNumber) || Boolean(publicAnatomy);



  return (
    <GlossaryScope abbreviations={item.abbreviations}>
    <ReviewCardContent
      layout={mediaNode ? (mediaIsPrompt ? 'prompt' : 'supplementary') : 'flat'}
      paneKind={reviewPaneKind(item)}
      compactPrompt={compactPrompt}
      stem={mediaIsPrompt ? <>{stemNode}{clipInstructionNode}</> : stemNode}
      reveal={inlineRevealNode}
      answer={answerNode}
      media={mediaNode}
      links={linksNode}
      answerRef={undefined}
    />
    </GlossaryScope>
  );
}
