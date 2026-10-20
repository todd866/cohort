/**
 * Instruments for the statistics and Exam gaps pages. Presentational only (no
 * hooks), so they render on the server and cost no client JavaScript.
 *
 * Instrument rules (owner's house style): one row per instrument, aligned
 * columns, tabular numerals, words behind tooltips, tokens only. Ordered
 * magnitude uses the single-hue --md-ramp-*; outcome uses success/error, and
 * every colour is paired with a value or a symbol so it is never the only signal.
 */
import type { ReactNode } from 'react';
import {
  type ButtonRow,
  type CardState,
  type Forecast,
  type HistogramBin,
  type HourCell,
  type KindAccuracyRow,
  type PracticeListRow,
  type RetentionRow,
  type StageSummary,
  type TodaySummary,
} from '@/lib/stats/stats-model';
import { EstimatedKnowledge } from './EstimatedKnowledge';
import { INSTRUMENT_NUM, INSTRUMENT_NUM_MUTED, SECTION_HEADER } from './instrument-chrome';
import { formatCivilDate } from '@/lib/stats/civil-date';

export function fmtPct(value: number | null | undefined): string {
  return value == null ? '–' : `${Math.round(value)}%`;
}
export function fmtInt(value: number): string {
  return value.toLocaleString('en-AU');
}
export function rotationShort(rotation: string): string {
  return rotation === 'critical-care' ? 'CC' : rotation ? rotation.toUpperCase() : '—';
}

