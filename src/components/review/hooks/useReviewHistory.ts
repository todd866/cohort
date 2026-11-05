import { useEffect, useState } from 'react';
import { readOfflineOwner, subscribeOfflineOwner } from '@/lib/offline/owner';
import type { ReviewHistoryEntry } from '../ReviewHistoryDialog';

const HISTORY_LIMIT = 100;

/** Separate from the scheduler queue: inspecting history never consumes a turn. */
export function useReviewHistory(scope: string, entry: ReviewHistoryEntry | null) {
  const quarantined = readOfflineOwner()?.quarantined;
  const current = quarantined ? null : entry;
  // Media presentation may recreate an equivalent item on every render.
  const snapshotKey = JSON.stringify(current);
  const [state, setState] = useState<{
    scope: string; entries: ReviewHistoryEntry[]; index: number | null; current: ReviewHistoryEntry | null; snapshotKey: string;
  }>({ scope, entries: [], index: null, current, snapshotKey });
  useEffect(() => {
    let owner = readOfflineOwner();
    return subscribeOfflineOwner(() => {
      const next = readOfflineOwner();
      // The first guest answer can create the device partition. That is the
      // same anonymous session, not an account switch or invalidation.
      const initialGuest = !owner && next?.verified === false && !next.quarantined;
      owner = next;
      if (!initialGuest) setState({ scope, entries: [], index: null, current: null, snapshotKey: 'null' });
    });
  }, [scope]);

  // Adjust snapshots with the incoming turn, before children see stale history.
  // Compare contents, not object identity, to tolerate derived media snapshots.
  if (state.scope !== scope || (quarantined && (state.current || state.entries.length || state.index !== null))) {
    setState({ scope, entries: [], index: null, current, snapshotKey });
  } else if (state.snapshotKey !== snapshotKey) {
    const key = (value: ReviewHistoryEntry) => `${value.item.type}:${value.item.deliveryId ?? value.item.serveDecisionId ?? value.item.id}`;
    const previous = state.current;
    const entries = previous && (!current || key(previous) !== key(current))
      ? [...state.entries, previous] : state.entries;
    const trimmed = Math.max(0, entries.length - HISTORY_LIMIT);
    setState({ ...state, current, snapshotKey, entries: entries.slice(trimmed), index: state.index === null ? null : Math.max(0, state.index - trimmed) });
  }
  const entries = state.scope === scope ? state.entries : [];
  return {
    entries,
    index: state.scope === scope ? state.index : null,
    back: () => setState(value => ({ ...value, index: value.entries.length ? Math.max(0, (value.index ?? value.entries.length) - 1) : null })),
    setIndex: (index: number) => setState(value => ({ ...value, index })),
    close: () => setState(value => ({ ...value, index: null })),
  };
}
