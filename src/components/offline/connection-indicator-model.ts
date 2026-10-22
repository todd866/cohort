/**
 * One connection indicator per screen (owner, 15 Oct 2026: "two banners??
 * come on, we can't be wasting screen real estate like that").
 *
 * The review page used to show a full-width "Using saved device data" row
 * from the offline shell AND a floating "Offline · 2 queued" pill that sat
 * over the review toolbar and truncated its controls. Now there is one
 * instrument: a glyph plus the queued count, in a slot of an existing row.
 * The words are in its accessible label and its tap popover.
 *
 * Several surfaces can host it (the review toolbar, the main navigation, a
 * floating fallback for pages with neither). The registry below lets exactly
 * one of them render it: the most specific host that is mounted.
 */
import type { LinkState } from '@/lib/offline/connectivity';

export type IndicatorKind = 'offline' | 'degraded' | 'syncing' | 'live';
export type IndicatorHostTier = 'toolbar' | 'nav' | 'floating';

export interface IndicatorView {
  kind: IndicatorKind;
  count: number;
  title: string;
  details: string[];
  /** Tooltip and accessible name: the title and details in one line. */
  label: string;
  href?: string;
}

function answers(count: number): string {
  return `${count} answer${count === 1 ? '' : 's'}`;
}

export function connectionIndicatorView({
  link,
  queued,
  queuedStale,
  deviceData,
  liveHref,
  offlineMessage,
}: {
  link: LinkState;
  queued: number;
  /** Answers have stayed queued long enough that a healthy-looking link is not syncing them. */
  queuedStale: boolean;
  /** A review on screen is serving from the saved pack. */
  deviceData: boolean;
  /** The offline page is showing while the browser is back online. */
  liveHref: string | null;
  offlineMessage?: string;
}): IndicatorView | null {
  if (liveHref && link !== 'offline') {
    return {
      kind: 'live',
      count: queued,
      title: 'Live',
      details: [],
      label: 'Return to live md3',
      href: liveHref,
    };
  }
  const device = deviceData ? 'Using saved device data' : null;
  let title: string;
  let kind: IndicatorKind;
  let details: Array<string | null>;
  if (link === 'offline') {
    kind = 'offline';
    title = 'Offline';
    details = [
      device ?? offlineMessage ?? null,
      queued > 0 ? `${answers(queued)} will sync when you're back online` : null,
    ];
  } else if (link === 'degraded') {
    kind = 'degraded';
    title = 'Weak connection';
    details = [
      device,
      queued > 0 ? `${answers(queued)} saved on this device, retrying` : 'Retrying in the background',
    ];
  } else if (queued > 0 && queuedStale) {
    kind = 'syncing';
    title = 'Syncing';
    details = [`${answers(queued)} saved on this device, retrying sync`];
  } else {
    return null;
  }
  const kept = details.filter((line): line is string => Boolean(line));
  return { kind, count: queued, title, details: kept, label: [title, ...kept].join(' · ') };
}

const TIER_ORDER: readonly IndicatorHostTier[] = ['toolbar', 'nav', 'floating'];

export interface IndicatorHostRegistry {
  register(tier: IndicatorHostTier): () => void;
  top(): IndicatorHostTier | null;
  liveHref(): string | null;
  setLiveHref(href: string | null): void;
  subscribe(listener: () => void): () => void;
}

export function createIndicatorHostRegistry(): IndicatorHostRegistry {
  const counts: Record<IndicatorHostTier, number> = { toolbar: 0, nav: 0, floating: 0 };
  let live: string | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    register(tier) {
      counts[tier] += 1;
      notify();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        counts[tier] = Math.max(0, counts[tier] - 1);
        notify();
      };
    },
    top: () => TIER_ORDER.find((tier) => counts[tier] > 0) ?? null,
    liveHref: () => live,
    setLiveHref(href) {
      if (href === live) return;
      live = href;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The page-wide registry. */
export const indicatorHosts = createIndicatorHostRegistry();