export function Instrument({ title, hint, aside, children }: { title: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="stats-instrument">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 title={hint} className={`${SECTION_HEADER}${hint ? ' cursor-help underline decoration-dotted underline-offset-4' : ''}`}>
          {title}
        </h2>
        <span className="h-px flex-1 bg-[var(--md-outline-soft)]" aria-hidden />
        {aside && <span className="text-xs tabular-nums text-[var(--md-on-surface-variant)]">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A row of value-over-label cells: the compact stat strip. */
export function Readouts({ cells }: { cells: Array<{ value: string; label: string; title?: string; tone?: 'muted' }> }) {
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6">
      {cells.map((c) => (
        <div key={c.label} title={c.title} className="min-w-0">
          <dd className={`text-xl font-semibold leading-tight tabular-nums ${c.tone === 'muted' ? 'text-[var(--md-on-surface-variant)]' : 'text-[var(--md-on-surface)]'}`}>
            {c.value}
          </dd>
          <dt className="truncate text-[0.7rem] text-[var(--md-on-surface-variant)]">{c.label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function TodayReadout({ today }: { today: TodaySummary }) {
  return (
    <Readouts
      cells={[
        { value: fmtInt(today.reviews), label: 'reviews' },
        { value: fmtInt(today.cards), label: 'cloze' },
        { value: fmtInt(today.mcqs), label: 'MCQ' },
        { value: `${today.minutes}`, label: 'minutes', title: 'Answer time, each answer capped at 60 s' },
        { value: fmtPct(today.accuracyPct), label: 'correct', title: 'Cloze not graded Again, plus MCQs answered correctly; revealed answers not counted' },
        { value: today.secondsPerAnswer == null ? '–' : `${Math.round(today.secondsPerAnswer)}`, label: 's / answer' },
      ]}
    />
  );
}

/**
 * Vertical bars, one series, no axis furniture beyond a baseline. Scales to
 * its container width, so it never forces horizontal scroll on a phone.
 */
export function Bars({
  values,
  titles,
  height = 72,
  highlightFirst = false,
  label,
}: {
  values: number[];
  titles: string[];
  height?: number;
  highlightFirst?: boolean;
  label: string;
}) {
  const max = Math.max(1, ...values);
  const n = Math.max(values.length, 1);
  const slot = 100 / n;
  const bar = Math.max(slot * 0.68, 0.4);
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block h-[72px] w-full" role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(1, (v / max) * (height - 2)) : 0;
        return (
          <rect key={i} x={i * slot + (slot - bar) / 2} y={height - 1 - h} width={bar} height={h}
            fill={highlightFirst && i === 0 ? 'var(--md-ramp-3)' : 'var(--md-ramp-4)'}>
            <title>{titles[i]}</title>
          </rect>
        );
      })}
      <line x1={0} x2={100} y1={height - 0.5} y2={height - 0.5} stroke="var(--md-outline-soft)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function AxisEnds({ left, right }: { left: string; right: string }) {
  return (
    <div className="mt-0.5 flex justify-between text-[0.65rem] tabular-nums text-[var(--md-on-surface-variant)]">
      <span>{left}</span>
      <span>{right}</span>
    </div>
  );
}

export function ForecastInstrument({ forecast, load }: { forecast: Forecast; load: number }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-4">
      <div className="min-w-0">
        <Bars
          values={forecast.days}
          titles={forecast.days.map((n, i) => `${i === 0 ? 'Today' : `+${i}d`} · ${n} due`)}
          highlightFirst
          label={`Cards due over the next ${forecast.days.length - 1} days`}
        />
        <AxisEnds left="today" right={`+${forecast.days.length - 1}d`} />
      </div>
      <dl className="grid grid-cols-1 gap-1 text-right">
        {[
          ['overdue', fmtInt(forecast.overdue), forecast.overdue > 0, 'Cards whose due time has passed'],
          ['7 days', fmtInt(forecast.next7), false, 'Cards due from today through day 7'],
          ['30 days', fmtInt(forecast.next30), false, 'Cards due from today through day 30'],
          ['load', load.toLocaleString('en-AU', { maximumFractionDigits: 1 }), false, 'Daily load: sum of 1/interval over scheduled cards'],
        ].map(([label, value, alert, hint]) => (
          <div key={String(label)} className="flex items-baseline justify-end gap-2" title={String(hint)}>
            <dd className={`text-base font-semibold tabular-nums ${alert ? 'text-[var(--md-warning)]' : 'text-[var(--md-on-surface)]'}`}>{String(value)}</dd>
            <dt className="w-12 text-left text-[0.7rem] text-[var(--md-on-surface-variant)]">{String(label)}</dt>
          </div>
        ))}
      </dl>
    </div>
  );
}

const STAGE_LABEL: Record<string, string> = { new: 'New', learning: 'Learning', relearn: 'Relearn', young: 'Young', mature: 'Mature' };
const STAGE_HINT: Record<string, string> = {
  new: 'First review of a card',
  learning: 'Reviewed again within a day',
  relearn: 'Previous answer was Again',
  young: 'Gap since last review under 21 days',
  mature: 'Gap since last review 21 days or more',
};

/** Aligned rows: label | bar | value columns. */
function Grid({ children, cols }: { children: ReactNode; cols: string }) {
  return <div className="grid items-center gap-x-3 gap-y-1.5 text-sm" style={{ gridTemplateColumns: cols }}>{children}</div>;
}

function Meter({ fraction, colour = 'var(--md-ramp-3)', label }: { fraction: number; colour?: string; label: string }) {
  return (
    <span className="block h-2 w-full overflow-hidden rounded-full bg-[var(--md-ramp-0)]" role="img" aria-label={label}>
      <span className="block h-full rounded-full" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, background: colour }} />
    </span>
  );
}

export function StagesInstrument({ stages }: { stages: StageSummary[] }) {
  const max = Math.max(1, ...stages.map((s) => s.n));
  return (
    <Grid cols="5.5rem minmax(0,1fr) 3.5rem 3rem 2.75rem">
      {stages.map((s) => (
        <Row key={s.stage}>
          <span className="text-[var(--md-on-surface)]" title={STAGE_HINT[s.stage]}>{STAGE_LABEL[s.stage]}</span>
          <Meter fraction={s.n / max} label={`${s.n} reviews`} />
          <span className={INSTRUMENT_NUM}>{fmtInt(s.n)}</span>
          <span className={INSTRUMENT_NUM_MUTED}>{s.minutes}m</span>
          <span className={INSTRUMENT_NUM_MUTED} title="Not graded Again">{fmtPct(s.passPct)}</span>
        </Row>
      ))}
    </Grid>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

const STATE_LABEL: Record<CardState, string> = { new: 'New', learning: 'Learning', young: 'Young', mature: 'Mature', retired: 'Retired' };
const STATE_RAMP: Record<CardState, string> = {
  new: 'var(--md-ramp-0)', learning: 'var(--md-ramp-1)', young: 'var(--md-ramp-2)', mature: 'var(--md-ramp-4)', retired: 'var(--md-outline-soft)',
};

export function CardCountsInstrument({ counts }: { counts: Record<CardState, number> }) {
  const entries = (Object.keys(STATE_LABEL) as CardState[]).map((k) => [k, counts[k]] as const);
  const total = entries.reduce((a, [, n]) => a + n, 0) || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full" role="img" aria-label="Cards by state">
        {entries.map(([k, n]) => n > 0 && (
          <span key={k} className="h-full" title={`${STATE_LABEL[k]} ${n}`}
            style={{ width: `${(n / total) * 100}%`, background: STATE_RAMP[k], borderRight: '2px solid var(--md-surface)' }} />
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-5">
        {entries.map(([k, n]) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] border border-[var(--md-outline-soft)]" style={{ background: STATE_RAMP[k] }} aria-hidden />
            <span className="text-[var(--md-on-surface-variant)]">{STATE_LABEL[k]}</span>
            <span className="ml-auto tabular-nums text-[var(--md-on-surface)]">{fmtInt(n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MiniHistogram({ title, bins, aside, hint }: { title: string; bins: HistogramBin[]; aside: string; hint: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-[var(--md-on-surface)]" title={hint}>{title}</span>
        <span className="tabular-nums text-[var(--md-on-surface-variant)]">{aside}</span>
      </div>
      <Bars values={bins.map((b) => b.n)} titles={bins.map((b) => `${b.label} · ${b.n}`)} label={`${title} histogram`} />
      <AxisEnds left={bins[0]?.label ?? ''} right={bins[bins.length - 1]?.label ?? ''} />
    </div>
  );
}

export function MemoryInstrument({ intervals, stability, retrievability, meanR, knowledge }: {
  intervals: HistogramBin[]; stability: HistogramBin[]; retrievability: HistogramBin[]; meanR: number | null; knowledge: number | null;
}) {
  const sum = (b: HistogramBin[]) => b.reduce((a, x) => a + x.n, 0);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <MiniHistogram title="Interval" bins={intervals} aside={`${fmtInt(sum(intervals))} cards`} hint="Days between the last review and the next due date" />
      <MiniHistogram title="Stability" bins={stability} aside="days" hint="The scheduler's stability in days: how slowly the memory fades" />
      <div className="min-w-0">
        <EstimatedKnowledge cards={knowledge} trend={null} />
        <MiniHistogram title="Retrievability" bins={retrievability} aside={`mean ${fmtPct(meanR)}`} hint="Estimated recall now, from md3's decay model R = R0 (1 + t/S)^-0.5" />
      </div>
    </div>
  );
}

export function RetentionInstrument({ rows }: { rows: RetentionRow[] }) {
  const cell = (c: RetentionRow['young']) => (
    <span className="text-right tabular-nums" title={`${c.pass} passed, ${c.fail} failed`}>
      <span className="text-[var(--md-on-surface)]">{fmtPct(c.pct)}</span>
      <span className="ml-1 text-[0.7rem] text-[var(--md-on-surface-variant)]">{c.pass + c.fail > 0 ? fmtInt(c.pass + c.fail) : ''}</span>
    </span>
  );
  return (
    <Grid cols="minmax(0,1fr) 5rem 5rem 5rem">
      <span className="text-[0.7rem] text-[var(--md-on-surface-variant)]" />
      <span className="text-right text-[0.7rem] text-[var(--md-on-surface-variant)]" title="Cards last seen under 21 days before">young</span>
      <span className="text-right text-[0.7rem] text-[var(--md-on-surface-variant)]" title="Cards last seen 21 days or more before">mature</span>
      <span className="text-right text-[0.7rem] text-[var(--md-on-surface-variant)]">all</span>
      {rows.map((r) => (
        <Row key={r.range}>
          <span className="truncate text-[var(--md-on-surface)]">{r.range}</span>
          {cell(r.young)}
          {cell(r.mature)}
          {cell(r.total)}
        </Row>
      ))}
    </Grid>
  );
}

function accuracyRamp(pctValue: number | null): string {
  if (pctValue == null) return 'var(--md-ramp-0)';
  if (pctValue < 60) return 'var(--md-ramp-1)';
  if (pctValue < 75) return 'var(--md-ramp-2)';
  if (pctValue < 90) return 'var(--md-ramp-3)';
  return 'var(--md-ramp-4)';
}

export function HourlyInstrument({ hours }: { hours: HourCell[] }) {
  return (
    <div>
      <Bars values={hours.map((h) => h.n)} titles={hours.map((h) => `${String(h.hour).padStart(2, '0')}:00 · ${h.n} · ${fmtPct(h.pct)}`)} label="Reviews by hour of day" />
      <div className="mt-1 grid gap-[2px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }} role="img" aria-label="Accuracy by hour of day">
        {hours.map((h) => (
          <span key={h.hour} className="h-2 rounded-[1px]" style={{ background: accuracyRamp(h.n > 0 ? h.pct : null) }} title={`${String(h.hour).padStart(2, '0')}:00 · ${fmtPct(h.pct)} correct`} />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[0.65rem] tabular-nums text-[var(--md-on-surface-variant)]">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
}

const GRADE_COLOUR = {
  again: 'var(--md-error)',
  hard: 'var(--md-warning)',
  good: 'var(--md-success)',
  easy: 'var(--md-primary)',
} as const;

export function ButtonsInstrument({ rows }: { rows: ButtonRow[] }) {
  return (
    <div>
      <Grid cols="4.5rem minmax(0,1fr) 3.5rem 2.75rem">
        {rows.map((r) => (
          <Row key={r.stage}>
            <span className="capitalize text-[var(--md-on-surface)]">{r.stage}</span>
            <span className="flex h-2.5 w-full overflow-hidden rounded-full bg-[var(--md-ramp-0)]" role="img"
              aria-label={`Again ${r.counts.again}, Hard ${r.counts.hard}, Good ${r.counts.good}, Easy ${r.counts.easy}`}>
              {(Object.keys(GRADE_COLOUR) as Array<keyof typeof GRADE_COLOUR>).map((g) => r.counts[g] > 0 && (
                <span key={g} className="h-full" title={`${g} ${r.counts[g]}`}
                  style={{ width: `${(r.counts[g] / Math.max(1, r.total)) * 100}%`, background: GRADE_COLOUR[g] }} />
              ))}
            </span>
            <span className="text-right tabular-nums text-[var(--md-on-surface)]">{fmtInt(r.total)}</span>
            <span className="text-right tabular-nums text-[var(--md-on-surface-variant)]" title="Not graded Again">
              {fmtPct(r.total ? ((r.total - r.counts.again) / r.total) * 100 : null)}
            </span>
          </Row>
        ))}
      </Grid>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.7rem] text-[var(--md-on-surface-variant)]">
        {(Object.keys(GRADE_COLOUR) as Array<keyof typeof GRADE_COLOUR>).map((g) => (
          <li key={g} className="flex items-center gap-1 capitalize">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: GRADE_COLOUR[g] }} aria-hidden />{g}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function KindsInstrument({ rows }: { rows: KindAccuracyRow[] }) {
  const keys = ['today', '7d', '30d', '1y', 'all'] as const;
  return (
    <Grid cols="minmax(0,1fr) repeat(5, 2.6rem)">
      <span />
      {keys.map((k) => <span key={k} className="text-right text-[0.7rem] text-[var(--md-on-surface-variant)]">{k}</span>)}
      {rows.map((r) => (
        <Row key={r.kind}>
          <span className="text-[var(--md-on-surface)]">{r.kind === 'card' ? 'Cloze' : 'MCQ'}</span>
          {keys.map((k) => (
            <span key={k} className={INSTRUMENT_NUM} title={`${r.cells[k].scored} scored`}>{fmtPct(r.cells[k].pct)}</span>
          ))}
        </Row>
      ))}
    </Grid>
  );
}

export function PracticeInstrument({ rows, today }: { rows: PracticeListRow[]; today: string }) {
  if (rows.length === 0) return <p className="text-sm text-[var(--md-on-surface-variant)]">–</p>;
  return (
    <Grid cols="4.5rem minmax(0,1fr) minmax(4.5rem,auto) 2.75rem">
      {rows.map((r) => (
        <Row key={r.id}>
          <span className={`${INSTRUMENT_NUM_MUTED} text-left`} title={r.date}>{formatCivilDate(r.date, today)}</span>
          <span className="truncate text-[var(--md-on-surface)]" title={r.title}>{r.title}</span>
          {r.complete ? (
            <>
              <span className={INSTRUMENT_NUM_MUTED} title={r.note ?? undefined}>{r.correct}/{r.outOf}</span>
              <span className={INSTRUMENT_NUM}>{fmtPct(r.pct)}</span>
            </>
          ) : (
            <span className={`col-span-2 ${INSTRUMENT_NUM_MUTED}`}>{r.note}</span>
          )}
        </Row>
      ))}
    </Grid>
  );
}
