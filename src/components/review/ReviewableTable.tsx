'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { QuizTable } from '@/components/content/QuizTable';
import { ContentFlag } from '@/components/content/ContentFlag';
import { useReviewMode } from '@/components/review/ReviewModeProvider';
import { normalizeSnapshot } from '@/components/content/content-flag-utils';
import { hashStringHex } from '@/lib/utils/hash';
import { shuffle } from '@/lib/utils/shuffle';

interface TableCell {
  content: string;
  isHeader?: boolean;
}

interface TableRow {
  cells: TableCell[];
}

function getTableSignature(rows: TableRow[]): string {
  return rows
    .map((row) => row.cells.map((cell) => cell.content).join('\u001F'))
    .join('\u001E');
}

function parseTableData(tableEl: HTMLTableElement | null): TableRow[] {
  if (!tableEl) return [];

  const rows = Array.from(tableEl.querySelectorAll('tr'));
  const parsed: TableRow[] = rows.map((tr, rowIndex) => {
    const cells = Array.from(tr.children)
      .filter((el) => el.tagName === 'TH' || el.tagName === 'TD')
      .map((el) => ({
        content: (el.textContent || '').trim(),
        isHeader: rowIndex === 0 || el.tagName === 'TH',
      }));

    return { cells };
  });

  // Only treat it as a quiz if it's a real table (>= 2 rows, >= 2 cols).
  const hasEnoughStructure =
    parsed.length >= 2 &&
    parsed[0]?.cells?.length >= 2 &&
    parsed.some((r) => r.cells.some((c) => !c.isHeader && c.content.length > 0));

  return hasEnoughStructure ? parsed : [];
}

function getWeeklyPracticeBlankCount(candidateCount: number): number {
  if (candidateCount <= 0) return 0;
  if (candidateCount <= 3) return 1;
  if (candidateCount <= 8) return 2;
  return 3;
}

function getWeeklyPracticeHiddenCells(rows: TableRow[]): Array<{ row: number; col: number }> {
  if (rows.length <= 1) return [];

  const numCols = rows[0]?.cells.length ?? 0;
  const startCol = numCols > 1 ? 1 : 0;
  const candidates: Array<{ row: number; col: number }> = [];

  for (let row = 1; row < rows.length; row += 1) {
    for (let col = startCol; col < numCols; col += 1) {
      const content = rows[row]?.cells[col]?.content?.trim();
      if (!content) continue;
      candidates.push({ row, col });
    }
  }

  return shuffle(candidates).slice(0, Math.min(candidates.length, getWeeklyPracticeBlankCount(candidates.length)));
}

