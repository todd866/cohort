'use client';

import { useState } from 'react';
import type { Line, Phase, Station } from '@/lib/clinical/station-types';

/**
 * How a clinical station reads: one numbered row per step, a small star on the
 * examiner-marked ones, and the exact words to SAY (plus the reason, where
 * there is one) behind a tap on the row. Phases are thin dividers on one
 * scroll, not cards or screens.
 *
 * The station page (src/components/clinical/StationDeck.tsx) and the review
 * drawer (src/components/review/StationDrawer.tsx) both render through here,
 * so they cannot drift apart. It sits in the shared tree because the review
 * drawer ships in the public build and the clinical pages do not. It holds no
 * station content: that is served, per viewer, by the station page and its API.
 */

export const STATION_FINISH = 'Finish';

function sourceTitles(station: Station, ids: string[]): string[] {
  return ids.map((id) => station.sources.find((source) => source.id === id)?.title ?? id);
}

function StationLine({ station, line, number, showMore }: {
  station: Station; line: Line; number: number; showMore: boolean;
}) {
  const [open, setOpen] = useState(false);
  const more = showMore ? line.more : undefined;
  const expandable = Boolean(line.say || more);
  const row = (
    <>
      <span className="pt-px text-right text-xs tabular-nums text-[var(--md-on-surface-variant)]">{number}</span>
      <span className="pt-px text-xs text-[var(--md-primary)]">
        {line.marked && <span role="img" aria-label="Examiner-marked step">★</span>}
      </span>
      <span className="text-sm leading-snug text-[var(--md-on-surface)]">{line.do}</span>
      <span className={`text-[var(--md-on-surface-variant)] ${open ? 'rotate-90' : ''}`} aria-hidden>{expandable ? '›' : ''}</span>
    </>
  );
  const grid = 'grid w-full grid-cols-[1.25rem_0.75rem_minmax(0,1fr)_0.75rem] items-start gap-x-1.5 py-1.5 text-left';
  return (
    <li className="border-b border-[var(--md-outline-soft)]">
      {expandable ? (
        <button
          type="button"
          className={`${grid} min-h-10`}
          aria-expanded={open}
          aria-label={line.say ? `Say: ${line.do}` : `Why: ${line.do}`}
          onClick={() => setOpen((value) => !value)}
        >
          {row}
        </button>
      ) : (
        <div className={grid}>{row}</div>
      )}
      {open && (
        <div className="grid gap-1 pb-2 pl-[2.75rem] pr-2 text-sm">
          {line.say && (
            <p className="text-[var(--md-on-surface)]">
              “{line.say}”
              {line.to && <span className="ml-1.5 text-xs text-[var(--md-on-surface-variant)]">to {line.to}</span>}
            </p>
          )}
          {more && (
            <p className="text-[var(--md-on-surface-variant)]">
              {more.body}
              <span className="ml-1.5 text-xs">{sourceTitles(station, more.sourceIds).join(' · ')}</span>
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** One phase: a thin divider carrying its name, then its numbered rows. */
export function StationPhase({ station, phase, showMore, start = 1, headingLevel = 3 }: {
  station: Station;
  phase: Phase;
  showMore: boolean;
  /** Number of the phase's first row, so numbering runs on through the station. */
  start?: number;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section aria-label={phase.name} className="pt-3">
      <Heading className="border-b border-[var(--md-outline-variant)] pb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
        {phase.name}
      </Heading>
      <ol className="list-none p-0">
        {phase.lines.map((line, i) => (
          <StationLine key={line.id} station={station} line={line} number={start + i} showMore={showMore} />
        ))}
      </ol>
    </section>
  );
}

/**
 * The whole station on one scroll: the phases, the examiner-chosen track (one
 * track when `track` is given, every track under its own name otherwise), the
 * close, the one-breath presentation and the red flags.
 */
export function StationScript({ station, showMore = false, track }: {
  station: Station;
  showMore?: boolean;
  /** Show only this examiner-chosen track; undefined shows every track. */
  track?: string | null;
}) {
  const trackNames = track === undefined
    ? Object.keys(station.tracks ?? {})
    : (track && station.tracks?.[track] ? [track] : []);
  const phases: Phase[] = [
    ...station.phases,
    ...trackNames.flatMap((name) => station.tracks![name].map((phase) => ({
      ...phase,
      name: trackNames.length > 1 || track === undefined ? `${name} · ${phase.name}` : phase.name,
    }))),
    { name: STATION_FINISH, lines: station.close, takeaway: '' },
  ];
  let next = 1;
  return (
    <div>
      {phases.map((phase) => {
        const start = next;
        next += phase.lines.length;
        return <StationPhase key={phase.name} station={station} phase={phase} showMore={showMore} start={start} />;
      })}
      {station.present && (
        <section aria-label="Present it" className="pt-3">
          <h3 className="border-b border-[var(--md-outline-variant)] pb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-primary)]">
            Present it
          </h3>
          <p className="py-1.5 text-sm text-[var(--md-on-surface)]">“{station.present}”</p>
        </section>
      )}
      {station.redFlags && station.redFlags.length > 0 && (
        <section aria-label="Red flags" className="pt-3">
          <h3 className="border-b border-[var(--md-outline-variant)] pb-1 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-[var(--md-error)]">
            Red flags
          </h3>
          <ul className="list-none p-0">
            {station.redFlags.map((flag) => (
              <li key={flag} className="border-b border-[var(--md-outline-soft)] py-1.5 text-sm text-[var(--md-error)]">{flag}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
