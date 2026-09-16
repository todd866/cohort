'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { warmOfflineShell } from '@/lib/offline/shell';
import { ensurePersistentStorage } from '@/lib/offline/persist';
import { offlineUserKey, PACK_MAX_ITEMS, readPack } from '@/lib/offline/pack';
import { bindOfflineOwner } from '@/lib/offline/device-state';
import { isOfflineOwnerCurrent, type OwnerLease } from '@/lib/offline/owner';
import { startOfflineRefillCoordinator } from '@/lib/offline/refill-coordinator';
import { getOutboxStatus } from '@/lib/outbox';
import { readPersistenceState } from '@/lib/offline/persist';
import { countCachedFigures, readFigureReadiness } from '@/lib/offline/figures';
import { buildSnapshot, reportOfflineState } from '@/lib/offline/telemetry';

/**
 * Prepares everything the app needs to survive losing its connection.
 *
 * Two jobs, delayed initially so neither competes with the first review batch:
 *
 *  1. Cache the `/offline` document and its chunks. The worker caches build
 *     assets lazily — only what the browser has already asked for — and
 *     `/offline` is by definition a route you never visit while online, so
 *     without this it would be missing at exactly the moment it is needed.
 *  2. Keep up to 1,000 eligible study items and their figures ready as the
 *     reserve is consumed, the page returns to the foreground, or sync drains.
 */
async function sendTelemetry(lease: OwnerLease, lastError?: string): Promise<void> {
  try {
    if (!isOfflineOwnerCurrent(lease)) return;
    const userKey = lease.ownerKey;
    const pack = readPack(userKey);
    const [persistence, figuresCached, readiness, estimate] = await Promise.all([
      readPersistenceState().catch(() => 'unsupported' as const),
      // -1 distinguishes "the Cache API failed" from a genuine zero. Swallowing
      // the error as 0 made an unavailable cache indistinguishable from an empty
      // one, which is the difference between a bug and a working empty state.
      countCachedFigures(userKey).catch(() => -1),
      readFigureReadiness(pack?.items ?? [], userKey),
      navigator.storage?.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
    if (!isOfflineOwnerCurrent(lease)) return;
    const outbox = getOutboxStatus(userKey);

    await reportOfflineState(
      buildSnapshot(
        {
          packItems: pack?.items.length ?? 0,
          packUpdatedAt: pack?.savedAt ?? null,
          packRotations: pack?.rotations.length ?? 0,
          packTargetItems: PACK_MAX_ITEMS,
          figuresCached,
          packFiguresTotal: readiness.total,
          ...(readiness.available ? {
            packFiguresCached: readiness.cached,
            packFiguresMissing: readiness.missing,
            packRequiredImagesMissing: readiness.requiredMissingItems,
          } : {}),
          persistence,
          outboxSize: outbox.count,
          outboxAuthBlocked: outbox.requiresAuthCount > 0,
          lastError,
        },
        {
          ua: navigator.userAgent,
          matchMedia: (q) => window.matchMedia(q).matches,
          navStandalone: (navigator as { standalone?: boolean }).standalone,
          swRegistered: Boolean(reg),
          swControlling: Boolean(navigator.serviceWorker?.controller),
          usage: estimate?.usage,
          quota: estimate?.quota,
        },
      ),
    );
  } catch {
    // Telemetry must never be the thing that breaks the page it reports on.
  }
}

export function OfflineShellWarm() {
  const { data: session, status: sessionStatus } = useSession();
  const userKey = offlineUserKey(session?.user);

  useEffect(() => {
    const schedule =
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 2_000);

    schedule(() => {
      // Ask before writing hundreds of KB, so the pack is protected from the
      // moment it lands rather than after the next eviction sweep.
      ensurePersistentStorage().catch(() => {});
      warmOfflineShell().catch(() => {});
    });
  }, []);

  useEffect(() => {
    if (sessionStatus !== 'authenticated' || !userKey) return;
    // Establish the account boundary synchronously, before any delayed fill can
    // capture a lease or write personalized data.
    const lease = bindOfflineOwner(userKey);
    return startOfflineRefillCoordinator(lease, (lastError) => {
      // Report after bounded preparation, never on individual queue acks.
      void sendTelemetry(lease, lastError);
    });
  }, [sessionStatus, userKey]);

  return null;
}