function WeeklyPracticeTable({
  data,
  tableId,
  tableSnapshot,
}: {
  data: TableRow[];
  tableId: string;
  tableSnapshot: string;
}) {
  const hiddenCells = useMemo(() => getWeeklyPracticeHiddenCells(data), [data]);
  const hiddenKeys = useMemo(
    () => new Set(hiddenCells.map(({ row, col }) => `${row}-${col}`)),
    [hiddenCells],
  );
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(() => new Set());
  const [lastHiddenCells, setLastHiddenCells] = useState(hiddenCells);
  // Reset revealed keys when the underlying hidden-cell set changes.
  // React-approved 'reset state while rendering' pattern.
  if (lastHiddenCells !== hiddenCells) {
    setLastHiddenCells(hiddenCells);
    setRevealedKeys(new Set());
  }

  const remainingCount = hiddenCells.filter(({ row, col }) => !revealedKeys.has(`${row}-${col}`)).length;

  return (
    <div
      data-content-block
      data-quiz-table
      className="my-8 w-full max-w-full overflow-hidden rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--md-on-surface-variant)]">
            Table
          </span>
          <span className="text-xs text-[var(--md-on-surface-variant)]">
            {hiddenCells.length} blank{hiddenCells.length === 1 ? '' : 's'} · click to reveal
          </span>
        </div>
        <ContentFlag
          targetType="component"
          targetId={tableId}
          componentType="Table"
          contentSnapshot={tableSnapshot}
        />
      </div>
      <div className="w-full overflow-x-auto">
        <table className="min-w-full border-collapse">
          <tbody>
            {data.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className={rowIndex === 0
                  ? 'bg-[var(--md-surface-container)]'
                  : 'border-t border-[var(--md-outline-variant)]'
                }
              >
                {row.cells.map((cell, colIndex) => {
                  const key = `${rowIndex}-${colIndex}`;
                  const hidden = hiddenKeys.has(key);
                  const revealed = revealedKeys.has(key);
                  const isHeader = rowIndex === 0 || cell.isHeader;

                  return (
                    <td key={colIndex} className={`px-4 py-3 ${isHeader ? 'font-semibold' : ''}`}>
                      {hidden && !revealed ? (
                        <button
                          type="button"
                          aria-label="Reveal hidden cell"
                          data-quiz-table-reveal
                          onClick={() => {
                            setRevealedKeys((prev) => {
                              const next = new Set(prev);
                              next.add(key);
                              return next;
                            });
                          }}
                          className="block h-11 w-full min-w-[96px] rounded-lg border-2 border-dashed border-[var(--md-outline)] bg-[var(--md-surface-container-high)] transition-colors hover:bg-[var(--md-surface-container-highest)]"
                        />
                      ) : (
                        <span className="text-[var(--md-on-surface)]">{cell.content}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {remainingCount > 0 && (
        <div className="border-t border-[var(--md-outline-variant)] bg-[var(--md-surface-container-lowest)] px-4 py-2 text-xs text-[var(--md-on-surface-variant)]">
          Click the missing box{remainingCount === 1 ? '' : 'es'} to reveal.
        </div>
      )}
    </div>
  );
}

export function ReviewableTable({ children }: { children: ReactNode }) {
  const { enabled, rotation, week, topics } = useReviewMode();
  const pathname = usePathname();
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [data, setData] = useState<TableRow[] | null>(null);
  const [hasParsed, setHasParsed] = useState(false);

  // Parse table data after DOM is mounted
  useEffect(() => {
    if (hasParsed) return;

    // Small delay to ensure DOM is fully rendered
    const timer = requestAnimationFrame(() => {
      if (tableRef.current) {
        const parsed = parseTableData(tableRef.current);
        setData(parsed);
        setHasParsed(true);
      }
    });

    return () => cancelAnimationFrame(timer);
  }, [hasParsed]);

  const weeklyPathMatch = useMemo(() => {
    if (!pathname) return null;
    return pathname.match(/^\/(critical-care|paam|cah|pwh)\/week\/(\d+)(?:\/review)?$/);
  }, [pathname]);

  const resolvedRotation = rotation ?? weeklyPathMatch?.[1] ?? undefined;
  const resolvedWeek = week ?? (weeklyPathMatch?.[2] ? parseInt(weeklyPathMatch[2], 10) : undefined);
  const isWeekNotesPage = Boolean(weeklyPathMatch && !pathname?.endsWith('/review'));

  const tableSignature = useMemo(() => {
    if (!data || data.length === 0) return null;
    return getTableSignature(data);
  }, [data]);

  const tableId = useMemo(() => {
    if (!tableSignature) return null;

    const hash = hashStringHex(tableSignature);
    const safeRotation = resolvedRotation || 'unknown';
    const safeWeek = resolvedWeek ?? 0;
    return `mdx-table-${safeRotation}-week${safeWeek}-${hash}`;
  }, [resolvedRotation, resolvedWeek, tableSignature]);

  const tableSnapshot = useMemo(() => {
    if (!data || data.length === 0) return '';
    const readable = data
      .map((row) => row.cells.map((cell) => cell.content).join(' | '))
      .join(' ');
    return normalizeSnapshot(readable);
  }, [data]);

  const occludeCount = useMemo(() => {
    if (!data || data.length === 0) return 0;
    const numCols = data[0]?.cells?.length ?? 0;
    const possibleCells = Math.max(0, (data.length - 1) * numCols);
    return Math.min(8, Math.max(3, Math.floor(possibleCells * 0.3)));
  }, [data]);

  if (!enabled && isWeekNotesPage && data && data.length > 0 && tableId) {
    return (
      <WeeklyPracticeTable
        data={data}
        tableId={tableId}
        tableSnapshot={tableSnapshot}
      />
    );
  }

  // Not in review mode - render plain table
  if (!enabled) {
    return (
      <div data-content-block className="my-8 w-full max-w-full overflow-hidden rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)]">
        {tableId && (
          <div className="flex items-center justify-between gap-3 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--md-on-surface-variant)]">
              Table
            </span>
            <div className="flex items-center gap-2">
              <ContentFlag
                targetType="component"
                targetId={tableId}
                componentType="Table"
                contentSnapshot={tableSnapshot}
              />
            </div>
          </div>
        )}
        <div className="relative w-full overflow-x-auto">
          <table ref={tableRef} className="min-w-full border-collapse">
            {children}
          </table>
        </div>
      </div>
    );
  }

  // In review mode and we have valid table data - render QuizTable
  if (data && data.length > 0 && tableId) {
    return (
      <QuizTable
        id={tableId}
        title="Table Review"
        data={data}
        occlude="random"
        occludeCount={occludeCount}
        rotation={resolvedRotation}
        week={resolvedWeek}
        topics={topics}
      />
    );
  }

  // In review mode but haven't parsed yet - render table with ref for parsing
  return (
    <div data-content-block className="my-8 w-full overflow-x-auto rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)]">
      <table ref={tableRef} className="min-w-full border-collapse">
        {children}
      </table>
    </div>
  );
}
