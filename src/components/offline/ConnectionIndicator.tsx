'use client';

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getLinkState,
  getServerLinkState,
  isDeviceDataInUse,
  subscribeLinkState,
  type LinkState,
} from '@/lib/offline/connectivity';
import { getQueueSize, subscribeOutbox } from '@/lib/outbox';
import {
  connectionIndicatorView,
  indicatorHosts,
  type IndicatorHostTier,
  type IndicatorKind,
} from './connection-indicator-model';

/** A radio dip shorter than this never shows anything (owner, 12 Oct 2026). */
export const OFFLINE_SHOW_AFTER_MS = 8_000;
/** Answers queued this long on a link that looks healthy show as syncing. */
export const QUEUED_SHOW_AFTER_MS = 20_000;

type Placement = 'below' | 'above' | 'right';

const POPOVER_PLACEMENT: Record<Placement, string> = {
  below: 'right-0 top-full mt-1',
  above: 'bottom-full right-0 mb-2',
  right: 'bottom-0 left-full ml-2',
};

const KIND_CLASS: Record<IndicatorKind, string> = {
  offline: 'bg-[var(--md-tertiary-container)] text-[var(--md-on-tertiary-container)]',
  degraded: 'bg-[var(--md-tertiary-container)] text-[var(--md-on-tertiary-container)]',
  syncing: 'border border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)]',
  live: 'border border-[var(--md-outline-variant)] text-[var(--md-primary)]',
};

function Glyph({ kind, className = 'h-5 w-5' }: { kind: IndicatorKind; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'offline') {
    // Cloud with a strike: no connection at all.
    return (
      <svg {...common}>
        <path d="m2 2 20 20" />
        <path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2" />
        <path d="M21.5 16.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1" />
      </svg>
    );
  }
  if (kind === 'degraded') {
    // Signal bars, one of four lit: connected, barely.
    return (
      <svg {...common}>
        <path d="M3 20h.01" strokeWidth={3} />
        <path d="M8 20v-4" />
        <path d="M13 20v-8" opacity={0.3} />
        <path d="M18 20V8" opacity={0.3} />
      </svg>
    );
  }
  // Sync arrows: queued answers on their way, or the way back to live.
  return (
    <svg {...common}>
      <path d="M3 12a9 9 0 0 1 15.7-6L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.7 6L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

/**
 * The link state as shown: a drop to offline must last OFFLINE_SHOW_AFTER_MS
 * before it shows (a page that opens offline shows at once). A degraded link
 * shows at once, because it is only ever set by a request that already failed.
 */
function useShownLink(link: LinkState): LinkState {
  const [offlineShown, setOfflineShown] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  const [previousLink, setPreviousLink] = useState(link);
  if (previousLink !== link) {
    setPreviousLink(link);
    if (link !== 'offline' && offlineShown) setOfflineShown(false);
    // Already showing a weak link: going fully offline is not a "dip".
    if (link === 'offline' && previousLink === 'degraded') setOfflineShown(true);
  }
  useEffect(() => {
    if (link !== 'offline' || offlineShown) return undefined;
    const timer = setTimeout(() => setOfflineShown(true), OFFLINE_SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [link, offlineShown]);
  if (link !== 'offline') return link;
  return offlineShown ? 'offline' : 'online';
}

function useReviewQueue(): { queued: number; queuedStale: boolean } {
  const [queued, setQueued] = useState(0);
  const [queuedStale, setQueuedStale] = useState(false);
  useEffect(() => {
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      // Answers and feedback share the one queued count.
      const size = getQueueSize();
      setQueued(size);
      if (size === 0) {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = null;
        setQueuedStale(false);
      } else if (!staleTimer) {
        staleTimer = setTimeout(() => setQueuedStale(true), QUEUED_SHOW_AFTER_MS);
      }
    };
    read();
    const unsubscribe = subscribeOutbox(read);
    return () => {
      unsubscribe();
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, []);
  return { queued, queuedStale };
}

const subscribeHosts = (listener: () => void) => indicatorHosts.subscribe(listener);
const readLiveHref = () => indicatorHosts.liveHref();
const readNull = () => null;
const readFalse = () => false;

/**
 * The single connection instrument: a glyph and the queued count in a slot of
 * an existing row. Never a full-width row, never floating over another
 * control. Tap for the words.
 */
export function ConnectionIndicator({
  host,
  placement = 'below',
  offlineMessage,
}: {
  host: IndicatorHostTier;
  placement?: Placement;
  /** Detail line for surfaces with no saved review (e.g. the textbook reader). */
  offlineMessage?: string;
}) {
  useLayoutEffect(() => indicatorHosts.register(host), [host]);
  const isTop = useSyncExternalStore(
    subscribeHosts,
    () => indicatorHosts.top() === host,
    readFalse,
  );
  const link = useSyncExternalStore(subscribeLinkState, getLinkState, getServerLinkState);
  const deviceData = useSyncExternalStore(subscribeLinkState, isDeviceDataInUse, readFalse);
  const liveHref = useSyncExternalStore(subscribeHosts, readLiveHref, readNull);
  const shownLink = useShownLink(link);
  const { queued, queuedStale } = useReviewQueue();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  const view = connectionIndicatorView({
    link: shownLink,
    queued,
    queuedStale,
    deviceData,
    liveHref,
    offlineMessage,
  });
  const visible = isTop && view !== null;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!visible || !view) return null;

  const pill = `relative inline-flex h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1 rounded-full px-2 text-xs font-semibold tabular-nums whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${KIND_CLASS[view.kind]}`;
  const wrapper = host === 'floating'
    ? 'fixed right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-[100] inline-flex'
    : 'relative inline-flex shrink-0';

  if (view.kind === 'live' && view.href) {
    return (
      <span ref={rootRef} className={wrapper} data-connection-indicator={view.kind}>
        <a
          href={view.href}
          data-md3-live-navigation
          aria-label={view.label}
          title={view.label}
          className={pill}
        >
          <Glyph kind="live" />
          <span aria-hidden="true">Live</span>
        </a>
      </span>
    );
  }

  return (
    <span ref={rootRef} className={wrapper} data-connection-indicator={view.kind}>
      <span role="status" className="sr-only">{view.label}</span>
      <button
        type="button"
        aria-label={view.label}
        title={view.label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={pill}
      >
        <Glyph kind={view.kind} />
        {view.count > 0 ? <span aria-hidden="true">{view.count}</span> : null}
      </button>
      {open ? (
        <span
          role="dialog"
          aria-label="Connection"
          className={`absolute z-[60] w-[min(16rem,calc(100vw-1.5rem))] rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface)] p-3 text-left text-xs font-normal text-[var(--md-on-surface-variant)] shadow-xl ${POPOVER_PLACEMENT[placement]}`}
        >
          <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--md-on-surface)]">
            <Glyph kind={view.kind} className="h-4 w-4" />
            {view.title}
          </span>
          {view.details.map((line) => (
            <span key={line} className="mt-1 block">{line}</span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
