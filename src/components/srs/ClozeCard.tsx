'use client';

import { Fragment, useMemo, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { InlineMarkdown, type LeafRenderer } from '@/lib/inline-markdown';
import { GlossaryText } from '@/components/content';
import { parseClozeWithTable } from '@/lib/cloze-table-parser';
import { ConfidenceButtons } from '@/components/shared/ConfidenceButtons';
import { CONFIDENCE_TO_QUALITY } from '@/hooks/useGrading';
import { type ClientImageMeta, imageAltForMeta } from '@/lib/figures/types';

/** Leaf renderer that provides glossary term tooltips + chemistry formatting */
const glossaryLeaf: LeafRenderer = (text: string) => <GlossaryText text={text} />;

interface ClozeCardProps {
  id: string;
  front: string;
  back: string;
  backs?: string[];
  context?: string;
  imageUrl?: string | null;
  imageCaption?: string | null;
  imageKey?: string | null;
  imageMeta?: ClientImageMeta;
  sourceComponent: string;
  week: number;
  liked?: boolean;
  flagged?: boolean;
  complexity?: number;
  onGrade: (quality: number, responseTimeMs: number) => void;
  onSuppress?: () => void;
  onGraduate?: () => void;
}


function decodeHtml(text: string): string {
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', ge: '≥', le: '≤',
    rarr: '→', uarr: '↑', darr: '↓', plusmn: '±',
    deg: '°', alpha: 'α', beta: 'β', micro: 'µ',
  };
  return text.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (match, e) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16)) || match;
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10)) || match;
    return entities[e] ?? match;
  });
}

