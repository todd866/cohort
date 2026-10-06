'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

import type { AnatomyFigureId, AnatomyFigureTarget } from '@/lib/cohort/anatomy-figure-catalogue';
export type { AnatomyFigureTarget } from '@/lib/cohort/anatomy-figure-catalogue';
export type AnatomyFigurePhase = 'prompt' | 'answer';
export interface PreparedAnatomyFigure { src: string; url: string }
const MAX_PREPARED_FIGURES = 6;
const cache = new Map<string, Promise<PreparedAnatomyFigure>>();
const decoded = new Map<string, PreparedAnatomyFigure>();
const mounted = new Map<string, number>();
const pending = new Set<string>();
const activeTokens = new Map<string, object>();
const recency = new Map<string, number>();
let recencyClock = 0;
const source = (target: AnatomyFigureTarget, phase: AnatomyFigurePhase, figureId: AnatomyFigureId) => figureId === 'abducens-local'
  ? `/api/anatomy/abducens?target=${target}&phase=${phase}`
  : `/api/anatomy/figure?figure=${figureId}&target=${target}&phase=${phase}`;

function evict() {
  while (cache.size > MAX_PREPARED_FIGURES) {
    const key = [...cache.keys()]
      .filter((candidate) => !pending.has(candidate) && !mounted.has(candidate))
      .sort((left, right) => (recency.get(left) ?? 0) - (recency.get(right) ?? 0))[0];
    if (!key) return;
    const promise = cache.get(key);
    cache.delete(key);
    recency.delete(key);
    decoded.delete(key);
    void promise?.then((figure) => URL.revokeObjectURL(figure.url)).catch(() => undefined);
  }
}

function touch(src: string) {
  recency.set(src, ++recencyClock);
}

function retain(src: string) {
  mounted.set(src, (mounted.get(src) ?? 0) + 1);
  touch(src);
}

function release(src: string) {
  const count = mounted.get(src) ?? 0;
  if (count <= 1) mounted.delete(src);
  else mounted.set(src, count - 1);
  evict();
}

