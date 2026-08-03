'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { warmOfflineShell } from '@/lib/offline/shell';
import { ensurePersistentStorage } from '@/lib/offline/persist';
import { fillOfflinePack } from '@/lib/offline/fill';
import { offlineUserKey, packStatus, readPack } from '@/lib/offline/pack';
import { bindOfflineOwner } from '@/lib/offline/device-state';
import { getQueueSize } from '@/lib/outbox';
import { readPersistenceState } from '@/lib/offline/persist';
import { countCachedFigures } from '@/lib/offline/figures';
import { buildSnapshot, reportOfflineState } from '@/lib/offline/telemetry';

/**
 * Prepares everything the app needs to survive losing its connection.
 *
 * Two jobs, both on idle so neither competes with the review batch already in
 * flight:
 *
 *  1. Cache the `/offline` document and its chunks. The worker caches build
 *     assets lazily — only what the browser has already asked for — and
 *     `/offline` is by definition a route you never visit while online, so
 *     without this it would be missing at exactly the moment it is needed.
 *  2. Top the study pack up to ~500 items and cache their figures, so a full
 *     day out of signal cannot exhaust it.
 */
async function sendTelemetry(userKey: string, lastError?: string): Promise<void> {
  try {
    const status = packStatus();
    const [persistence, figuresCached, estimate] = await Promise.all([
      readPersistenceState().catch(() => 'unsupported' as const),
      // -1 distinguishes "the Cache API failed" from a genuine zero. Swallowing
      // the error as 0 made an unavailable cache indistinguishable from an empty
      // one, which is the difference between a bug and a working empty state.
      countCachedFigures(userKey).catch(() => -1),
      navigator.storage?.estimate?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);

    await reportOfflineState(
      buildSnapshot(
        {
          packItems: status.itemCount,
          packUpdatedAt: status.savedAt,
          packRotations: readPack(userKey)?.rotations?.length ?? 0,
          figuresCached,
          persistence,
          outboxSize: getQueueSize('review', userKey),
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
    bindOfflineOwner(userKey);

    // Later than the shell warm: the shell is a few dozen KB, the pack is a few
    // hundred plus figures, and only one of them matters on the very next cold
    // launch.
    let alive = true;
    const timer = window.setTimeout(() => {
      fillOfflinePack(userKey)
        .then((result) => (
          result.reason === 'failed' || result.reason === 'owner-changed'
            ? result.reason
            : undefined
        ))
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
        .then((maybeError) => {
          // Report AFTER the fill either way. iOS has no devtools and an
          // installed app has its own storage container, so this is the only
          // way to find out what the phone actually did — including when the
          // fill failed, which would otherwise be silent.
          if (alive) void sendTelemetry(userKey, maybeError);
        });
    }, 8_000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [sessionStatus, userKey]);

  return null;
}
