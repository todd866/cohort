'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import { isCohortHostname } from '@/lib/institution';
import { StationDrawer } from './StationDrawer';

/**
 * After reveal, a card whose topic belongs to a clinical station offers it in
 * the card's action row, beside Details, and opens it in a drawer over the
 * card (StationDrawer), so reading the station never leaves the review
 * session. It offers only a station this viewer can open: the owner opens
 * every station; a learner opens one offered to an audience in their session
 * (auth-session-payload.ts); a signed-out or guest viewer, and anyone on the
 * Cohort host, is offered nothing. The server still decides, on the station
 * page and on the drawer's read; this only keeps the offer honest.
 *
 * The topic index is a small static file generated from the stations
 * (npm run clinical:check -- --write), fetched once per page load and only for
 * a viewer who could open something. It holds ids, titles and audiences, never
 * station content, and it does not exist in the public build.
 */

type StationTopicIndex = Record<string, { id: string; title: string; audiences: string[] }[]>;

export interface StationChipViewer {
  isAdmin: boolean;
  clinicalAudiences: readonly string[];
}

let indexPromise: Promise<StationTopicIndex | null> | null = null;

function loadIndex(): Promise<StationTopicIndex | null> {
  indexPromise ??= fetchWithDeadline('/clinical/station-topics.json', { cache: 'force-cache' }, CLIENT_FETCH_DEADLINE_MS)
    .then((res) => (res.ok ? res.json() as Promise<StationTopicIndex> : null))
    .catch(() => null);
  return indexPromise;
}

export function resetStationTopicIndexForTest() {
  indexPromise = null;
}

/** "Station 4 — paediatric physical examination" reads as "Station 4" in the row; the drawer shows it whole. */
function rowLabel(title: string): string {
  return title.split(' — ')[0].trim() || title;
}

export function StationChip({
  topics,
  viewer,
  hostname,
}: {
  topics: string[];
  viewer: StationChipViewer | null;
  /** Injected by tests; defaults to the page's own host. */
  hostname?: string;
}) {
  const [station, setStation] = useState<{ id: string; title: string } | null>(null);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const isAdmin = viewer?.isAdmin ?? false;
  const audiences = viewer?.clinicalAudiences ?? [];
  const audienceKey = audiences.join(',');
  const eligible = viewer !== null && (isAdmin || audiences.length > 0);

  const host = hostname ?? (typeof window === 'undefined' ? '' : window.location.hostname);
  const allowed = eligible && !isCohortHostname(host);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    const mine = audienceKey.split(',').filter(Boolean);
    void loadIndex().then((index) => {
      if (!live || !index) return;
      const match = topics
        .flatMap((topic) => index[topic.trim().toLowerCase()] ?? [])
        .find((entry) => isAdmin || entry.audiences.some((audience) => mine.includes(audience)));
      setStation(match ? { id: match.id, title: match.title } : null);
    });
    return () => { live = false; };
  }, [topics, allowed, isAdmin, audienceKey]);

  if (!allowed || !station) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        title={station.title}
        onClick={() => setOpen(true)}
        className="text-left text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)] opacity-60 hover:opacity-100"
      >
        Station: {rowLabel(station.title)} ›
      </button>
      {open && (
        <StationDrawer
          key={station.id}
          stationId={station.id}
          title={station.title}
          onClose={close}
          returnFocusTo={triggerRef}
        />
      )}
    </>
  );
}
