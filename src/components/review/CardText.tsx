'use client';

import { useMemo } from 'react';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { containsMath } from '@/lib/math/contains-math';
import { GlossaryText } from '../content/GlossaryText';
import { MathHtml } from './MathHtml';
import { InlineMarkdown, hasMarkdownTable, normalizeInlineTables, type LeafRenderer } from '@/lib/inline-markdown';

/** Leaf renderer that provides glossary term tooltips + chemistry formatting */
const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

/**
 * Parse simple markdown and render card text with styled blanks
 *
 * Note: dangerouslySetInnerHTML is safe here because KaTeX only produces
 * mathematical HTML and input is our controlled card content, not user input.
 */
export function CardText({
  text,
  answers,
  revealedCount,
}: {
  text: string;
  answers?: string[];
  revealedCount: number;
}) {
  const parts = useMemo(() => {
    // Split by [___] blanks
    const segments: Array<{ type: 'text' | 'blank'; content: string; index?: number }> = [];
    let blankIndex = 0;
    let remaining = normalizeAngleBracketEscapes(text);
    // Keep a blank glued to the word that follows it: the fixed-width slot is an
    // inline-block box, so at a line-wrap it can strand alone at the right edge
    // and read as a floating dash. Converting the whitespace immediately after a
    // blank into a non-breaking space makes the slot wrap together with its next
    // word instead of orphaning. (`whitespace-pre-wrap` honours U+00A0.)
    let afterBlank = false;
    const bindLeading = (s: string) =>
      afterBlank ? s.replace(/^[ \t]+/, '\u00A0') : s;

    while (remaining.length > 0) {
      const blankMatch = remaining.match(/\[_{2,}\]/);
      if (!blankMatch) {
        segments.push({ type: 'text', content: bindLeading(remaining) });
        break;
      }

      const beforeBlank = remaining.slice(0, blankMatch.index);
      if (beforeBlank) {
        segments.push({ type: 'text', content: bindLeading(beforeBlank) });
        afterBlank = false;
      }
      segments.push({
        type: 'blank',
        content: normalizeAngleBracketEscapes(answers?.[blankIndex] || '???'),
        index: blankIndex,
      });
      afterBlank = true;
      blankIndex++;
      remaining = remaining.slice((blankMatch.index || 0) + blankMatch[0].length);
    }

    return segments;
  }, [text, answers]);

  const renderText = (content: string): React.ReactNode[] => {
    // If content contains a markdown table, delegate to InlineMarkdown
    // which handles table rendering, bold, and italic
    const tableNormalized = normalizeInlineTables(content);
    if (hasMarkdownTable(tableNormalized)) {
      return [<InlineMarkdown key="table" text={content} leafRenderer={glossaryLeaf} />];
    }

    const hasMath = containsMath(content);
    const parts: React.ReactNode[] = [];
    let remaining = content;
    let keyIndex = 0;

    // Existing bold+math rendering (preserved for non-table text)
    const boldRegex = /\*\*(.+?)\*\*/;

    while (remaining.length > 0) {
      const match = remaining.match(boldRegex);
      if (!match) {
        if (hasMath && containsMath(remaining)) {
          parts.push(<MathHtml key={keyIndex++} text={remaining} />);
        } else {
          parts.push(<GlossaryText key={keyIndex++} text={remaining} />);
        }
        break;
      }

      if (match.index && match.index > 0) {
        const beforeText = remaining.slice(0, match.index);
        if (hasMath && containsMath(beforeText)) {
          parts.push(<MathHtml key={keyIndex++} text={beforeText} />);
        } else {
          parts.push(<GlossaryText key={keyIndex++} text={beforeText} />);
        }
      }

      const boldContent = match[1];
      if (hasMath && containsMath(boldContent)) {
        parts.push(
          <MathHtml key={keyIndex++} as="strong" className="font-semibold" text={boldContent} />
        );
      } else {
        parts.push(
          <strong key={keyIndex++} className="font-semibold">
            <GlossaryText text={boldContent} />
          </strong>
        );
      }

      remaining = remaining.slice((match.index || 0) + match[0].length);
    }

    return parts.length > 0 ? parts : [<GlossaryText key="leaf" text={content} />];
  };

  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        if (part.type === 'text') {
          return <span key={i}>{renderText(part.content)}</span>;
        }
        // Blank — a precision slot, not an amber form-field. Unrevealed: a
        // thin fixed-width underline (never sized to the answer, so it can't
        // leak the answer length); the next-to-reveal blank gets a stronger
        // tint so sequential reveal stays locatable on mobile. Revealed: the
        // answer opacity-fades in over a quiet primary underline (no width
        // animation, no translateY — see .cloze-reveal in globals.css).
        const idx = part.index;
        const isRevealed = idx !== undefined && idx < revealedCount;
        const isNext = idx !== undefined && idx === revealedCount;
        if (isRevealed) {
          return (
            <span
              key={i}
              // `inline`, NOT `inline-block`: an inline-block is an atomic box
              // with a break opportunity on either side, so "...is [___]."
              // could wrap between the answer and its full stop, stranding the
              // "." alone on the next line. As plain inline text there is no
              // whitespace between the answer and the punctuation, so no break
              // opportunity exists. The empty slot below must stay inline-block
              // — min-width does not apply to a non-replaced inline element.
              className="cloze-reveal inline mx-0.5 align-baseline font-medium text-[var(--md-on-surface)] border-b-2 border-[var(--md-primary)]/40"
            >
              <GlossaryText text={part.content} />
            </span>
          );
        }
        return (
          <span
            key={i}
            aria-label="blank"
            className={`inline-block mx-0.5 min-w-[2.75ch] select-none align-baseline border-b-2 text-transparent ${
              isNext
                ? 'border-[var(--md-primary)]/80'
                : 'border-[var(--md-outline-variant)]'
            }`}
          >
            {'  '}
          </span>
        );
      })}
    </span>
  );
}
