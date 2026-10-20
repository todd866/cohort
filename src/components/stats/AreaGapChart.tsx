'use client';

/**
 * Blueprint areas as one dumbbell per area on a fixed 0–100 axis.
 * You (an exam score) is the filled primary dot. md3 and a practice paper
 * are outline rings on every rotation, including a tab with no exam.
 * Unassigned stays hidden.
 */
import { useState, type ReactNode } from 'react';
import { AREA_ACCURACY_DEFINITION, areaChartModel, defaultAreaRotation, rotationTabs, type AreaChartRow } from '@/lib/stats/area-chart';
import type { AreaTable, ExamResultView } from '@/lib/stats/stats-model';
import { ChipNativeSelect } from '@/components/shared/Chip';
import { INSTRUMENT_NUM, INSTRUMENT_NUM_MUTED, INSTRUMENT_ROW } from './instrument-chrome';
import { ScoreTrack } from './ScoreTrack';
import { areaShortName } from '@/lib/stats/area-short-name';

const ROTATION_SHORT: Record<string, string> = { 'critical-care': 'CC' };
const short = (r: string) => ROTATION_SHORT[r] ?? r.toUpperCase();
const COLS = 'minmax(0,8.75rem) minmax(0,1fr) 2.25rem';
const TICKS = [0, 50, 100];
const at = (value: number | null) => (value == null ? null : Math.max(0, Math.min(100, value)) / 100);

function Gap({ you, other }: { you: number | null; other: number | null }) {
  if (you == null || other == null) return <span className={INSTRUMENT_NUM_MUTED}>–</span>;
  const gap = Math.round(you - other);
  const down = gap < 0;
  return (
    <span className="text-right font-semibold tabular-nums" style={{ color: gap === 0 ? 'var(--md-on-surface-variant)' : down ? 'var(--md-error)' : 'var(--md-success)' }}
      aria-label={gap === 0 ? 'level' : `${Math.abs(gap)} points ${down ? 'under' : 'over'}`}>
      {gap === 0 ? '0' : `${down ? '▼' : '▲'}${Math.abs(gap)}`}
    </span>
  );
}

/** You is an exam score. md3 and a practice paper stay rings, including on a tab with no exam. */
function rowLabel(r: AreaChartRow): string {
  const parts = [r.label];
  if (r.exam != null) parts.push(`you ${Math.round(r.exam)}%`);
  if (r.md3 != null) parts.push(`md3 ${Math.round(r.md3)}%`);
  if (r.practice != null) parts.push(`paper ${Math.round(r.practice)}%`);
  return parts.join(', ');
}

function loneScore(r: AreaChartRow): number | null {
  return r.md3 ?? r.practice;
}

function Axis() {
  return (
    <div className="grid items-start gap-x-2" style={{ gridTemplateColumns: COLS }} aria-hidden>
      <span />
      <div className="relative h-4 border-t border-[var(--md-outline-soft)]">
        {TICKS.map((t) => (
          <span key={t} className="absolute top-0 flex -translate-x-1/2 flex-col items-center text-[0.6rem] leading-none tabular-nums text-[var(--md-on-surface-variant)]" style={{ left: `${t}%` }}>
            <span className="h-1 w-px bg-[var(--md-outline)]" />
            <span className="mt-0.5">{t}</span>
          </span>
        ))}
      </div>
      <span />
    </div>
  );
}

const TAB_ON = 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]';
const TAB_OFF = 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container)]';

/**
 * `rotations`: the rotations with an exam blueprint, in course order. They get
 * tabs; any other deck the learner has touched sits behind one More menu.
 */
