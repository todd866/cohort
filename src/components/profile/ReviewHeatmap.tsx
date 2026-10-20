'use client';

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { USYD_MD3_2026 } from '@/lib/curriculum/usyd-md3-2026';
import {
  blockOn,
  blocksFromPeriods,
  dayAriaLabel,
  daysForZoom,
  examLegend,
  labelBlocks,
  medianStudyDay,
  monthBoards,
  pullForwardHref,
  replayHref,
  usualDeltaLabel,
  type CalendarExam,
  type CalendarZoom,
  type LabeledBlock,
} from '@/lib/stats/calendar-grid';
import { setCalendarZoom, toStatsLayoutSetting, type AppliedStatsLayout } from '@/lib/stats/stats-layout';
import { CALENDAR_DAY_ENDPOINT } from '@/lib/stats/private-surfaces';
import type { HeatmapCell } from '@/lib/review-stats';
import { levelFor, intensityLevels } from '@/lib/review-stats';
import { nextLayoutRevision } from '@/components/stats/StatsLayoutShell';
import { StatsLayoutContext } from '@/components/stats/stats-layout-context';

export interface ExamMarker {
  date: string;
  label: string;
  score?: number | null;
  resultId?: string | null;
  rotation?: string;
}

interface PopoverBody {
  future: boolean;
  reviews: number;
  correctPct: number | null;
  minutes: number;
  rotations: string;
  topics: string;
  due: string;
  dueTotal: number;
}

const WEEKDAYS = [
  { name: 'Monday', short: 'M' },
  { name: 'Tuesday', short: 'T' },
  { name: 'Wednesday', short: 'W' },
  { name: 'Thursday', short: 'T' },
  { name: 'Friday', short: 'F' },
  { name: 'Saturday', short: 'S' },
  { name: 'Sunday', short: 'S' },
];

const ZOOMS: Array<{ id: CalendarZoom; text: string }> = [
  { id: 'month', text: 'Month' },
  { id: 'block', text: 'Block' },
  { id: 'year', text: 'Year' },
];

function hit(zoom: CalendarZoom): number {
  if (zoom === 'year') return 9;
  if (zoom === 'month') return 36;
  return 24;
}

function examOf(exams: ExamMarker[], date: string): ExamMarker | undefined {
  return exams.find((exam) => exam.date === date);
}

function asCalendarExam(exam: ExamMarker): CalendarExam {
  return {
    date: exam.date,
    label: exam.label,
    rotation: exam.rotation ?? exam.label,
    score: exam.score ?? null,
    resultId: exam.resultId ?? null,
  };
}

