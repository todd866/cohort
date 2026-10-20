'use client';

/**
 * Orders the server-rendered instruments by the learner's saved layout and
 * offers the Layout menu: a visible button opening a list of sections, each
 * with a show/hide checkbox and up/down buttons, plus density. Changes apply
 * at once and save in the background; a failed save keeps the change on
 * screen and says so.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';
import { createLatestSaver, type LatestSaver } from '@/lib/stats/latest-saver';
import {
  applyStatsLayout,
  DEFAULT_STATS_LAYOUT,
  moveSection,
  STATS_SECTIONS,
  toggleSection,
  toStatsLayoutSetting,
  type AppliedStatsLayout,
  type StatsSectionId,
} from '@/lib/stats/stats-layout';
import { StatsLayoutContext } from './stats-layout-context';

type RevisedLayout = { layout: AppliedStatsLayout; rev: number };

let revisionSequence = 0;
/**
 * Monotonic save revision: the save time in microseconds plus a sequence, so
 * the server keeps the newest intended layout even if an older request lands
 * after a newer one (stats-layout.server.ts).
 */
export function nextLayoutRevision(now = Date.now()): number {
  revisionSequence = (revisionSequence + 1) % 1000;
  return now * 1000 + revisionSequence;
}

export function StatsLayoutShell({
  initial,
  sections,
  toolbar,
  layoutEndpoint,
}: {
  initial: AppliedStatsLayout;
  sections: Partial<Record<StatsSectionId, ReactNode>>;
  toolbar: ReactNode;
  /** Where to save; null applies changes for this visit only (Cohort, public build). */
  layoutEndpoint: string | null;
}) {
  const [layout, setLayout] = useState(initial);
  const [open, setOpen] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    const onPointer = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  // One request in flight, the latest layout queued behind it: an older save
  // can never land after a newer one.
  const [saver] = useState<LatestSaver<RevisedLayout> | null>(() => (layoutEndpoint
    ? createLatestSaver<RevisedLayout>(
      (value) => fetchWithDeadline(layoutEndpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...toStatsLayoutSetting(value.layout), rev: value.rev }),
      }, CLIENT_FETCH_DEADLINE_MS).then((res) => res.ok),
      (ok) => setSaveFailed(!ok),
    )
    : null));

  const save = (next: AppliedStatsLayout) => {
    setLayout(next);
    saver?.save({ layout: next, rev: nextLayoutRevision() });
  };

  const label = (id: StatsSectionId) => STATS_SECTIONS.find((s) => s.id === id)?.label ?? id;
  const gap = layout.density === 'compact' ? 'gap-5' : 'gap-9';

  return (
    <StatsLayoutContext.Provider value={{ layout, save }}>
    <div data-density={layout.density}>
      <div className="relative mb-6 flex flex-wrap items-center gap-2">
        {toolbar}
        <button
          ref={buttonRef}
          type="button"
          aria-expanded={open}
          aria-controls="stats-layout-menu"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--md-outline-soft)] px-3 text-sm text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2 4h12M2 8h12M2 12h12" /><circle cx="5" cy="4" r="1.6" fill="var(--md-surface)" /><circle cx="11" cy="8" r="1.6" fill="var(--md-surface)" /><circle cx="7" cy="12" r="1.6" fill="var(--md-surface)" />
          </svg>
          Layout
        </button>
        {saveFailed && <span className="text-xs text-[var(--md-error)]" role="alert" title="Your layout could not be saved; it still applies on this visit">⚠ not saved</span>}
        {open && (
          <div
            ref={menuRef}
            id="stats-layout-menu"
            role="dialog"
            aria-label="Statistics layout"
            className="absolute right-0 top-full z-20 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)] p-2 shadow-[var(--md-shadow-2)]"
          >
            <ul className="max-h-[60vh] overflow-y-auto">
              {layout.order.map((id, index) => (
                <li key={id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-[var(--md-surface-container)]">
                  <label className="flex min-h-9 flex-1 items-center gap-2 text-sm text-[var(--md-on-surface)]">
                    <input type="checkbox" checked={!layout.hidden.includes(id)} onChange={() => save(toggleSection(layout, id))} className="h-4 w-4 accent-[var(--md-primary)]" />
                    {label(id)}
                  </label>
                  <button type="button" aria-label={`Move ${label(id)} up`} disabled={index === 0}
                    onClick={() => save(moveSection(layout, id, -1))}
                    className="h-8 w-8 rounded-md text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] disabled:opacity-30">▲</button>
                  <button type="button" aria-label={`Move ${label(id)} down`} disabled={index === layout.order.length - 1}
                    onClick={() => save(moveSection(layout, id, 1))}
                    className="h-8 w-8 rounded-md text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] disabled:opacity-30">▼</button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2 border-t border-[var(--md-outline-soft)] pt-2">
              <div role="radiogroup" aria-label="Density" className="inline-flex overflow-hidden rounded-lg border border-[var(--md-outline-soft)] text-xs">
                {(['comfortable', 'compact'] as const).map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={layout.density === d}
                    onClick={() => save({ ...layout, density: d })}
                    className={`min-h-8 px-2.5 capitalize ${layout.density === d ? 'bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)]'}`}>
                    {d}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => save(applyStatsLayout(DEFAULT_STATS_LAYOUT))}
                className="ml-auto min-h-8 rounded-md px-2 text-xs text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]">
                Reset
              </button>
            </div>
          </div>
        )}
      </div>
      <div className={`flex flex-col ${gap}`}>
        {layout.visible.map((id) => sections[id] ? <div key={id} data-section={id}>{sections[id]}</div> : null)}
      </div>
    </div>
    </StatsLayoutContext.Provider>
  );
}