export function AreaGapChart({ tables, exams, rotations, current = null, aside }: { tables: AreaTable[]; exams: ExamResultView[]; rotations: readonly string[]; current?: string | null; aside?: ReactNode }) {
  const { tabs, more } = rotationTabs(tables, rotations);
  const usable = [...tabs, ...more];
  const [rotation, setRotation] = useState(() => defaultAreaRotation(usable, current, exams));
  const [open, setOpen] = useState(false);
  const table = usable.find((t) => t.rotation === rotation) ?? usable[0];
  if (!table) return aside ? <div className="flex flex-wrap items-center gap-2">{aside}</div> : <p className="text-sm text-[var(--md-on-surface-variant)]">–</p>;
  const model = areaChartModel(table);
  const track = (you: number | null, rings: Array<number | null>) => (
    <ScoreTrack youAt={at(you)} cohortAt={null} ringAts={rings.map(at)} label="You and md3, scale 0 to 100" />
  );

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
      {usable.length > 1 && tabs.length > 0 && (
        <div role="tablist" aria-label="Rotation" className="inline-flex overflow-hidden rounded-lg border border-[var(--md-outline-soft)]">
          {tabs.map((t) => {
            const on = t.rotation === table.rotation;
            return (
              <button key={t.rotation} type="button" role="tab" aria-selected={on} onClick={() => { setRotation(t.rotation); setOpen(false); }}
                className={`inline-flex min-h-9 items-center px-2.5 tabular-nums ${on ? TAB_ON : TAB_OFF}`}>
                {short(t.rotation)}
              </button>
            );
          })}
        </div>
      )}
      {more.length > 0 && usable.length > 1 && (
        <ChipNativeSelect aria-label="More rotations" className="[field-sizing:content]" value={more.some((t) => t.rotation === table.rotation) ? table.rotation : ''}
          onChange={(e) => { if (e.target.value) { setRotation(e.target.value); setOpen(false); } }}>
          <option value="" disabled>More</option>
          {more.map((t) => <option key={t.rotation} value={t.rotation}>{short(t.rotation)}</option>)}
        </ChipNativeSelect>
      )}
      {aside}
      </div>

      <ul role="list" aria-label={`${short(table.rotation)} blueprint areas`} className="space-y-0">
        {model.overall && (
          <li className={`${INSTRUMENT_ROW} border-b border-[var(--md-outline-soft)]`} style={{ gridTemplateColumns: COLS }}
            aria-label={`Overall, you ${Math.round(model.overall.exam)}%, md3 ${model.overall.md3 == null ? 'no data' : `${Math.round(model.overall.md3)}%`}`}>
            <span className="truncate font-semibold text-[var(--md-on-surface)]">Overall</span>
            {track(model.overall.exam, [model.overall.md3])}
            <Gap you={model.overall.exam} other={model.overall.md3} />
          </li>
        )}
        {model.rows.map((r) => {
          const lone = loneScore(r);
          return (
            <li key={r.area} className={INSTRUMENT_ROW} style={{ gridTemplateColumns: COLS }} title={r.title} aria-label={rowLabel(r)}>
              <span className="truncate text-[var(--md-on-surface)]" title={r.label}>{areaShortName(r.label)}</span>
              {track(r.exam, [r.md3, r.practice])}
              {r.exam != null ? <Gap you={r.exam} other={r.md3} /> : <span className={INSTRUMENT_NUM}>{lone == null ? '–' : Math.round(lone)}</span>}
            </li>
          );
        })}
        {open && model.folded.map((f) => (
          <li key={f.area} className={`${INSTRUMENT_ROW} text-[var(--md-on-surface-variant)]`} style={{ gridTemplateColumns: COLS }} title={f.label} aria-label={`${f.label}, no data`}>
            <span className="truncate">{f.label}</span>
            <span aria-hidden className="h-px bg-[var(--md-outline-soft)]" />
            <span className={INSTRUMENT_NUM_MUTED}>–</span>
          </li>
        ))}
      </ul>

      <Axis />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-[var(--md-on-surface-variant)]">
        <span title={AREA_ACCURACY_DEFINITION}><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-[var(--md-primary)] align-middle" />you</span>
        <span title={AREA_ACCURACY_DEFINITION}><span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full border-2 border-[var(--md-primary)] align-middle" />md3</span>
        {model.folded.length > 0 && (
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
            className="ml-auto min-h-8 rounded-md px-1.5 tabular-nums text-[var(--md-primary)] hover:bg-[var(--md-surface-container)]">
            {open ? 'Hide areas without data' : `+${model.folded.length} ${model.folded.length === 1 ? 'area' : 'areas'} without data`}
          </button>
        )}
      </div>
    </div>
  );
}