export function ReviewHeatmap({
  heatmap,
  exams = [],
  today,
  blocks,
  zoom: zoomProp,
  layout = null,
  layoutEndpoint = null,
  examLinkBase = '/profile',
}: {
  heatmap: HeatmapCell[];
  exams?: ExamMarker[];
  today?: string;
  blocks?: LabeledBlock[];
  zoom?: CalendarZoom;
  layout?: AppliedStatsLayout | null;
  layoutEndpoint?: string | null;
  /** Empty when the exams panel is on this page. */
  examLinkBase?: string;
}) {
  const layoutContext = useContext(StatsLayoutContext);
  const counts = useMemo(() => new Map(heatmap.map((cell) => [cell.date, cell.count])), [heatmap]);
  const thresholds = useMemo(() => intensityLevels([...counts.values()]), [counts]);
  const median = useMemo(() => medianStudyDay([...counts.values()]), [counts]);
  const curriculumBlocks = useMemo(
    () => (blocks && blocks.length > 0 ? blocks : labelBlocks(blocksFromPeriods(USYD_MD3_2026.assessmentPeriods), [], [])),
    [blocks],
  );
  const todayDay = today ?? heatmap[heatmap.length - 1]?.date ?? curriculumBlocks[0]?.start ?? '2026-01-01';
  const minYear = Number((heatmap[0]?.date ?? todayDay).slice(0, 4));
  const [zoomLocal, setZoomLocal] = useState<CalendarZoom>(zoomProp ?? layout?.zoom ?? 'block');
  const zoom = layoutContext?.layout.zoom ?? zoomLocal;
  const [year, setYear] = useState(Number(todayDay.slice(0, 4)));
  const [month, setMonth] = useState(Number(todayDay.slice(5, 7)));
  const [blockId, setBlockId] = useState(blockOn(curriculumBlocks, todayDay)?.id ?? curriculumBlocks[0]?.id ?? '');
  const currentBlockId = blockId || blockOn(curriculumBlocks, todayDay)?.id || '';
  const block = curriculumBlocks.find((item) => item.id === currentBlockId) ?? null;
  const days = useMemo(
    () => daysForZoom({ zoom, today: todayDay, year, month, block }),
    [zoom, todayDay, year, month, block],
  );
  const boards = useMemo(() => monthBoards(days), [days]);
  const [focus, setFocus] = useState(days.includes(todayDay) ? todayDay : days[0]);
  const active = days.includes(focus) ? focus : (days.includes(todayDay) ? todayDay : days[0] ?? focus);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState<PopoverBody | null>(null);
  const [anchor, setAnchor] = useState(focus);
  const drag = useRef<{ origin: string; current: string; moved: boolean } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const selection = open && range ? range : null;
  const selected = useMemo(() => {
    if (!selection) return new Set<string>();
    const [from, to] = selection.from <= selection.to ? [selection.from, selection.to] : [selection.to, selection.from];
    return new Set(days.filter((day) => day >= from && day <= to));
  }, [selection, days]);

  const persist = useCallback((next: CalendarZoom) => {
    setZoomLocal(next);
    if (layoutContext) {
      layoutContext.save(setCalendarZoom(layoutContext.layout, next));
      return;
    }
    if (!layout || !layoutEndpoint) return;
    const rev = nextLayoutRevision();
    void fetch(layoutEndpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...toStatsLayoutSetting(setCalendarZoom(layout, next)), rev }),
    });
  }, [layout, layoutEndpoint, layoutContext]);
  // Only the latest day request may fill the popover; an older one finishing
  // late would show another day's numbers beside this day's replay button.
  const dayRequest = useRef<AbortController | null>(null);
  useEffect(() => () => dayRequest.current?.abort(), []);
  function openDays(from: string, to: string) {
    const [a, b] = from <= to ? [from, to] : [to, from];
    setRange({ from: a, to: b });
    setOpen(true);
    setBody(null);
    dayRequest.current?.abort();
    const controller = new AbortController();
    dayRequest.current = controller;
    // Without the breakdown route (public build) or when it fails, the popover
    // still shows the squares' own counts rather than zeros.
    let localReviews = 0;
    for (const [day, count] of counts) if (day >= a && day <= b) localReviews += count;
    const localBody: PopoverBody = {
      future: a > todayDay,
      reviews: localReviews,
      correctPct: null,
      minutes: 0,
      rotations: '',
      topics: '',
      due: '',
      dueTotal: 0,
    };
    if (!CALENDAR_DAY_ENDPOINT) { setBody(localBody); return; }
    const params = new URLSearchParams({ from: a, to: b });
    void fetch(`${CALENDAR_DAY_ENDPOINT}?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('unavailable');
        const next = await response.json() as PopoverBody;
        if (dayRequest.current === controller) setBody(next);
      })
      .catch(() => dayRequest.current === controller && !controller.signal.aborted && setBody(localBody));
  }

  function move(day: string, delta: number) {
    const index = days.indexOf(day);
    const next = days[Math.max(0, Math.min(days.length - 1, index + delta))];
    if (next) setFocus(next);
  }

  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const index = ZOOMS.findIndex((item) => item.id === zoom);
      const next = event.deltaY > 0 ? Math.min(ZOOMS.length - 1, index + 1) : Math.max(0, index - 1);
      if (ZOOMS[next] && ZOOMS[next].id !== zoom) persist(ZOOMS[next].id);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [zoom, persist]);

  useEffect(() => {
    const current = document.activeElement;
    if (!current || !gridRef.current?.contains(current)) return;
    const node = gridRef.current.querySelector<HTMLButtonElement>(`[data-testid="heat-day-${active}"]`);
    if (node && node !== current) node.focus();
  }, [active]);

  if (heatmap.length === 0 && curriculumBlocks.length === 0) return null;

  const size = hit(zoom);
  const spanLabel = zoom === 'year'
    ? String(year)
    : zoom === 'month'
      ? boards[0]?.label ?? ''
      : block?.label ?? '';
  const futureOnly = range ? range.from > todayDay : false;
  const singleExam = range && range.from === range.to ? examOf(exams, range.from) : undefined;
  const action = range
    ? (futureOnly ? pullForwardHref(range.from) : replayHref(range.from, range.to))
    : '/review';
  const actionLabel = !range
    ? 'Review'
    : futureOnly
      ? 'Pull some forward'
      : range.from === range.to
        ? 'Review that day again'
        : 'Review this range';
  const usual = body && !body.future && range
    ? usualDeltaLabel(
      [...selected].reduce((sum, day) => sum + (counts.get(day) ?? 0), 0) || body.reviews,
      median,
    )
    : null;

  function step(delta: -1 | 1) {
    if (zoom === 'year') setYear((value) => Math.max(minYear, value + delta));
    else if (zoom === 'month') {
      const next = new Date(Date.UTC(year, month - 1 + delta, 1));
      setYear(next.getUTCFullYear());
      setMonth(next.getUTCMonth() + 1);
    } else if (block) {
      const index = curriculumBlocks.findIndex((item) => item.id === block.id);
      const next = curriculumBlocks[index + delta];
      if (next) setBlockId(next.id);
    }
  }

  function goExam(exam: ExamMarker) {
    const id = exam.resultId ? `exam-${exam.resultId}` : 'exam-next';
    if (examLinkBase) {
      window.location.assign(`${examLinkBase}#${id}`);
      return;
    }
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }

  const rows: Array<{ label: string; value: string; title?: string }> = [];
  if (body?.future) {
    rows.push({ label: 'due', value: String(body.dueTotal) });
    if (body.due) rows.push({ label: 'rotations', value: body.due });
  } else if (body) {
    rows.push({ label: 'reviews', value: String(body.reviews) });
    rows.push({ label: 'correct', value: body.correctPct == null ? '–' : `${Math.round(body.correctPct)}%` });
    rows.push({ label: 'minutes', value: String(body.minutes), title: 'Answer time, each answer capped at 60 s' });
    if (body.rotations) rows.push({ label: 'rotations', value: body.rotations });
    if (body.topics) rows.push({ label: 'topics', value: body.topics });
    if (usual) rows.push({ label: 'usual', value: usual, title: 'Compared with the median study day' });
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Calendar zoom" className="inline-flex overflow-hidden rounded-lg border border-[var(--md-outline-soft)] text-sm">
          {ZOOMS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={zoom === item.id}
              onClick={() => persist(item.id)}
              className={`inline-flex min-h-9 items-center px-2.5 ${zoom === item.id ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)]'}`}
            >
              {item.text}
            </button>
          ))}
        </div>
        <div className="ml-auto inline-flex items-center gap-1">
          <button type="button" aria-label="Previous" onClick={() => step(-1)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--md-outline-soft)] text-[var(--md-on-surface)]">‹</button>
          <span className="min-w-16 text-center text-sm tabular-nums text-[var(--md-on-surface)]">{spanLabel}</span>
          <button type="button" aria-label="Next" onClick={() => step(1)} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--md-outline-soft)] text-[var(--md-on-surface)]">›</button>
        </div>
      </div>

      <div
        ref={gridRef}
        className={`${zoom === 'year'
          ? 'grid grid-cols-3 gap-x-3 gap-y-2 min-[640px]:grid-cols-4'
          : zoom === 'block'
            ? 'grid grid-cols-1 gap-3 min-[640px]:grid-cols-2'
            : 'grid grid-cols-1'}`}
        onPointerUp={(event) => {
          const current = drag.current;
          drag.current = null;
          if (!current || event.shiftKey) return;
          const end = current.current;
          if (examOf(exams, end) && !current.moved) return;
          openDays(current.origin, end);
        }}
      >
        {boards.map((board) => (
          <div key={board.key}>
            <div className="mb-0.5 text-[0.7rem] text-[var(--md-on-surface-variant)]">{zoom === 'year' ? board.label.slice(0, 3) : board.label}</div>
            {zoom !== 'year' && (
              <div data-testid="heat-weekdays" className="mb-0.5 grid" style={{ gridTemplateColumns: `repeat(7, ${size}px)`, gap: 2 }} aria-hidden>
                {WEEKDAYS.map((day) => (
                  <span key={day.name} className="text-center text-[10px] leading-none text-[var(--md-on-surface-variant)]">{day.short}</span>
                ))}
              </div>
            )}
            <div className="grid" style={{ gridTemplateColumns: `repeat(7, ${size}px)`, gap: 2 }} role="grid" aria-label={board.label}>
              {board.cells.map((date, index) => {
                if (!date) return <span key={`${board.key}-pad-${index}`} aria-hidden />;
                const count = counts.get(date) ?? 0;
                const level = levelFor(count, thresholds);
                const exam = examOf(exams, date);
                const isToday = date === todayDay;
                const isFuture = date > todayDay;
                const inRange = selected.has(date);
                const showCount = zoom === 'month' && count > 0 && !isFuture;
                const rings = [
                  exam ? 'inset 0 0 0 2px var(--md-on-surface)' : null,
                  !exam && isToday ? 'inset 0 0 0 1px var(--md-on-surface)' : null,
                  !exam && inRange ? 'inset 0 0 0 1px var(--md-on-surface)' : null,
                ].filter(Boolean).join(', ');
                return (
                  <button
                    key={date}
                    type="button"
                    role="gridcell"
                    data-testid={`heat-day-${date}`}
                    data-exam={exam ? exam.date : undefined}
                    tabIndex={date === active ? 0 : -1}
                    aria-label={exam ? `${dayAriaLabel(date, count, todayDay)}, ${exam.label}` : dayAriaLabel(date, count, todayDay)}
                    aria-current={isToday ? 'date' : undefined}
                    className="relative box-border rounded-[3px] p-0"
                    style={{
                      width: size,
                      height: size,
                      background: `var(--md-ramp-${level})`,
                      opacity: isFuture && !exam ? 0.45 : 1,
                      boxShadow: rings || undefined,
                    }}
                    onFocus={() => setFocus(date)}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || event.shiftKey) return;
                      drag.current = { origin: date, current: date, moved: false };
                      setAnchor(date);
                      setFocus(date);
                    }}
                    onPointerEnter={() => {
                      if (!drag.current) return;
                      drag.current.moved = true;
                      drag.current.current = date;
                      setFocus(date);
                    }}
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openDays(anchor, date);
                        return;
                      }
                      if (exam && event.detail > 0) goExam(exam);
                    }}
                    onKeyDown={(event) => {
                      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -7 : event.key === 'ArrowDown' ? 7 : 0;
                      if (delta) {
                        event.preventDefault();
                        move(date, delta);
                        return;
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        openDays(date, date);
                      }
                      if (event.key === 'Escape') setOpen(false);
                    }}
                  >
                    {zoom === 'month' && (
                      <span className="flex h-full flex-col items-center justify-center leading-none text-[var(--md-on-surface)]">
                        <span className={`${showCount ? 'text-[11px]' : 'text-[13px]'} tabular-nums`}>{Number(date.slice(8))}</span>
                        {showCount && <span className="text-[12px] font-semibold tabular-nums">{count}</span>}
                      </span>
                    )}
                    {exam && (
                      <span
                        data-testid="heat-exam-mark"
                        aria-hidden
                        className="absolute right-px top-px rounded-full bg-[var(--md-on-surface)]"
                        style={{ width: zoom === 'year' ? 3 : 5, height: zoom === 'year' ? 3 : 5, boxShadow: '0 0 0 1px var(--md-surface)' }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {open && range && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={range.from === range.to ? range.from : `${range.from} to ${range.to}`}
          className="mt-2 w-full max-w-[16rem] rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-2 shadow-[var(--md-shadow-2)]"
        >
          {singleExam && (
            <button type="button" onClick={() => goExam(singleExam)} className="mb-1 flex min-h-9 w-full items-center justify-between text-left text-sm text-[var(--md-on-surface)]">
              <span>{singleExam.label}</span>
              <span className="tabular-nums">{typeof singleExam.score === 'number' ? `${Math.round(singleExam.score)}%` : 'exam'}</span>
            </button>
          )}
          {!body && <div className="min-h-9 tabular-nums text-[var(--md-on-surface-variant)]">…</div>}
          {rows.map((row) => (
            <div key={row.label} title={row.title} className="grid min-h-7 grid-cols-[5.25rem_1fr] items-baseline gap-2">
              <span className="text-xs text-[var(--md-on-surface-variant)]">{row.label}</span>
              {row.label === 'topics' ? (
                // One topic per line, cut at the column edge; the full name is on hover.
                <span className="min-w-0 text-right text-sm font-semibold tabular-nums text-[var(--md-on-surface)]">
                  {row.value.split(' · ').map((topic) => (
                    <span key={topic} className="block truncate" title={topic}>{topic}</span>
                  ))}
                </span>
              ) : (
                <span className="text-right text-sm font-semibold tabular-nums text-[var(--md-on-surface)]">{row.value}</span>
              )}
            </div>
          ))}
          <a href={action} className="mt-2 flex min-h-9 items-center justify-center rounded-lg bg-[var(--md-primary)] px-3 text-sm text-[var(--md-on-primary)]">
            {actionLabel}
          </a>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1">
          <span className="text-xs text-[var(--md-on-surface-variant)]">Less</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span key={level} aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: `var(--md-ramp-${level})` }} />
          ))}
          <span className="text-xs text-[var(--md-on-surface-variant)]">More</span>
        </span>
        {exams.length > 0 && (
          <span className="flex flex-wrap items-center gap-1 text-xs text-[var(--md-on-surface-variant)]">
            <span aria-hidden data-testid="heat-exam-swatch" className="relative inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: 'var(--md-ramp-2)', boxShadow: 'inset 0 0 0 2px var(--md-on-surface)' }}>
              <span className="absolute right-0 top-0 h-[3px] w-[3px] rounded-full bg-[var(--md-on-surface)]" />
            </span>
            <span data-testid="heat-legend">{examLegend(exams.map(asCalendarExam), todayDay)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