export function ClozeCard({
  id,
  front,
  back,
  backs,
  context,
  imageUrl,
  imageCaption,
  imageMeta,
  sourceComponent,
  week,
  flagged: initialFlagged,
  onGrade,
}: ClozeCardProps) {
  const answers = useMemo(() => backs?.length ? backs : [back], [back, backs]);
  const isMulti = answers.length > 1;
  const [revealed, setRevealed] = useState(0);
  const allRevealed = revealed >= answers.length;
  const revealTimeRef = useRef(0);

  const [flagged, setFlagged] = useState(initialFlagged ?? false);

  // Ref for auto-scrolling to grade buttons
  const gradeButtonsRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to grade buttons when revealed
  useEffect(() => {
    if (allRevealed && gradeButtonsRef.current) {
      gradeButtonsRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [allRevealed]);

  const reveal = useCallback(() => {
    setRevealed(prev => {
      if (prev === 0) revealTimeRef.current = Date.now();
      return isMulti ? prev + 1 : answers.length;
    });
  }, [isMulti, answers.length]);

  const grade = useCallback((q: number) => {
    const time = revealTimeRef.current > 0 ? Date.now() - revealTimeRef.current : 0;
    onGrade(q, time);
  }, [onGrade]);

  const toggleFlag = useCallback(() => {
    const newFlagged = !flagged;
    setFlagged(newFlagged);
    fetch('/api/cards/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card', cardId: id, action: newFlagged ? 'flag' : 'unflag' }),
    }).catch(() => setFlagged(!newFlagged));
  }, [flagged, id]);

  // Keyboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;

      if (e.key === 'f') { e.preventDefault(); toggleFlag(); return; }

      if (!allRevealed) {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
        return;
      }

      if (e.key === ' ' || e.key === 'Enter' || e.key === '3') { e.preventDefault(); grade(CONFIDENCE_TO_QUALITY[3]); }
      else if (e.key === '1') { e.preventDefault(); grade(CONFIDENCE_TO_QUALITY[1]); }
      else if (e.key === '2') { e.preventDefault(); grade(CONFIDENCE_TO_QUALITY[2]); }
      else if (e.key === '4') { e.preventDefault(); grade(CONFIDENCE_TO_QUALITY[4]); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [allRevealed, grade, reveal, toggleFlag]);

  const parts = useMemo(() => front.split('[___]').map(decodeHtml), [front]);
  const decodedAnswers = useMemo(() => answers.map(decodeHtml), [answers]);
  const tableData = useMemo(() => parseClozeWithTable(front), [front]);

  /** Render a cloze blank or revealed answer at the given global index */
  const renderBlank = useCallback((globalIndex: number) => {
    return revealed > globalIndex ? (
      <span className="inline px-2 py-0.5 mx-1 bg-green-500/20 text-green-600 dark:text-green-400 rounded font-semibold">
        <GlossaryText text={decodeHtml(answers[globalIndex] ?? '')} />
      </span>
    ) : (
      <span
        className="inline-block px-2 py-0.5 mx-1 bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] rounded font-mono cursor-pointer hover:bg-[var(--md-primary)]/30"
        onClick={reveal}
      >
        ___
      </span>
    );
  }, [revealed, answers, reveal]);

  /** Render inline text with [___] replaced by cloze blanks, starting at globalIndex */
  const renderTextWithBlanks = useCallback((text: string, startIndex: number): ReactNode => {
    const segments = decodeHtml(text).split('[___]');
    return segments.map((seg, i) => (
      <Fragment key={i}>
        <InlineMarkdown text={seg} leafRenderer={glossaryLeaf} />
        {i < segments.length - 1 && renderBlank(startIndex + i)}
      </Fragment>
    ));
  }, [renderBlank]);

  return (
    <div className="max-w-xl mx-auto">
      {/* Card */}
      <div className="p-5 rounded-xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)]">
        {/* Image if present. Caption is the harness rule (see
            feedback_image_quality_floor): every image must name what it
            shows and where to look — without it the image is decoration. */}
        {imageUrl && (
          <figure className="mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt={imageMeta ? imageAltForMeta(imageMeta, allRevealed) : (imageCaption ?? 'Card image')}
              className="w-full rounded-lg border border-[var(--md-outline-variant)]"
            />
            {imageCaption && (
              <figcaption className="mt-2 text-sm text-[var(--md-on-surface-variant)] leading-snug">
                {imageCaption}
              </figcaption>
            )}
          </figure>
        )}
        {/* Question with inline answers */}
        {tableData ? (
          <div className="text-base leading-relaxed">
            {tableData.preText && (
              <p className="text-lg mb-2 whitespace-pre-wrap">
                {renderTextWithBlanks(tableData.preText, tableData.segments[0]?.clozeStartIndex ?? 0)}
              </p>
            )}
            <table className="w-full text-sm border-collapse my-2">
              <thead>
                <tr className="border-b border-[var(--md-outline-variant)]">
                  {tableData.table.headers.map((h, i) => (
                    <th key={i} className="py-1.5 px-2 text-left text-xs font-medium text-[var(--md-on-surface-variant)] uppercase tracking-wider">
                      <InlineMarkdown text={h} leafRenderer={glossaryLeaf} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.table.rows.map((row, ri) => {
                  // Calculate the cloze index for this row
                  let rowStartIndex = tableData.segments.find(s => s.type === 'table')?.clozeStartIndex ?? 0;
                  // Count blanks in all previous rows
                  for (let prevRow = 0; prevRow < ri; prevRow++) {
                    for (const cell of tableData.table.rows[prevRow]) {
                      rowStartIndex += (cell.match(/\[___\]/g) ?? []).length;
                    }
                  }
                  let cellIndex = rowStartIndex;
                  return (
                    <tr key={ri} className="border-b border-[var(--md-outline-variant)]/30">
                      {row.map((cell, ci) => {
                        const thisCellStart = cellIndex;
                        const blanksInCell = (cell.match(/\[___\]/g) ?? []).length;
                        cellIndex += blanksInCell;
                        return (
                          <td key={ci} className="py-1.5 px-2">
                            {blanksInCell > 0
                              ? renderTextWithBlanks(cell, thisCellStart)
                              : <InlineMarkdown text={cell} leafRenderer={glossaryLeaf} />
                            }
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tableData.postText && (
              <p className="text-sm mt-2 text-[var(--md-on-surface-variant)] whitespace-pre-wrap">
                {renderTextWithBlanks(
                  tableData.postText,
                  tableData.segments.find(s => s.text === tableData.postText)?.clozeStartIndex ?? 0
                )}
              </p>
            )}
          </div>
        ) : (
          <p className="text-lg leading-relaxed whitespace-pre-wrap">
            {parts.map((part, i) => (
              <Fragment key={i}>
                <InlineMarkdown text={part} leafRenderer={glossaryLeaf} />
                {i < parts.length - 1 && (
                  revealed > i ? (
                    <span className="inline px-2 py-0.5 mx-1 bg-green-500/20 text-green-600 dark:text-green-400 rounded font-semibold">
                      <GlossaryText text={decodedAnswers[i]} />
                    </span>
                  ) : (
                    <span className="inline-block px-2 py-0.5 mx-1 bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] rounded font-mono cursor-pointer hover:bg-[var(--md-primary)]/30"
                      onClick={reveal}>
                      ___
                    </span>
                  )
                )}
              </Fragment>
            ))}
          </p>
        )}

        {/* Context (shown after reveal) */}
        {allRevealed && context && (
          <div className="mt-3 text-sm text-[var(--md-on-surface-variant)]">
            {context.includes('•') ? (
              <ul className="list-disc list-inside space-y-0.5">
                {context.split('•').filter(s => s.trim()).map((item, i) => (
                  <li key={i}><InlineMarkdown text={item.trim()} leafRenderer={glossaryLeaf} /></li>
                ))}
              </ul>
            ) : (
              <p><InlineMarkdown text={context} leafRenderer={glossaryLeaf} /></p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 pt-3 border-t border-[var(--md-outline-variant)]">
          {!allRevealed ? (
            <button
              onClick={reveal}
              className="w-full py-2 text-sm font-medium text-[var(--md-primary)] hover:bg-[var(--md-primary)]/10 active:scale-[0.99] rounded-lg transition-all"
            >
              {isMulti && revealed > 0 ? `Next (${revealed}/${answers.length})` : 'Show'}
            </button>
          ) : (
            <div ref={gradeButtonsRef} className="flex items-center gap-2">
              <ConfidenceButtons mode="inline" onSelect={(confidence) => {
                grade(CONFIDENCE_TO_QUALITY[confidence] ?? 3);
              }} />
              <button
                onClick={toggleFlag}
                className={`p-2 rounded-lg transition-colors ${
                  flagged
                    ? 'text-amber-500 bg-amber-500/20'
                    : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)]'
                }`}
                title="Flag (f)"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill={flagged ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <line x1="4" y1="22" x2="4" y2="15" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Minimal metadata */}
      <div className="mt-2 text-xs text-center text-[var(--md-on-surface-variant)]/60">
        W{week} · {sourceComponent}
      </div>
    </div>
  );
}
