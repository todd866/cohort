'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { CLIENT_FETCH_DEADLINE_MS, fetchWithDeadline } from '@/lib/fetch-with-deadline';

export type AnatomyFigureTarget = 'lateral-rectus' | 'abducens' | 'optic-nerve';
export type AnatomyFigurePhase = 'prompt' | 'answer';
export interface PreparedAnatomyFigure { src: string; url: string }
const MAX_PREPARED_FIGURES = 6;
const cache = new Map<string, Promise<PreparedAnatomyFigure>>();
const decoded = new Map<string, PreparedAnatomyFigure>();
const source = (target: AnatomyFigureTarget, phase: AnatomyFigurePhase) => `/api/anatomy/abducens?target=${target}&phase=${phase}`;

function evict() {
  while (cache.size > MAX_PREPARED_FIGURES) {
    const key = cache.keys().next().value as string | undefined;
    if (!key) return;
    const promise = cache.get(key);
    cache.delete(key);
    decoded.delete(key);
    void promise?.then((figure) => URL.revokeObjectURL(figure.url)).catch(() => undefined);
  }
}

/** Fetch and decode one of the six reviewed public anatomy figure states. */
export function prepareAnatomyFigure(target: AnatomyFigureTarget, phase: AnatomyFigurePhase): Promise<PreparedAnatomyFigure> {
  const src = source(target, phase);
  const existing = cache.get(src);
  if (existing) return existing;
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
      decoded.set(src, prepared);
      return prepared;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  })();
  cache.set(src, promise);
  evict();
  void promise.catch(() => { if (cache.get(src) === promise) cache.delete(src); });
  return promise;
}

export interface AnatomyReviewFigureProps {
  target: AnatomyFigureTarget; revealed: boolean; alt: string; caption?: string; onReady?: (ready: boolean) => void;
}

export function AnatomyReviewFigure({ target, revealed, alt, caption, onReady }: AnatomyReviewFigureProps) {
  const phase: AnatomyFigurePhase = revealed ? 'answer' : 'prompt';
  const [display, setDisplay] = useState<{ figure: PreparedAnatomyFigure; alt: string } | null>(() => {
    const figure = decoded.get(source(target, phase));
    return figure ? { figure, alt } : null;
  });
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const onReadyRef = useRef(onReady);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  useEffect(() => {
    let cancelled = false;
    onReadyRef.current?.(false);
    void prepareAnatomyFigure(target, phase).then((figure) => {
      if (!cancelled) { setFailed(false); setDisplay({ figure, alt }); onReadyRef.current?.(true); }
    }).catch(() => { if (!cancelled) { setFailed(true); onReadyRef.current?.(false); } });
    return () => { cancelled = true; };
    // Keep the old displayed alt until the new decoded phase is committed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, phase]);

  useEffect(() => { if (expanded) dialogRef.current?.focus(); }, [expanded]);
  const close = () => { setExpanded(false); triggerRef.current?.focus(); };
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Tab' && closeRef.current) { event.preventDefault(); closeRef.current.focus(); }
  };

  return <figure className="min-w-0" data-anatomy-figure>
    <div className="relative overflow-hidden rounded-xl bg-[var(--md-surface-container-low)]">
      {failed && <div className={`${display ? 'absolute inset-x-0 bottom-2 z-10' : 'min-h-48'} flex items-center justify-center gap-2 bg-[var(--md-surface)] p-2 text-center text-sm text-[var(--md-on-surface-variant)]`}><span role="alert">The figure could not load.</span><button type="button" className="underline" onClick={() => { setFailed(false); void prepareAnatomyFigure(target, phase).then((figure) => { setDisplay({ figure, alt }); onReadyRef.current?.(true); }).catch(() => setFailed(true)); }}>Retry figure</button></div>}
      {!display && !failed && <div className="flex min-h-48 items-center justify-center text-sm text-[var(--md-on-surface-variant)]" role="status">Loading figure…</div>}
      {display && <img src={display.figure.url} data-source={display.figure.src} alt={display.alt} className="block max-h-[min(58vh,34rem)] w-full object-contain" />}
      {display && !failed && <button ref={triggerRef} type="button" aria-label="Enlarge anatomy figure" className="absolute bottom-2 right-2 rounded-full bg-[var(--md-surface)]/90 px-3 py-1.5 text-xs font-medium text-[var(--md-on-surface)] shadow" onClick={() => setExpanded(true)}>Enlarge</button>}
    </div>
    {caption && <figcaption className="mt-2 text-xs text-[var(--md-on-surface-variant)]">{caption}</figcaption>}
    {expanded && display && <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--md-scrim)]/80 p-4" role="presentation" onClick={close}><div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={display.alt} className="max-h-[92vh] max-w-5xl rounded-2xl bg-[var(--md-surface)] p-3 shadow-2xl outline-none" onClick={(event) => event.stopPropagation()} onKeyDown={trap}><div className="flex justify-end"><button ref={closeRef} type="button" className="rounded-md px-2 py-1 text-sm underline" onClick={close}>Close</button></div><img src={display.figure.url} data-source={display.figure.src} alt={display.alt} className="max-h-[82vh] w-full object-contain" /></div></div>}
  </figure>;
}
