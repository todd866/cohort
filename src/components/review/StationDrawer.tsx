'use client';

import Link from 'next/link';
import { useEffect, useEffectEvent, useId, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Station } from '@/lib/clinical/station-types';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import { StationScript } from '@/components/shared/StationScript';

/**
 * A clinical station, read over the card it belongs to.
 *
 * The review chip used to link to /clinical/<id>, which took the learner out
 * of the review session (reported 2026-09-30 from a phone). This drawer shows
 * the station's script and viva instead, and leaves the session, the card and
 * its grade bar exactly as they were underneath. "Open full station" stays
 * for a learner who does want the whole page, in a new tab.
 *
 * - The content comes from /api/clinical/stations/<id>, which applies the
 *   station page's own audience rule on the server. Nothing here decides who
 *   may read a station; the chip only avoids offering one that would 404.
 * - A native modal <dialog>: the page behind is inert and focus stays inside.
 *   Modality does not stop the review's keyboard shortcuts, which listen on
 *   window, so while it is open every key is stopped at the window capture
 *   phase: a 3 pressed by habit must not grade the card behind the drawer.
 *   Native defaults (scrolling, Tab, Enter or Space on a control) still run.
 * - Focus starts on the scrolling content, so Space and the arrow keys read
 *   down the station rather than activating Close. Escape (and Android back),
 *   Close and a tap on the backdrop close it, and focus returns to the control
 *   that opened it.
 * - Rendered into document.body, not inside the card's action row: it
 *   belongs to the page, and inside the row it inherited the row's small type.
 *   It mounts only after a tap, so there is always a document to render into.
 * - No transition: the review surface's default is no animation. A bottom
 *   sheet on a phone, a right-hand panel from the sm breakpoint up.
 */

type Loaded =
  | { state: 'loading' }
  | { state: 'ready'; station: Station }
  | { state: 'failed' };

const stations = new Map<string, Promise<Station | null>>();

/** One read per station per page load. A failed read is forgotten, so the next open tries again. */
function loadStation(id: string): Promise<Station | null> {
  const cached = stations.get(id);
  if (cached) return cached;
  const pending = fetchWithDeadline(`/api/clinical/stations/${encodeURIComponent(id)}`, {}, CLIENT_FETCH_DEADLINE_MS)
    .then(async (res) => (res.ok ? ((await res.json()) as { station?: Station }).station ?? null : null))
    .catch(() => null)
    .then((station) => {
      if (!station) stations.delete(id);
      return station;
    });
  stations.set(id, pending);
  return pending;
}

export function resetStationContentForTest() {
  stations.clear();
}

export interface StationDrawerProps {
  stationId: string;
  /** Shown at once, before the content arrives. */
  title: string;
  onClose: () => void;
  /** The control that opened the drawer; focus returns to it on close. */
  returnFocusTo: RefObject<HTMLElement | null>;
}

export function StationDrawer({ stationId, title, onClose, returnFocusTo }: StationDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const closeFromKeyboard = useEffectEvent(() => onClose());

  useEffect(() => {
    let live = true;
    void loadStation(stationId).then((station) => {
      if (live) setLoaded(station ? { state: 'ready', station } : { state: 'failed' });
    });
    return () => { live = false; };
  }, [stationId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = returnFocusTo.current;
    dialog.showModal();
    contentRef.current?.focus();

    const containKey = (event: KeyboardEvent) => {
      if (!dialog.open) return;
      event.stopImmediatePropagation();
      if (event.type === 'keydown' && event.key === 'Escape') {
        event.preventDefault();
        closeFromKeyboard();
      }
    };
    window.addEventListener('keydown', containKey, true);
    window.addEventListener('keyup', containKey, true);
    return () => {
      window.removeEventListener('keydown', containKey, true);
      window.removeEventListener('keyup', containKey, true);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, [returnFocusTo]);

  const station = loaded.state === 'ready' ? loaded.station : null;

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      // Follow a close the browser made itself, e.g. a close request it would
      // not let the page cancel. The event is fired as a task after close(),
      // so a dialog that is open again by then (StrictMode's development
      // remount closes and reopens it) is reporting a close already undone.
      onClose={(event) => { if (!event.currentTarget.open) onClose(); }}
      // A tap on the dimmed backdrop lands on the dialog element itself.
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none overflow-hidden rounded-t-2xl border border-b-0 border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-0 text-[var(--md-on-surface)] shadow-xl open:flex open:flex-col backdrop:bg-[var(--md-on-surface)]/50 sm:my-0 sm:ml-auto sm:mr-0 sm:h-dvh sm:max-h-none sm:w-[28rem] sm:rounded-none sm:rounded-l-2xl sm:border-b sm:border-r-0"
    >
      <header className="flex items-start justify-between gap-3 border-b border-[var(--md-outline-variant)] px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--md-primary)]">
            Clinical station{station ? ` · ${station.minutes} min` : ''}
          </p>
          <h2 id={titleId} className="mt-0.5 text-base font-semibold leading-snug">{title}</h2>
          <Link
            href={`/clinical/${stationId}`}
            target="_blank"
            className="mt-1 inline-block text-xs text-[var(--md-primary)] hover:underline"
          >
            Open full station ↗
          </Link>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 min-w-11 shrink-0 rounded-md px-3 text-sm hover:bg-[var(--md-surface-container-high)]"
        >
          Close
        </button>
      </header>
      <div
        ref={contentRef}
        tabIndex={-1}
        role="region"
        aria-label="Station content"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] focus:outline-none"
      >
        {loaded.state === 'loading' && (
          <p role="status" className="text-sm text-[var(--md-on-surface-variant)]">Loading the station…</p>
        )}
        {loaded.state === 'failed' && (
          <p role="alert" className="text-sm">
            This station could not be loaded. Open the full station, or try again later.
          </p>
        )}
        {station && (
          <>
            <p className="text-sm text-[var(--md-on-surface-variant)]">{station.task}</p>
            <div className="mt-4">
              <StationScript station={station} showMore />
            </div>
            {station.viva && station.viva.length > 0 && (
              <section className="mt-6">
                <h3 className="text-lg font-semibold">Viva</h3>
                <ul className="mt-2 list-none space-y-2 p-0">
                  {station.viva.map((item) => (
                    <li key={item.q}>
                      <details className="rounded-lg border border-[var(--md-outline-variant)] px-3 py-2">
                        <summary className="cursor-pointer font-medium">{item.q}</summary>
                        <p className="mt-2">{item.a}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
