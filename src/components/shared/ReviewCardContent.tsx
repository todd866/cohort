'use client';

import { REVIEW_PANE_CELL_FLAT, REVIEW_PANE_MEDIA, REVIEW_PANE_TEXT_BOTTOM, REVIEW_PANE_TEXT_TOP, reviewPaneGridClass } from './review-pane-layout';
import type { ReviewCardContentProps } from './review-content-types';
import { CardText } from './CardText';
import { InlineMarkdown, MarkdownTable, extractMarkdownTables, type LeafRenderer } from '@/lib/inline-markdown';
import { splitExplanation } from '@/components/content/mcq-utils';

export interface ReviewExplanationProps {
  text: string;
  leafRenderer?: LeafRenderer;
  className?: string;
}

/** Shared answer explanation treatment used by cards and questions. */
export function ReviewExplanation({ text, leafRenderer, className = '' }: ReviewExplanationProps) {
  const parsed = extractMarkdownTables(text);
  return <div className={`text-sm text-[var(--md-on-surface-variant)] space-y-2 border-l-2 border-[var(--md-outline-soft)] pl-3 ${className}`}>
    {parsed.blocks.map((block, i) => block.kind === 'table'
      ? <div key={i} className="overflow-x-auto"><MarkdownTable table={block.table} leafRenderer={leafRenderer} /></div>
      : splitExplanation(block.text).map((part, j) => <p key={`${i}-${j}`}><InlineMarkdown text={part} leafRenderer={leafRenderer} /></p>))}
  </div>;
}

export interface ReviewCardBodyProps {
  front: string;
  answers?: string[];
  revealedBlanks: number;
  reserveRevealSpace?: boolean;
  context?: string | null;
  revealed: boolean;
}

/** Plain-data card body shared by private and public review adapters. */
export function ReviewCardBody({ front, answers = [], revealedBlanks, reserveRevealSpace = false, context, revealed }: ReviewCardBodyProps) {
  return <>
    <div data-card-stem className="text-[var(--md-on-surface)] mb-5 text-[1.03rem] leading-relaxed">
      <CardText text={front} answers={answers} revealedCount={revealedBlanks} reserveRevealSpace={reserveRevealSpace} />
    </div>
    {revealed && context && <div className="text-sm text-[var(--md-on-surface-variant)] mb-3 space-y-2 border-l-2 border-[var(--md-outline-soft)] pl-3"><InlineMarkdown text={context} /></div>}
  </>;
}

/** Neutral card presentation. MD3 supplies private media/actions as slots;
 * public controllers can supply reviewed public figures without importing the
 * private review graph. */
export function ReviewCardContent({ layout, paneKind, className = '', cellClassName, compactPrompt = false, stem, reveal, answer, media, links, answerRef }: ReviewCardContentProps) {
  if (compactPrompt) {
    className += ' [@media(min-width:768px)_and_(max-height:500px)]:grid [@media(min-width:768px)_and_(max-height:500px)]:grid-cols-[minmax(0,1fr)_minmax(300px,50%)] [@media(min-width:768px)_and_(max-height:500px)]:gap-x-4';
    cellClassName = {
      top: '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1',
      media: '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-2 [@media(min-width:768px)_and_(max-height:500px)]:row-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-span-2',
      bottom: '[@media(min-width:768px)_and_(max-height:500px)]:block [@media(min-width:768px)_and_(max-height:500px)]:col-start-1 [@media(min-width:768px)_and_(max-height:500px)]:row-start-2',
    };
  }
  const sidePane = layout !== 'flat';
  const top = layout === 'prompt' ? <>{stem}</> : <>{stem}{reveal}{answer}</>;
  const bottom = layout === 'prompt' ? <>{reveal}{answer}{links}</> : links;
  const grid = sidePane ? reviewPaneGridClass(paneKind ?? (layout === 'prompt' ? 'prompt-card' : 'supplementary')) : REVIEW_PANE_CELL_FLAT;
  return <div className={`${grid} ${className}`}>
    <div className={`${sidePane ? REVIEW_PANE_TEXT_TOP : REVIEW_PANE_CELL_FLAT} ${cellClassName?.top ?? ''}`}>{top}</div>
    {media && <div className={`${sidePane ? REVIEW_PANE_MEDIA : REVIEW_PANE_CELL_FLAT} ${cellClassName?.media ?? ''}`}>{media}</div>}
    <div ref={answerRef} className={`${sidePane ? REVIEW_PANE_TEXT_BOTTOM : REVIEW_PANE_CELL_FLAT} ${cellClassName?.bottom ?? ''}`}>{bottom}</div>
  </div>;
}
