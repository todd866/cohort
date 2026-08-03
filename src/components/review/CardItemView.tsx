'use client';

import { type RefObject } from 'react';
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

const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

interface CardItemViewProps {
  item: ReviewItem;
  revealedBlanks: number;
  blankCount: number;
  cardFullyRevealed: boolean;
  cardAnswerRef: RefObject<HTMLDivElement | null>;
  /** Reveal handler — only needed when inlineReveal is true (e.g. the sandbox
   *  harness). The main review uses a fixed bottom reveal bar instead. */
  handleReveal?: () => void;
  /** Render the in-content reveal button. Default true; UnifiedReview passes
   *  false and uses a fixed bottom bar so the tap target stays in one spot. */
  inlineReveal?: boolean;
  onSuppress: (id: string) => void;
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
): boolean {
  return meta?.class === 'diagnostic' && meta?.showWhen !== 'after-reveal';
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
}: CardItemViewProps) {
  const hasFigure = Boolean(item.imageUrl || item.imageKey);
  const figureIsPrompt = imageIsPrompt(item.imageMeta);
  // Warm the cache for the after-reveal supplementary figure while the question
  // is still on screen — it's mounted only post-reveal, so without this its
  // <img> starts fetching the instant the user reveals (the load pause).
  usePrefetchImage(
    item.imageUrl && !figureIsPrompt ? item.imageUrl : null,
    !cardFullyRevealed,
  );
  return (
    <>
      <div className="text-[var(--md-on-surface)] mb-5 text-[1.03rem] leading-relaxed">
        <CardText
          text={item.front || ''}
          answers={item.backs || (item.back ? item.back.split('; ') : [])}
          revealedCount={revealedBlanks}
        />
      </div>

      {hasFigure && figureIsPrompt && (
        <CardImage
          src={item.imageUrl}
          caption={item.imageCaption}
          meta={item.imageMeta}
          revealed={cardFullyRevealed}
          imageKey={item.imageKey ?? null}
          trackingComponentId={item.id}
        />
      )}

      {/* In-content reveal button — only when inlineReveal (e.g. the sandbox
          harness). The main review hides this and uses a fixed bottom reveal
          bar so the reveal/grade tap target stays in one consistent spot. */}
      {inlineReveal && !cardFullyRevealed && handleReveal && (
        <div className="mt-4">
          <button
            onClick={handleReveal}
            className="review-choice w-full min-h-[52px] p-3.5 rounded-lg border border-dashed border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)]/80 text-[var(--md-on-surface-variant)] font-medium hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30 cursor-pointer transition-all"
          >
            space / enter to reveal {blankCount > 1 ? `(${revealedBlanks}/${blankCount})` : ''}
          </button>
        </div>
      )}

      {/* Answer content - after revealing */}
      {cardFullyRevealed && (
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

          {/* Context and links - buttons are in sticky footer */}
          {item.context && (
            <div className="text-sm text-[var(--md-on-surface-variant)] mb-3 space-y-2 border-l-2 border-[var(--md-outline-soft)] pl-3">
              {splitExplanation(normalizeAngleBracketEscapes(item.context).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n')).map((block, i) => (
                <p key={i}><InlineMarkdown text={block} leafRenderer={glossaryLeaf} /></p>
              ))}
            </div>
          )}

          {/* Supplementary context below the answer — non-diagnostic figures,
              plus diagnostic figures opted into post-reveal via
              showWhen:'after-reveal'. They confirm the answer, not pose it. */}
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

          <div className="mt-4 flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
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
            </div>
            <CardFeedback
              cardId={item.id}
              sourceComponent={item.sourceComponent || 'Card'}
              onFeedback={(action) => {
                if (action === 'suppress') onSuppress(item.id);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
