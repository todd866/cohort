'use client';

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { tokenizeGlossaryTerms } from './glossary-autowrap';
import { Term } from './Term';

// Renders card text, wrapping only OBSCURE glossary terms (those flagged
// `decode: true`) in a hover-decode <Term>. The old decode-everything style was
// removed 2026-06-11 as noise; this gated version only ever touches a curated
// handful of genuinely-obscure TLAs (ITP, MMN, CIDP…), so trivial terms render
// plain. Stored card text is plain (the seeder flattens authored <Term>), so
// this is where render-time decode happens in the review feed.
export function GlossaryText({ text }: { text: string }): ReactNode {
  const normalized = normalizeAngleBracketEscapes(text);
  const segments = tokenizeGlossaryTerms(normalized);
  if (segments.length === 1 && segments[0].type === 'text') {
    return segments[0].value;
  }
  return segments.map((seg, i) =>
    seg.type === 'text' ? (
      <Fragment key={i}>{seg.value}</Fragment>
    ) : (
      <Term key={i} abbr={seg.abbr} />
    ),
  );
}

/**
 * Renders text as paragraphs, splitting on blank lines (`\n\n`).
 * Use for stems, contexts, and any field authored with paragraph breaks —
 * a plain `<p>{text}</p>` collapses `\n\n` to whitespace.
 */
export function GlossaryParagraphs({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}): ReactNode {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const safe = blocks.length > 0 ? blocks : [text];
  return (
    <>
      {safe.map((block, i) => (
        <p key={i} className={className} style={style}>
          <GlossaryText text={block} />
        </p>
      ))}
    </>
  );
}
