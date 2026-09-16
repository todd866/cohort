import type { HeatmapCell } from '@/lib/review-stats';

/**
 * The contribution grid — one square per day, darker for a heavier day.
 *
 * Extracted from ReviewStats so the profile and the statistics page render the
 * same instrument rather than two that drift. It keeps the blue --md-ramp-*
 * tokens: this grid encodes ORDERED MAGNITUDE (how much did I do), while the
 * topic grid beside it encodes STATE (am I ready). Two scales, two ramps, so
 * nobody reads one as the other.
 *
 * Exam days are ringed and labelled. The grid can run past today, so the run-up
 * to the next exam shows as empty runway rather than being cropped at the
 * present.
 */

export interface ExamMarker {
  /** `YYYY-MM-DD`, matching HeatmapCell.date. */
  date: string;
  label: string;
  /** Percentage, when the exam has been sat and recorded. */
  score?: number | null;
}

const DOW = ['M', '', 'W', '', 'F', '', 'S'];
const CELL = 11;
const GAP = 2.5;
const GUTTER = 18;
/** Room for a three-letter month label sitting on the final column. */
const MONTH_LABEL_OVERHANG = 20;

function monthMarks(heatmap: HeatmapCell[]): { week: number; label: string }[] {
  const marks: { week: number; label: string }[] = [];
  for (const cell of heatmap) {
    if (cell.date.slice(8) !== '01') continue;
    const label = new Date(`${cell.date}T00:00:00Z`).toLocaleDateString('en-AU', {
      month: 'short',
      timeZone: 'UTC',
    });
    if (!marks.some((m) => m.week === cell.week)) marks.push({ week: cell.week, label });
  }
  return marks;
}

function describeExam(exam: ExamMarker): string {
  const scored = typeof exam.score === 'number' ? ` · ${Math.round(exam.score)}%` : '';
  return `${exam.label} exam${scored} · ${exam.date}`;
}

export function ReviewHeatmap({
  heatmap,
  exams = [],
  today,
  caption,
}: {
  heatmap: HeatmapCell[];
  exams?: ExamMarker[];
  /** `YYYY-MM-DD`. Ringed so the boundary between done and to-come is visible. */
  today?: string;
  caption?: string;
}) {
  if (heatmap.length === 0) return null;

  const weeks = Math.max(...heatmap.map((c) => c.week)) + 1;
  // The trailing month label starts at the last column and runs past it, so the
  // canvas needs room beyond the final square or it renders clipped ("Oc").
  const gridWidth = weeks * (CELL + GAP) + GUTTER;
  const width = gridWidth + MONTH_LABEL_OVERHANG;
  const cellByDate = new Map(heatmap.map((c) => [c.date, c]));
  const totalReviews = heatmap.reduce((n, c) => n + c.count, 0);
  const daysStudied = heatmap.reduce((n, c) => n + (c.count > 0 ? 1 : 0), 0);

  const placedExams = exams
    .map((exam) => ({ exam, cell: cellByDate.get(exam.date) }))
    .filter((e): e is { exam: ExamMarker; cell: HeatmapCell } => e.cell !== undefined);

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <div className="inline-block min-w-0">
          <svg width={width} height={12} role="presentation" className="block">
            {monthMarks(heatmap).map((m) => (
              <text
                key={`${m.week}-${m.label}`}
                x={GUTTER + m.week * (CELL + GAP)}
                y={9}
                className="fill-[var(--md-on-surface-variant)]"
                style={{ fontSize: 9 }}
              >
                {m.label}
              </text>
            ))}
          </svg>

          <svg
            width={width}
            height={7 * (CELL + GAP)}
            role="img"
            aria-label={`Review calendar: ${totalReviews} reviews across ${daysStudied} days`}
          >
            {DOW.map((d, i) =>
              d ? (
                <text
                  key={i}
                  x={0}
                  y={i * (CELL + GAP) + CELL - 1}
                  className="fill-[var(--md-on-surface-variant)]"
                  style={{ fontSize: 8 }}
                >
                  {d}
                </text>
              ) : null,
            )}

            {heatmap.map((c) => (
              <rect
                key={c.date}
                data-testid={`heat-day-${c.date}`}
                x={GUTTER + c.week * (CELL + GAP)}
                y={c.weekday * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2}
                fill={`var(--md-ramp-${c.level})`}
              >
                <title>{`${c.date} · ${c.count} review${c.count === 1 ? '' : 's'}`}</title>
              </rect>
            ))}

            {today && cellByDate.has(today) && (
              <rect
                data-testid="heat-today"
                x={GUTTER + cellByDate.get(today)!.week * (CELL + GAP) - 1}
                y={cellByDate.get(today)!.weekday * (CELL + GAP) - 1}
                width={CELL + 2}
                height={CELL + 2}
                rx={3}
                fill="none"
                stroke="var(--md-on-surface-variant)"
                strokeWidth={1}
              />
            )}

            {placedExams.map(({ exam, cell }) => (
              <g key={exam.date} data-testid={`heat-exam-${exam.date}`}>
                {/* A full-height column tick, so an exam is findable without
                    hunting for one ringed square among two hundred. */}
                <rect
                  x={GUTTER + cell.week * (CELL + GAP) - 1.5}
                  y={-1}
                  width={CELL + 3}
                  height={7 * (CELL + GAP)}
                  rx={3}
                  fill="none"
                  stroke="var(--md-primary)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  opacity={0.55}
                />
                <rect
                  x={GUTTER + cell.week * (CELL + GAP) - 1}
                  y={cell.weekday * (CELL + GAP) - 1}
                  width={CELL + 2}
                  height={CELL + 2}
                  rx={3}
                  fill="none"
                  stroke="var(--md-primary)"
                  strokeWidth={1.5}
                />
                <title>{describeExam(exam)}</title>
              </g>
            ))}
          </svg>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--md-on-surface-variant)]">Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span
              key={l}
              className="inline-block h-2.5 w-2.5 rounded-[2px]"
              style={{ background: `var(--md-ramp-${l})` }}
              aria-hidden
            />
          ))}
          <span className="text-xs text-[var(--md-on-surface-variant)]">More</span>
        </span>
        {placedExams.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-[2px] border-[1.5px] border-[var(--md-primary)]"
            />
            <span className="text-xs text-[var(--md-on-surface-variant)]">
              {placedExams.map(({ exam }) => describeExam(exam).replace(` · ${exam.date}`, '')).join(' · ')}
            </span>
          </span>
        )}
      </div>

      {caption && (
        <p className="mt-1.5 text-xs text-[var(--md-on-surface-variant)]">{caption}</p>
      )}
    </div>
  );
}
