'use client';

import { useState } from 'react';
import type { Line, Phase, Station } from '@/lib/clinical/station-types';

/**
 * How a clinical station reads: what you DO, the exact words you SAY and to
 * whom, a `+` for the reason, and a bold takeaway per phase.
 *
 * The station page's deck (src/components/clinical/StationDeck.tsx) and the
 * review drawer (src/components/review/StationDrawer.tsx) both render through
 * here, so the deck, its script and the drawer cannot drift apart. It sits in
 * the shared tree rather than beside the deck because the review drawer ships
 * in the public build and the clinical pages do not. It holds no station
 * content: that is served, per viewer, by the station page and its API.
 */

export const STATION_FINISH = 'Finish';

function sourceTitles(station: Station, ids: string[]): string[] {
  return ids.map((id) => station.sources.find((source) => source.id === id)?.title ?? id);
}

function StationLine({ station, line, showMore }: { station: Station; line: Line; showMore: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 flex-none rounded-full" style={{ background: 'var(--md-primary)' }} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium leading-snug">
            {line.marked && (
              <span aria-label="Examiner-marked step" role="img" className="mr-1" style={{ color: 'var(--md-primary)' }}>★</span>
            )}
            {line.do}
            {showMore && line.more && (
              <button
                type="button"
                className="ml-2 inline-flex h-6 w-6 items-center justify-center rounded-full border text-sm"
                style={{ borderColor: 'var(--md-outline-variant)', color: 'var(--md-primary)' }}
                aria-label={`Why: ${line.do}`}
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
              >
                +
              </button>
            )}
          </p>
          {line.say && (
            <blockquote
              className="mt-1 rounded-md border-l-4 px-3 py-1.5 text-sm"
              style={{ borderColor: 'var(--md-primary)', background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)' }}
            >
              <span>{line.say}</span>
              {line.to && (
                <span className="ml-2 text-xs uppercase tracking-wide opacity-75">to {line.to}</span>
              )}
            </blockquote>
          )}
          {open && line.more && (
            <div className="mt-2 rounded-md p-3 text-sm" style={{ background: 'var(--md-surface-container)' }}>
              <p>{line.more.body}</p>
              <p className="mt-1 text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>
                {sourceTitles(station, line.more.sourceIds).map((title) => <span key={title} className="mr-2">{title}</span>)}
              </p>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export function StationPhase({ station, phase, showMore, headingLevel = 2 }: {
  station: Station;
  phase: Phase;
  showMore: boolean;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section>
      <Heading className={headingLevel === 2 ? 'text-2xl font-semibold' : 'text-lg font-semibold'}>{phase.name}</Heading>
      <ul className="mt-2 list-none p-0">
        {phase.lines.map((line) => <StationLine key={line.id} station={station} line={line} showMore={showMore} />)}
      </ul>
      {phase.takeaway && (
        <p className="mt-3 border-t pt-3 text-base font-semibold" style={{ borderColor: 'var(--md-outline-variant)' }}>
          {phase.takeaway}
        </p>
      )}
    </section>
  );
}

/**
 * Every line on one screen: the phases, each examiner-chosen track under its
 * own heading, the close, the one-breath presentation and the red flags.
 */
export function StationScript({ station, showMore = false }: { station: Station; showMore?: boolean }) {
  const trackNames = Object.keys(station.tracks ?? {});
  return (
    <div className="space-y-6">
      {station.phases.map((phase) => <StationPhase key={phase.name} station={station} phase={phase} showMore={showMore} headingLevel={3} />)}
      {trackNames.map((name) => (
        <section key={name}>
          <h3 className="text-lg font-semibold" style={{ color: 'var(--md-primary)' }}>If the examiner asks for {name}</h3>
          <div className="mt-2 space-y-4">
            {station.tracks![name].map((phase) => <StationPhase key={`${name}-${phase.name}`} station={station} phase={phase} showMore={showMore} headingLevel={3} />)}
          </div>
        </section>
      ))}
      <StationPhase station={station} phase={{ name: STATION_FINISH, lines: station.close, takeaway: '' }} showMore={showMore} headingLevel={3} />
      {station.present && (
        <section>
          <h3 className="text-lg font-semibold">Present it</h3>
          <p className="mt-2 rounded-md p-3" style={{ background: 'var(--md-surface-container)' }}>{station.present}</p>
        </section>
      )}
      {station.redFlags && station.redFlags.length > 0 && (
        <section>
          <h3 className="text-lg font-semibold">Red flags</h3>
          <ul className="mt-2 list-disc pl-5">
            {station.redFlags.map((flag) => <li key={flag} style={{ color: 'var(--md-error)' }}>{flag}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
