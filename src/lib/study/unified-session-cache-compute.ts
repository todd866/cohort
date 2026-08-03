import { constructUnifiedSession } from '@/lib/knowledge/unified-scheduler';
import type { UnifiedItem, SessionContext } from './unified-session-types';
import type { CommitmentLevel } from '@/lib/commitment';
import {
  hydrateScheduledItems,
  loadScheduledItemHydrationData,
} from './unified-session-hydration';
import { writeCacheBuildServeDecisions } from './serve-decision-write';

/**
 * Full manifold pipeline for background cache refresh.
 * Calls constructUnifiedSession WITHOUT exclusion data (scheduler fetches internally),
 * then hydrates from static content map + fallback DB queries.
 *
 * IMPORTANT — signed URL safety:
 * R2 signed URLs have a 2h TTL (hour-aligned). We must NOT store them in the
 * cache because a stale-cache hit after the hour boundary returns dead URLs.
 * Strategy: hydrate with session so trust-gating is correct, but strip the
 * short-lived `imageUrl` before storing. The stable `imageKey` and client-safe
 * `imageMeta` remain cached: metadata contains no delivery credential and is
 * required to preserve whether a figure is a prompt or after-reveal context.
 * At API egress (`tryCachedSession`) each item's `imageKey` is re-resolved to a
 * fresh signed URL for the current request.
 */
export async function computeAndHydrateSession(
  userId: string,
  rotation: string,
  weekFilter: number | null,
  batchSize: number,
  rotationContent: SessionContext['rotationContent'],
  imageTier: SessionContext['imageTier'],
  commitmentLevel?: CommitmentLevel,
  cacheBuildSessionId?: string,
): Promise<{ items: UnifiedItem[] }> {
  const sessionResult = await constructUnifiedSession(userId, {
    rotation,
    week: weekFilter ?? undefined,
    size: batchSize,
    commitmentLevel: commitmentLevel ?? 'browser',
    imageTier,
  });

  if (sessionResult.items.length === 0) return { items: [] };

  const hydrationData = await loadScheduledItemHydrationData({
    userId,
    rotationContent,
    scheduledItems: sessionResult.items,
  });

  // Background cache refresh always runs for real (non-guest) users.
  // Construct a minimal synthetic session so resolveImage can gate
  // auth-required images correctly (trust check still runs; signing is free
  // but its result is stripped before storage — see note above).
  const session = {
    user: { id: userId, imageTier },
  } as import('next-auth').Session;

  const hydratedItems = await hydrateScheduledItems(sessionResult.items, hydrationData, {
    rotation,
    includeVideos: true,
  }, session);

  // Strip signed URLs before caching. Keep the stable imageKey and client-safe
  // metadata so non-egress consumers (notably the offline pack) retain figure
  // placement. resolveImage is called again at live API egress for a fresh URL.
  const itemsForCache: UnifiedItem[] = hydratedItems.map((item) => ({
    ...item,
    imageUrl: null,
  }));

  if (cacheBuildSessionId) {
    const itemsWithDecisions = await writeCacheBuildServeDecisions(itemsForCache, {
      userId,
      cacheBuildSessionId,
      rotation,
      decisionPath: 'cache-refresh',
      queueReason: 'precompute',
    });
    return { items: itemsWithDecisions };
  }

  return { items: itemsForCache };
}
