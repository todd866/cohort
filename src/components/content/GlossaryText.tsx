'use client';

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { formatChemistry } from '@/lib/format-chemistry';
import { tokenizeGlossaryTerms } from './glossary-autowrap';
import { Term } from './Term';
import { useItemAbbreviations, type ItemAbbreviations } from './GlossaryScope';
import { DecodedTerm } from './DecodedTerm';

// Item-authored maps decide both which tokens decode and their exact meanings.
// A missing key in an explicit map stays plain; legacy null-map content retains
// the old curated global glossary until migrated. No rotation-based inference.
//
// The plain runs between terms also get chemistry notation: Na+ renders as
// Na<sup>+</sup>, HCO3- as HCO<sub>3</sub><sup>-</sup>. This is the one leaf
// every card, context and MCQ option passes through, so it is the one place
// to do it. Greek substitution stays off here — see FormatChemistryOptions.
const chemistry = (value: string) => formatChemistry(value, { greek: false });

export function GlossaryText({ text, abbreviations: explicitAbbreviations }: { text: string; abbreviations?: ItemAbbreviations | null }): ReactNode {
  const inheritedAbbreviations = useItemAbbreviations();
  const abbreviations = explicitAbbreviations === undefined ? inheritedAbbreviations : explicitAbbreviations;
  const normalized = normalizeAngleBracketEscapes(text);
  const segments = tokenizeGlossaryTerms(normalized, abbreviations);
  if (segments.length === 1 && segments[0].type === 'text') {
    return chemistry(segments[0].value);
  }
  return segments.map((seg, i) =>
    seg.type === 'text' ? (
      <Fragment key={i}>{chemistry(seg.value)}</Fragment>
    ) : (
      seg.expansion ? <DecodedTerm key={i} expansion={seg.expansion}>{seg.value}</DecodedTerm> : <Term key={i} abbr={seg.abbr} />
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