/** Fetch and decode a reviewed public anatomy state; retain a bounded recent cache. */
export function prepareAnatomyFigure(target: AnatomyFigureTarget, phase: AnatomyFigurePhase, figureId: AnatomyFigureId = 'abducens-local'): Promise<PreparedAnatomyFigure> {
  const src = source(target, phase, figureId);
  const existing = cache.get(src);
  if (existing) { touch(src); return existing; }
  pending.add(src);
  const token = {};
  activeTokens.set(src, token);
  touch(src);
  const promise = (async () => {
    const response = await fetchWithDeadline(src, { cache: 'no-store' }, CLIENT_FETCH_DEADLINE_MS);
    if (!response.ok) throw new Error(`Anatomy figure request failed: ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    try {
      const image = new Image();
      image.src = url;
      const decode = image.decode?.() ?? Promise.resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([decode, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Anatomy figure decode timed out')), CLIENT_FETCH_DEADLINE_MS);
        })]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const prepared = { src, url };
      if (activeTokens.get(src) === token) decoded.set(src, prepared);
      else URL.revokeObjectURL(url);
      return prepared;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  })();
  cache.set(src, promise);
  evict();
  void promise.then(() => {
    pending.delete(src);
    if (activeTokens.get(src) === token) activeTokens.delete(src);
    // Let a component that awaited this promise retain the decoded URL before
    // the LRU pass considers it evictable.
    setTimeout(evict, 0);
  }).catch(() => {
    pending.delete(src);
    if (activeTokens.get(src) === token) activeTokens.delete(src);
    if (cache.get(src) === promise) { cache.delete(src); decoded.delete(src); recency.delete(src); }
    setTimeout(evict, 0);
  });
  return promise;
}

export interface AnatomyReviewFigureProps {
  figureId?: AnatomyFigureId; target: AnatomyFigureTarget; revealed: boolean; alt: string; caption?: string; onReady?: (ready: boolean) => void;
}

export function AnatomyReviewFigure({ figureId = 'abducens-local', target, revealed, alt, caption, onReady }: AnatomyReviewFigureProps) {
  const phase: AnatomyFigurePhase = revealed ? 'answer' : 'prompt';
  const [display, setDisplay] = useState<{ figure: PreparedAnatomyFigure; alt: string } | null>(() => {
    const figure = decoded.get(source(target, phase, figureId));
    return figure ? { figure, alt } : null;
  });
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const onReadyRef = useRef(onReady);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  const currentTarget = (src: string) => src.includes(`target=${target}`)
    && (figureId === 'abducens-local' || src.includes(`figure=${figureId}`));
  const visibleDisplay = display && currentTarget(display.figure.src) ? display : null;

  useEffect(() => {
    let cancelled = false;
    onReadyRef.current?.(false);
    void prepareAnatomyFigure(target, phase, figureId).then((figure) => {
      if (!cancelled) { setFailed(false); setDisplay({ figure, alt }); onReadyRef.current?.(true); }
    }).catch(() => { if (!cancelled) { setFailed(true); onReadyRef.current?.(false); } });
    return () => { cancelled = true; };
    // Keep the old displayed alt until the new decoded phase is committed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, phase, figureId]);

  useEffect(() => {
    if (!display) return undefined;
    retain(display.figure.src);
    return () => release(display.figure.src);
  }, [display?.figure.src]);

  useEffect(() => { if (expanded) dialogRef.current?.focus(); }, [expanded]);
  const close = () => { setExpanded(false); triggerRef.current?.focus(); };
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab' && closeRef.current) { event.preventDefault(); closeRef.current.focus(); }
  };

  return <figure className="min-w-0" data-anatomy-figure>
    <div className="relative overflow-hidden rounded-xl bg-[var(--md-surface-container-low)]">
      {failed && <div className={`${visibleDisplay ? 'absolute inset-x-0 bottom-2 z-10' : 'min-h-48'} flex items-center justify-center gap-2 bg-[var(--md-surface)] p-2 text-center text-sm text-[var(--md-on-surface-variant)]`}><span role="alert">The figure could not load.</span><button type="button" className="underline" onClick={() => { setFailed(false); void prepareAnatomyFigure(target, phase, figureId).then((figure) => { setDisplay({ figure, alt }); onReadyRef.current?.(true); }).catch(() => setFailed(true)); }}>Retry figure</button></div>}
      {!visibleDisplay && !failed && <div className="flex min-h-48 items-center justify-center text-sm text-[var(--md-on-surface-variant)]" role="status">Loading figure…</div>}
      {visibleDisplay && <img src={visibleDisplay.figure.url} data-source={visibleDisplay.figure.src} alt={visibleDisplay.alt} className="block max-h-[min(58vh,34rem)] [@media(max-height:500px)]:max-h-[calc(100dvh-12rem)] w-full object-contain" />}
      {visibleDisplay && !failed && <button ref={triggerRef} type="button" aria-label="Enlarge anatomy figure" title="Enlarge" className="absolute bottom-2 right-2 flex h-[44px] w-[44px] items-center justify-center rounded-full bg-[var(--md-surface)]/90 text-[var(--md-on-surface)] shadow" onClick={() => setExpanded(true)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M3 3l6 6M21 3l-6 6M21 21l-6-6M3 21l6-6" /></svg></button>}
    </div>
    {caption && <figcaption className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{caption}</figcaption>}
    {expanded && visibleDisplay && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--md-scrim)]/80 p-4" role="presentation" onClick={close}><div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={visibleDisplay.alt} className="max-h-[92vh] max-w-5xl rounded-2xl bg-[var(--md-surface)] p-3 shadow-2xl outline-none" onClick={(event) => event.stopPropagation()} onKeyDown={trap}><div className="flex justify-end"><button ref={closeRef} type="button" className="rounded-md px-2 py-1 text-sm underline" onClick={close}>Close</button></div><img src={visibleDisplay.figure.url} data-source={visibleDisplay.figure.src} alt={visibleDisplay.alt} className="max-h-[82vh] w-full object-contain" /></div></div>}
  </figure>;
}
