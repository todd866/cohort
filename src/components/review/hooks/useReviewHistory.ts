import { useEffect, useMemo, useState } from 'react';
import { readOfflineOwner, subscribeOfflineOwner } from '@/lib/offline/owner';
import type { ReviewItem } from './types';
import { isProtectedPracticeItem } from './practice-follow-up-turn';

/** How many earlier items of this session can be rewound. Older ones drop off. */
export const REWIND_HISTORY_LIMIT = 20;

/**
 * Lane marker stored on the new grade's metadata.servedBy.
 * A scheduler serve uses manifold-walk, cached, starter, and the other
 * existing lanes. A rewind is another review of an item already in memory,
 * so audits can tell it from those serves.
 */
export const REWIND_ORIGIN = 'session-rewind';

export function reviewItemIdentity(item: {
  type: string;
  id: string;
  deliveryId?: string | null;
  serveDecisionId?: string | null;
}): string {
  return `${item.type}:${item.deliveryId ?? item.serveDecisionId ?? item.id}`;
}

export function rewindEligible(item: ReviewItem | null | undefined): item is ReviewItem {
  if (!item) return false;
  if (item.type === 'group') return false;
  if (isProtectedPracticeItem(item)) return false;
  return item.type === 'card' || item.type === 'question' || item.type === 'video';
}

/**
 * The item as a fresh review. The earlier delivery is not reused: a second
 * grade of the same serve decision is what the client treats as a re-read,
 * and the server will not open an already-answered serve decision again.
 * Dropping that identity is how a same-session repeat with no delivery of
 * its own is recorded as a new event.
 */
export function presentRewoundItem(item: ReviewItem): ReviewItem {
  const presented: ReviewItem = { ...item, firstSightAtSelection: false };
  delete presented.serveDecisionId;
  delete presented.batchId;
  delete presented.sessionId;
  delete presented.deliveryId;
  delete presented.answerSource;
  presented.decisionContext = {
    ...(item.decisionContext ?? {}),
    servedBy: REWIND_ORIGIN,
  };
  return presented;
}

export interface ReviewScrollMark {
  x: number;
  y: number;
  scrollers: Array<[HTMLElement, number]>;
}

export function captureReviewScroll(root: HTMLElement | null): ReviewScrollMark {
  const scrollers: Array<[HTMLElement, number]> = [];
  for (let el = root; el; el = el.parentElement) {
    if (el.scrollTop) scrollers.push([el, el.scrollTop]);
  }
  return {
    x: typeof window === 'undefined' ? 0 : window.scrollX,
    y: typeof window === 'undefined' ? 0 : window.scrollY,
    scrollers,
  };
}

export function restoreReviewScroll(mark: ReviewScrollMark): void {
  if (typeof window === 'undefined') return;
  window.scrollTo({ left: mark.x, top: mark.y, behavior: 'auto' });
  for (const [el, top] of mark.scrollers) {
    if (el.isConnected) el.scrollTop = top;
  }
}

interface RewindState {
  scope: string;
  entries: ReviewItem[];
  offset: number;
  current: ReviewItem | null;
  snapshotKey: string;
}

/**
 * Session rewind. The scheduler queue is not moved: earlier items are shown
 * by the normal review surface, and grading one records a new event.
 * Offset 0 is the live item. Offset 1 is the newest item already left.
 */
export function useReviewRewind(scope: string, item: ReviewItem | null) {
  const quarantined = readOfflineOwner()?.quarantined;
  const current = quarantined || !rewindEligible(item) ? null : item;
  const snapshotKey = current ? reviewItemIdentity(current) : 'null';
  const [state, setState] = useState<RewindState>({
    scope, entries: [], offset: 0, current, snapshotKey,
  });

  useEffect(() => {
    let owner = readOfflineOwner();
    return subscribeOfflineOwner(() => {
      const next = readOfflineOwner();
      const initialGuest = !owner && next?.verified === false && !next.quarantined;
      owner = next;
      if (!initialGuest) {
        setState({ scope, entries: [], offset: 0, current: null, snapshotKey: 'null' });
      }
    });
  }, [scope]);

  if (state.scope !== scope || (quarantined && (state.current || state.entries.length || state.offset !== 0))) {
    setState({ scope, entries: [], offset: 0, current, snapshotKey });
  } else if (state.snapshotKey !== snapshotKey) {
    const previous = state.current;
    const entries = previous
      ? [...state.entries, previous].slice(-REWIND_HISTORY_LIMIT)
      : state.entries;
    // The live item moved on its own. A rewind position belonged to the
    // item that was current, so drop back to whatever is live now.
    setState({ scope, current, snapshotKey, entries, offset: 0 });
  }

  const active = state.scope === scope ? state : { entries: [] as ReviewItem[], offset: 0 };
  const stored = active.offset > 0 ? active.entries[active.entries.length - active.offset] ?? null : null;
  // The stored item is stable. A fresh object on every render would look like
  // a new serve to effects that key on the item.
  const presented = useMemo(() => (stored ? presentRewoundItem(stored) : null), [stored]);

  return {
    entries: active.entries,
    offset: active.offset,
    /** Items still behind the one on screen. */
    canBack: active.offset < active.entries.length,
    canForward: active.offset > 0,
    presented,
    back: () => setState(value => (
      value.entries.length > value.offset ? { ...value, offset: value.offset + 1 } : value
    )),
    forward: () => setState(value => (value.offset > 0 ? { ...value, offset: value.offset - 1 } : value)),
    escape: () => setState(value => (value.offset === 0 ? value : { ...value, offset: 0 })),
  };
}
