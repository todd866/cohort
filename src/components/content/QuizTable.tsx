'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useQuizTracking } from '@/hooks/useTracking';
import { genClientRequestId } from '@/lib/client-request-id';
import { ContentFlag } from './ContentFlag';
import { buildFlagId, normalizeSnapshot } from './content-flag-utils';
import {
  CLIENT_FETCH_DEADLINE_MS,
  fetchWithDeadline,
} from '@/lib/fetch-with-deadline';

interface TableCell {
  content: string;
  isHeader?: boolean;
}

interface TableRow {
  cells: TableCell[];
}

interface QuizTableProps {
  id?: string;
  title?: string;
  data: TableRow[];
  occlude?: 'random' | 'last-column' | 'all-but-first' | number; // number = specific column index
  occludeCount?: number; // for 'random' mode, how many cells to occlude
  rotation?: string;
  week?: number;
  topics?: string[];
  toolbarActionLabel?: string;
  onToolbarAction?: () => void;
}

interface CellState {
  revealed: boolean;
  knew: boolean | null;
}

export function QuizTable({
  id,
  title,
  data,
  occlude = 'last-column',
  occludeCount = 5,
  rotation,
  week,
  topics = [],
  toolbarActionLabel,
  onToolbarAction,
}: QuizTableProps) {
  const { onStart, onComplete } = useQuizTracking(id || title);
  const hasStarted = useRef(false);
  const [quizVersion, setQuizVersion] = useState(0);
  const hasMounted = useRef(false);

  // Determine which cells should be occluded based on mode
  const occludedCells = useMemo(() => {
    const cells: Array<{ row: number; col: number }> = [];

    if (data.length <= 1) return cells; // Don't occlude if only header row

    const numCols = data[0]?.cells.length || 0;

    switch (occlude) {
      case 'last-column':
        // Occlude last column (excluding header)
        for (let row = 1; row < data.length; row++) {
          cells.push({ row, col: numCols - 1 });
        }
        break;

      case 'all-but-first':
        // Occlude all columns except first (excluding header)
        for (let row = 1; row < data.length; row++) {
          for (let col = 1; col < numCols; col++) {
            cells.push({ row, col });
          }
        }
        break;

      case 'random':
        // Randomly select cells to occlude (excluding header row)
        const allCells: Array<{ row: number; col: number; sortKey: number }> = [];
        const seed = quizVersion + 1;
        for (let row = 1; row < data.length; row++) {
          for (let col = 0; col < numCols; col++) {
            const sortKey = (
              ((row + 1) * 73856093) ^
              ((col + 1) * 19349663) ^
              (seed * 83492791)
            ) >>> 0;
            allCells.push({ row, col, sortKey });
          }
        }
        const shuffled = allCells.sort((a, b) => a.sortKey - b.sortKey);
        cells.push(
          ...shuffled
            .slice(0, Math.min(occludeCount, shuffled.length))
            .map(({ row, col }) => ({ row, col }))
        );
        break;

      default:
        // Specific column index
        if (typeof occlude === 'number' && occlude >= 0 && occlude < numCols) {
          for (let row = 1; row < data.length; row++) {
            cells.push({ row, col: occlude });
          }
        }
    }

    return cells;
  }, [data, occlude, occludeCount, quizVersion]);

  const createCellStates = useCallback(() => {
    return new Map(
      occludedCells.map(({ row, col }) => [`${row}-${col}`, { revealed: false, knew: null }])
    );
  }, [occludedCells]);

  // Track state for each occluded cell
  const [cellStates, setCellStates] = useState<Map<string, CellState>>(() => createCellStates());

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    setCellStates(createCellStates());
  }, [createCellStates]);

  const [quizComplete, setQuizComplete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pendingRequestId = useRef<string | null>(null);

  const tableSignature = useMemo(() => {
    return data
      .map((row) => row.cells.map((cell) => cell.content).join(' | '))
      .join('\n');
  }, [data]);

  const flagId = useMemo(
    () => (id ? id : buildFlagId('QuizTable', tableSignature)),
    [id, tableSignature]
  );
  const flagSnapshot = normalizeSnapshot([title, tableSignature].filter(Boolean).join(' '));

  const isOccluded = useCallback((row: number, col: number) => {
    return occludedCells.some(c => c.row === row && c.col === col);
  }, [occludedCells]);

  const getCellState = useCallback((row: number, col: number): CellState | undefined => {
    return cellStates.get(`${row}-${col}`);
  }, [cellStates]);

  const revealCell = useCallback((row: number, col: number) => {
    // Track quiz start on first reveal
    if (!hasStarted.current) {
      hasStarted.current = true;
      onStart();
    }

    setCellStates(prev => {
      const newMap = new Map(prev);
      const key = `${row}-${col}`;
      const current = newMap.get(key);
      if (current && !current.revealed) {
        newMap.set(key, { ...current, revealed: true });
      }
      return newMap;
    });
  }, [onStart]);

  const markCell = useCallback((row: number, col: number, knew: boolean) => {
    setCellStates(prev => {
      const newMap = new Map(prev);
      const key = `${row}-${col}`;
      const current = newMap.get(key);
      if (current) {
        newMap.set(key, { ...current, knew });
      }
      return newMap;
    });
  }, []);

  // Check if all cells have been answered
  const allAnswered = useMemo(() => {
    return Array.from(cellStates.values()).every(state => state.knew !== null);
  }, [cellStates]);

  // Calculate results
  const results = useMemo(() => {
    const states = Array.from(cellStates.values());
    const answered = states.filter(s => s.knew !== null);
    const correct = states.filter(s => s.knew === true).length;
    const total = states.length;
    return {
      correct,
      incorrect: answered.length - correct,
      total,
      percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    };
  }, [cellStates]);

  const submitResults = useCallback(async () => {
    if (!allAnswered || submitting) return;

    setSubmitError(null);
    setSubmitting(true);

    try {
      // Prepare results data
      const cellResults = occludedCells.map(({ row, col }) => {
        const state = cellStates.get(`${row}-${col}`);
        const content = data[row]?.cells[col]?.content || '';
        return {
          row,
          col,
          content,
          knew: state?.knew ?? false,
        };
      });

      if (!pendingRequestId.current) {
        pendingRequestId.current = genClientRequestId();
      }

      const response = await fetchWithDeadline('/api/quiz/table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientRequestId: pendingRequestId.current,
          tableId: id,
          rotation,
          week,
          topics,
          results: cellResults,
        }),
      }, CLIENT_FETCH_DEADLINE_MS);

      if (!response.ok) {
        throw new Error(await responseError(response, 'Failed to save quiz results'));
      }

      // Track quiz completion
      pendingRequestId.current = null;
      onComplete(results.correct, results.total);
      setQuizComplete(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save quiz results');
      console.error('Failed to submit results:', error);
    } finally {
      setSubmitting(false);
    }
  }, [allAnswered, cellStates, data, id, occludedCells, onComplete, results.correct, results.total, rotation, submitting, topics, week]);

  // Auto-submit when all cells are answered
  const hasAutoSubmitted = useRef(false);
  useEffect(() => {
    if (allAnswered && !quizComplete && !submitting && !hasAutoSubmitted.current && hasStarted.current) {
      hasAutoSubmitted.current = true;
      submitResults();
    }
  }, [allAnswered, quizComplete, submitResults, submitting]);

  const resetQuiz = () => {
    hasStarted.current = false;
    hasAutoSubmitted.current = false;
    pendingRequestId.current = null;
    setSubmitError(null);
    setSubmitting(false);
    setQuizComplete(false);
    setQuizVersion((prev) => prev + 1);
  };

  if (data.length === 0) return null;

  return (
    <div
      data-content-block
      data-quiz-table
      className="my-8 rounded-2xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)] overflow-hidden"
    >
      {/* Header */}
      <div className="px-6 py-4 bg-[var(--md-surface-container)] border-b border-[var(--md-outline-variant)]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="px-3 py-1 text-xs font-bold rounded-full bg-[var(--md-tertiary)] text-[var(--md-on-tertiary)]">
              QUIZ TABLE
            </span>
            {title && (
              <span className="font-medium text-[var(--md-on-surface)]">{title}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="text-sm text-[var(--md-on-surface-variant)]">
              {occludedCells.length} cells
            </div>
            {toolbarActionLabel && onToolbarAction && (
              <button
                type="button"
                onClick={onToolbarAction}
                className="px-3 py-1.5 rounded-lg border border-[var(--md-outline)] text-xs font-medium text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] transition-colors"
              >
                {toolbarActionLabel}
              </button>
            )}
            <ContentFlag
              targetType="component"
              targetId={flagId}
              componentType="QuizTable"
              contentSnapshot={flagSnapshot}
            />
          </div>
        </div>
      </div>

      {/* Instructions */}
      {!quizComplete && (
        <div className="px-6 py-3 bg-[var(--md-surface-container-lowest)] border-b border-[var(--md-outline-variant)] text-sm text-[var(--md-on-surface-variant)]">
          Click hidden cells to reveal, then mark if you knew the answer
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
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
                  const occluded = isOccluded(rowIndex, colIndex);
                  const state = getCellState(rowIndex, colIndex);
                  const isHeader = rowIndex === 0 || cell.isHeader;

                  return (
                    <td
                      key={colIndex}
                      className={`px-4 py-3 ${isHeader ? 'font-semibold' : ''}`}
                    >
                      {occluded && state ? (
                        <OccludedCell
                          content={cell.content}
                          revealed={state.revealed}
                          knew={state.knew}
                          onReveal={() => revealCell(rowIndex, colIndex)}
                          onMark={(knew) => markCell(rowIndex, colIndex, knew)}
                          disabled={quizComplete || submitting}
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

      {/* Results / Actions */}
      <div className="px-6 py-4 bg-[var(--md-surface-container)] border-t border-[var(--md-outline-variant)]">
        {quizComplete ? (
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-4">
              <div className="text-2xl font-bold text-[var(--md-on-surface)]">
                {results.percentage}%
              </div>
              <div className="text-sm text-[var(--md-on-surface-variant)]">
                <span className="text-green-600 dark:text-green-400">{results.correct} correct</span>
                {' / '}
                <span className="text-red-600 dark:text-red-400">{results.incorrect} missed</span>
              </div>
            </div>
            <button
              onClick={resetQuiz}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--md-outline)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
            >
              Try Again
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="text-sm text-[var(--md-on-surface-variant)]">
              {Array.from(cellStates.values()).filter(s => s.knew !== null).length} / {occludedCells.length}
            </div>
            {submitting && (
              <span className="text-sm text-[var(--md-on-surface-variant)]" role="status">
                Saving...
              </span>
            )}
            {!submitting && submitError && (
              <div className="flex items-center gap-3 flex-wrap justify-end">
                <p className="text-sm text-[var(--md-error)]" role="alert">
                  {submitError}. Your answers are still here.
                </p>
                <button
                  type="button"
                  onClick={submitResults}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] hover:brightness-110"
                >
                  Retry Save
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

interface OccludedCellProps {
  content: string;
  revealed: boolean;
  knew: boolean | null;
  onReveal: () => void;
  onMark: (knew: boolean) => void;
  disabled?: boolean;
}

function OccludedCell({ content, revealed, knew, onReveal, onMark, disabled }: OccludedCellProps) {
  if (!revealed) {
    return (
      <button
        onClick={onReveal}
        disabled={disabled}
        data-quiz-table-reveal
        className="w-full min-w-[80px] h-10 rounded-lg bg-[var(--md-tertiary-container)] border-2 border-dashed border-[var(--md-tertiary)] text-[var(--md-on-tertiary-container)] hover:brightness-95 transition-all flex items-center justify-center gap-2"
      >
        <EyeIcon className="w-4 h-4" />
        <span className="text-sm font-medium">Reveal</span>
      </button>
    );
  }

  if (knew === null) {
    return (
      <div className="flex flex-col gap-2">
        <div className="px-3 py-2 rounded-lg bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] font-medium">
          {content}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onMark(true)}
            disabled={disabled}
            className="flex-1 px-3 py-1.5 rounded-lg bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/60 transition-colors flex items-center justify-center gap-1 text-sm font-medium"
          >
            <CheckIcon className="w-4 h-4" />
            Knew it
          </button>
          <button
            onClick={() => onMark(false)}
            disabled={disabled}
            className="flex-1 px-3 py-1.5 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors flex items-center justify-center gap-1 text-sm font-medium"
          >
            <XIcon className="w-4 h-4" />
            Missed
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`px-3 py-2 rounded-lg font-medium ${
      knew
        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 border border-green-300 dark:border-green-700'
        : 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 border border-red-300 dark:border-red-700'
    }`}>
      <div className="flex items-center gap-2">
        {knew ? (
          <CheckIcon className="w-4 h-4 text-green-600 dark:text-green-400" />
        ) : (
          <XIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
        )}
        {content}
      </div>
    </div>
  );
}

// Helper function to parse markdown table into data structure
export function parseMarkdownTable(markdown: string): TableRow[] {
  const lines = markdown.trim().split('\n').filter(line => line.trim());
  const rows: TableRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip separator lines (|---|---|)
    if (line.match(/^\|[\s\-:|]+\|$/)) continue;

    // Parse table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map(cell => ({
          content: cell.trim(),
          isHeader: i === 0,
        }));

      rows.push({ cells });
    }
  }

  return rows;
}

// Icons
function EyeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
