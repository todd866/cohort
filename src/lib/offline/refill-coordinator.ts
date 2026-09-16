import { getQueueSize, subscribeOutbox } from '@/lib/outbox';
import { fillOfflinePack, type FillResult } from './fill';
import { readPack, subscribePackChanges, type PackChangeReason } from './pack';
import { isOfflineOwnerCurrent, subscribeOfflineOwner, type OwnerLease } from './owner';

export const INITIAL_REFILL_DELAY_MS = 0;
export const REFILL_DEBOUNCE_MS = 1_000;
export const REFILL_COOLDOWN_MS = 60_000;
export const REFILL_RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const;
export const MEDIA_CONTINUATION_DELAY_MS = 200;

// A remount must not start another bulk fetch while this owner's previous
// coordinator is still awaiting it. Generation distinguishes sign-out/rebind.
const fillsInFlight = new Map<string, Promise<FillResult>>();

function fillOnce(lease: OwnerLease): Promise<FillResult> {
  const key = JSON.stringify([lease.ownerKey, lease.generation]);
  const existing = fillsInFlight.get(key);
  if (existing) return existing;
  const pending = Promise.resolve().then(() => isOfflineOwnerCurrent(lease)
    ? fillOfflinePack(lease.ownerKey)
    : { filled: false, itemCount: 0, figuresCached: 0, reason: 'owner-changed' as const });
  fillsInFlight.set(key, pending);
  const release = () => {
    if (fillsInFlight.get(key) === pending) fillsInFlight.delete(key);
  };
  void pending.then(release, release);
  return pending;
}

function reserveVersion(userKey: string) {
  const pack = readPack(userKey);
  return {
    bulkFilledAt: pack?.bulkFilledAt ?? 0,
    // Compare content identities, not savedAt: a metadata save or another tab's
    // identical fill is not consumption. These keys stay in memory only.
    items: JSON.stringify((pack?.items ?? []).map((item) => {
      const row = item as {
        type?: unknown; id?: unknown; imageKey?: unknown;
        imageMeta?: { revealImageKey?: unknown } | null;
        imageAlternatives?: unknown;
      } | null;
      return JSON.stringify([row?.type, row?.id, row?.imageKey, row?.imageMeta?.revealImageKey, row?.imageAlternatives]);
    }).sort()),
  };
}

/**
 * Keep the current owner's reserve ready while the page is in use. Fill itself
 * decides whether scheduler data is stale and fences writes with an owner lease.
 * This coordinator limits when work starts; a small eligible pool does not by
 * itself cause another request, and failed media gets only three timed retries.
 */
export function startOfflineRefillCoordinator(
  lease: OwnerLease,
  onSettled: (lastError?: string) => void = () => {},
): () => void {
  // readPack deliberately wipes a mismatched owner, so reject a stale caller
  // before even reading reserve metadata under its old key.
  if (typeof window === 'undefined' || !isOfflineOwnerCurrent(lease)) return () => {};

  let disposed = false;
  let running = false;
  let requested = false;
  let retryCount = 0;
  let nextAllowedAt = Date.now() + INITIAL_REFILL_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = Infinity;
  let reserve = reserveVersion(lease.ownerKey);
  let queueSize = getQueueSize('review', lease.ownerKey);
  const unsubscribers: Array<() => void> = [];

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    timerAt = Infinity;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimer();
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  function isCurrent() {
    if (disposed) return false;
    if (isOfflineOwnerCurrent(lease)) return true;
    dispose();
    return false;
  }

  function canRun() {
    return navigator.onLine !== false && document.visibilityState !== 'hidden';
  }

  function schedule(delay: number) {
    if (!isCurrent() || running) return;
    if (!canRun()) {
      clearTimer();
      return; // Reconnect/foreground will re-arm the pending work.
    }
    const due = Math.max(Date.now() + delay, nextAllowedAt);
    if (timerAt <= due) return;
    clearTimer();
    timerAt = due;
    timer = setTimeout(() => { void run(); }, Math.max(0, due - Date.now()));
  }

  function request() {
    if (!isCurrent()) return;
    requested = true;
    retryCount = 0; // A real external change is a new repair opportunity.
    schedule(REFILL_DEBOUNCE_MS);
  }

  async function run() {
    clearTimer();
    if (!isCurrent() || running || !canRun()) return;
    requested = false;
    running = true;
    let result: FillResult | undefined;
    let lastError: string | undefined;
    try {
      result = await fillOnce(lease);
      if (result.reason === 'failed') lastError = 'failed';
    } catch {
      // Counts/state only: an exception message may contain a signed media URL.
      lastError = 'failed';
    } finally {
      running = false;
    }
    if (!isCurrent()) return;
    // Pending grades permit media preparation but skip the scheduler request.
    // Do not make replay drain wait a full scheduler cooldown after that skip.
    nextAllowedAt = Date.now() + (result?.reason === 'pending-reviews' ? 0 : REFILL_COOLDOWN_MS);
    if (result?.reason === 'owner-changed') {
      dispose();
      return;
    }
    try { onSettled(lastError); } catch { /* Diagnostics must not stop refills. */ }

    const needsRetry = lastError === 'failed' || (result?.mediaMissing ?? 0) > 0;
    if ((result?.mediaMissing ?? 0) > 0 && (result?.figuresCached ?? 0) > 0) {
      // A healthy large pack may take several bounded download passes. Keep
      // progressing instead of spending minutes between successful chunks.
      retryCount = 0;
      nextAllowedAt = Date.now() + MEDIA_CONTINUATION_DELAY_MS;
      schedule(MEDIA_CONTINUATION_DELAY_MS);
    } else if (needsRetry && retryCount < REFILL_RETRY_DELAYS_MS.length) {
      schedule(REFILL_RETRY_DELAYS_MS[retryCount++]);
    }
    // Consumption/append/drain during an active fill gets one follow-up. The
    // fill's own save is ignored below, so sparse pools cannot cause a loop.
    if (requested) schedule(REFILL_DEBOUNCE_MS);
  }

  const onPackChange = (reason: PackChangeReason) => {
    if (!isCurrent()) return;
    const previous = reserve;
    reserve = reserveVersion(lease.ownerKey);
    if (reason === 'save') return;
    if (reason === 'storage' && (
      reserve.items === previous.items || reserve.bulkFilledAt !== previous.bulkFilledAt
    )) return;
    request();
  };
  const onOutboxChange = () => {
    if (!isCurrent()) return;
    const previous = queueSize;
    queueSize = getQueueSize('review', lease.ownerKey);
    if (previous > 0 && queueSize === 0) request();
  };
  const onAvailabilityChange = () => {
    if (canRun()) request();
    else clearTimer();
  };

  unsubscribers.push(
    subscribePackChanges(onPackChange),
    subscribeOutbox(onOutboxChange),
    subscribeOfflineOwner(() => { isCurrent(); }),
  );
  window.addEventListener('online', onAvailabilityChange);
  window.addEventListener('offline', onAvailabilityChange);
  window.addEventListener('focus', onAvailabilityChange);
  document.addEventListener('visibilitychange', onAvailabilityChange);
  unsubscribers.push(() => {
    window.removeEventListener('online', onAvailabilityChange);
    window.removeEventListener('offline', onAvailabilityChange);
    window.removeEventListener('focus', onAvailabilityChange);
    document.removeEventListener('visibilitychange', onAvailabilityChange);
  });
  schedule(INITIAL_REFILL_DELAY_MS);
  return dispose;
}
