'use client';

import { InlineMarkdown, MarkdownTable, extractMarkdownTables, tablesCanUseSidePane, type LeafRenderer } from '@/lib/inline-markdown';

export interface ReviewQuestionStemProps {
  text: string;
  leafRenderer?: LeafRenderer;
  className?: string;
}

/**
 * Shared question-stem renderer. It owns MD3's paragraph/table treatment and
 * exposes the same table extraction decision to public and private adapters.
 * Adapters that use ReviewQuestionContent can put `tables` beside this stem;
 * simple surfaces can render the returned blocks inline.
 */
export function parseReviewQuestionStem(text: string) {
  const parsed = extractMarkdownTables(text);
  return { ...parsed, liftTables: tablesCanUseSidePane(parsed.tables) };
}

export function ReviewQuestionStem({ text, leafRenderer, className = '' }: ReviewQuestionStemProps) {
  const parsed = parseReviewQuestionStem(text);
  const paragraphs = (value: string) => value.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => (
    <p key={index}><InlineMarkdown text={paragraph} leafRenderer={leafRenderer} /></p>
  ));
  return <div data-question-stem className={`min-w-0 space-y-3 text-base leading-relaxed ${className}`}>
    {parsed.blocks.map((block, index) => block.kind === 'table'
      ? <div key={index} role="region" aria-label="Question results" tabIndex={0} className="overflow-x-auto"><MarkdownTable table={block.table} leafRenderer={leafRenderer} /></div>
      : <div key={index} className="space-y-3">{paragraphs(block.text)}</div>)}
  </div>;
}

export function ReviewQuestionStemTable({ text, leafRenderer, className = '' }: ReviewQuestionStemProps) {
  const parsed = parseReviewQuestionStem(text);
  return <div data-results-table role="region" aria-label="Question results" tabIndex={0} className={`min-w-0 overflow-x-auto rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-2 ${className}`}>
    {parsed.tables.map((table, index) => <MarkdownTable key={index} table={table} leafRenderer={leafRenderer} />)}
  </div>;
}
