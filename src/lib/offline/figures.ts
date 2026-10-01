/** Durable owner-scoped caching for this distribution's same-origin open media. */
import { CLIENT_FETCH_DEADLINE_MS } from '@/lib/fetch-with-deadline';
import {
  isOfflineOwnerCurrent,
  readOfflineOwner,
  subscribeOfflineOwner,
  type OwnerLease,
} from './owner';
import { itemImageIsPrompt } from '@/lib/figures/prompt-policy';
import { isOfflineImageKey } from './image-key';

export const FIGURE_CACHE = 'md3-public-open-media-v1';
export const OFFLINE_FIGURES_CHANGE_EVENT = 'offline-figures:change';
/** Two download chains leave capacity for the figure currently being read. */
export const FIGURE_DOWNLOAD_CONCURRENCY = 2;

interface FigureCacheDiagnostics {
  attempted: number;
  deliveryFailed: number;
  downloadFailed: number;
  storeFailed: number;
  succeeded: number;
}

export interface FigureCacheResult {
  newlyCached: number;
  /** Stable keys whose bytes are present for the current owner after this pass. */
  availableKeys: ReadonlySet<string>;
}

type FigureItem = {
  type?: unknown;
  imageKey?: unknown;
  imageUrl?: unknown;
  imageRole?: string | null;
  imageMeta?: { class?: string; showWhen?: string; revealImageKey?: unknown } | null;
  imageAlternatives?: unknown;
};

/** Stable keys for both the question and its answer state. */
function allImageKeysForItems(items: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of items) {
    const row = item as FigureItem | null;
    const choices = [row, ...(Array.isArray(row?.imageAlternatives) ? row.imageAlternatives : [])] as Array<FigureItem | null>;
    for (const choice of choices) {
      for (const key of [choice?.imageKey || choice?.imageUrl, choice?.imageMeta?.revealImageKey]) {
        if (typeof key === 'string' && key.length > 0) keys.add(key);
      }
    }
  }
  return [...keys];
}

export function figureKeysForItems(items: readonly unknown[]): string[] {
  return allImageKeysForItems(items).filter(isOfflineImageKey);
}

export function hasRequiredFigures(item: unknown, availableKeys: ReadonlySet<string>): boolean {
  const row = item as FigureItem | null;
  if (!row || (row.type !== 'card' && row.type !== 'question')) return true;
  if (!itemImageIsPrompt(row.imageRole, row.imageMeta)) return true;
  // A reveal plate is the answer state of an image prompt, not optional
  // decoration. Never advertise the prompt as usable without both states.
  return typeof row.imageKey === 'string'
    && availableKeys.has(row.imageKey)
    && (typeof row.imageMeta?.revealImageKey !== 'string'
      || availableKeys.has(row.imageMeta.revealImageKey));
}

export interface FigureReadiness {
  available: boolean;
  total: number;
  cached: number;
  missing: number;
  requiredMissingItems: number;
  /** Referenced media outside the supported durable namespaces. */
  unsupported?: number;
}

/** Current-pack coverage, not the number of unrelated old cache entries. */
export async function readFigureReadiness(
  items: readonly unknown[],
  expectedOwnerKey?: string,
): Promise<FigureReadiness> {
  const keys = allImageKeysForItems(items);
  const unsupported = keys.filter(key => !isOfflineImageKey(key)).length;
  const unavailable = (): FigureReadiness => ({
    available: false,
    total: keys.length,
    cached: 0,
    missing: keys.length,
    requiredMissingItems: items.filter((item) => !hasRequiredFigures(item, new Set())).length,
    ...(unsupported ? { unsupported } : {}),
  });
  const api = cacheApi();
  const owner = readOfflineOwner();
  if (!api || !owner || (expectedOwnerKey && owner.ownerKey !== expectedOwnerKey)) return unavailable();
  const lease: OwnerLease = { ownerKey: owner.ownerKey, generation: owner.generation };
  try {
    const cache = await api.open(FIGURE_CACHE);
    const availableKeys = new Set<string>();
    for (const key of keys) {
      if (!isOfflineOwnerCurrent(lease)) return unavailable();
      if (await cache.match(figureCacheKey(key, lease.ownerKey))) availableKeys.add(key);
    }
    if (!isOfflineOwnerCurrent(lease)) return unavailable();
    return {
      available: true,
      total: keys.length,
      cached: availableKeys.size,
      missing: keys.length - availableKeys.size,
      requiredMissingItems: items.filter((item) => !hasRequiredFigures(item, availableKeys)).length,
      ...(unsupported ? { unsupported } : {}),
    };
  } catch {
    return unavailable();
  }
}

function announceFiguresChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OFFLINE_FIGURES_CHANGE_EVENT));
  }
}

/**
 * One aggregate report per cache pass. Never include an image key, signed URL,
 * caption, owner id, or other content identifier: production only needs to
 * know which stage reduced a pack to zero cached figures.
 */
function reportFigureCacheDiagnostics(diagnostics: FigureCacheDiagnostics): void {
  if (diagnostics.attempted === 0) return;
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    navigator.sendBeacon(
      '/api/log/client-error',
      JSON.stringify({
        error:
          'offline-figure-cache: '
          + `attempted=${diagnostics.attempted};`
          + `deliveryFailed=${diagnostics.deliveryFailed};`
          + `downloadFailed=${diagnostics.downloadFailed};`
          + `storeFailed=${diagnostics.storeFailed};`
          + `succeeded=${diagnostics.succeeded}`,
        ts: Date.now(),
      }),
    );
  } catch {
    // Diagnostics must never turn optional figure caching into a fill failure.
  }
}

/** Synthetic same-origin key. The worker ignores it — not a navigation, not /_next/static. */
export function figureCacheKey(
  imageKey: string,
  ownerKey = readOfflineOwner()?.ownerKey ?? 'unbound',
): string {
  return `/__offline-figure?owner=${encodeURIComponent(ownerKey)}&key=${encodeURIComponent(imageKey)}`;
}

function cacheApi(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches;
}

/**
 * Fetch and store the bytes for each figure. Returns how many are newly cached.
 * Already-present keys are skipped, so topping the pack up re-downloads nothing.
 */
/** Bound both network bodies and CacheStorage promises, not just headers. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Figure cache deadline or owner changed'));
    signal.addEventListener('abort', onAbort, { once: true });
    // Always attach handlers, including when already aborted: a late body
    // rejection must not become an unhandled promise rejection.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

const FIGURE_CACHE_PASS_DEADLINE_MS = 45_000;
const downloadsInFlight = new Map<string, Promise<boolean>>();
let activeDownloads = 0;
const downloadWaiters: Array<() => void> = [];

function downloadSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = downloadWaiters.indexOf(grant);
      if (index !== -1) downloadWaiters.splice(index, 1);
      reject(new Error('Figure preparation ended while queued'));
    };
    const grant = () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(new Error('Figure preparation ended')); return; }
      activeDownloads += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeDownloads -= 1;
        downloadWaiters.shift()?.();
      });
    };
    if (signal.aborted) { reject(new Error('Figure preparation ended')); return; }
    if (activeDownloads < FIGURE_DOWNLOAD_CONCURRENCY) grant();
    else { downloadWaiters.push(grant); signal.addEventListener('abort', abort, { once: true }); }
  });
}

export async function ensureFiguresCached(
  imageKeys: (string | null | undefined)[],
  expectedOwnerKey?: string | null,
): Promise<FigureCacheResult> {
  const unavailable = (): FigureCacheResult => ({ newlyCached: 0, availableKeys: new Set<string>() });
  const api = cacheApi();
  const owner = readOfflineOwner();
  if (!api || !owner || (expectedOwnerKey && owner.ownerKey !== expectedOwnerKey)) return unavailable();
  const lease: OwnerLease = { ownerKey: owner.ownerKey, generation: owner.generation };
  // Only stable, entitlement-checked figure keys belong in this cache.
  const unique = [...new Set(imageKeys.filter(
    isOfflineImageKey,
  ))];
  if (unique.length === 0) return unavailable();

  const diagnostics: FigureCacheDiagnostics = {
    attempted: 0, deliveryFailed: 0, downloadFailed: 0, storeFailed: 0, succeeded: 0,
  };
  const passAbort = new AbortController();
  const passTimer = setTimeout(() => passAbort.abort(), FIGURE_CACHE_PASS_DEADLINE_MS);
  const unsubscribeOwner = subscribeOfflineOwner(() => {
    if (!isOfflineOwnerCurrent(lease)) passAbort.abort();
  });
  const availableKeys = new Set<string>();
  try {
    let cache: Cache;
    try {
      cache = await untilAborted(api.open(FIGURE_CACHE), passAbort.signal);
    } catch {
      diagnostics.attempted = unique.length;
      diagnostics.storeFailed = unique.length;
      return unavailable();
    }

    // Preserve all already-cached keys even when this pass runs out of time
    // before reaching their position in the download queue.
    try {
      const entries = await untilAborted(cache.keys(), passAbort.signal);
      const present = new Set(entries.map((entry) => {
        const url = new URL(entry.url, typeof location === 'undefined' ? 'https://md3.info' : location.origin);
        return url.pathname + url.search;
      }));
      for (const key of unique) {
        if (present.has(figureCacheKey(key, lease.ownerKey))) availableKeys.add(key);
      }
    } catch {
      if (passAbort.signal.aborted) return unavailable();
      // Cache.match below remains authoritative when enumeration fails.
    }

    const missing = unique.filter((key) => !availableKeys.has(key));
    let nextIndex = 0;
    async function cacheNext(): Promise<void> {
      while (nextIndex < missing.length && !passAbort.signal.aborted && isOfflineOwnerCurrent(lease)) {
        const imageKey = missing[nextIndex++];
        const key = figureCacheKey(imageKey, lease.ownerKey);
        const flightKey = `${lease.generation}:${key}`;
        const inFlight = downloadsInFlight.get(flightKey);
        if (inFlight) {
          try { if (await untilAborted(inFlight, passAbort.signal)) availableKeys.add(imageKey); } catch { /* This pass ended. */ }
          continue;
        }
        let finishFlight!: (available: boolean) => void;
        const flight = new Promise<boolean>(resolve => { finishFlight = resolve; });
        downloadsInFlight.set(flightKey, flight);
        const keyAbort = new AbortController();
        const abortKey = () => keyAbort.abort();
        passAbort.signal.addEventListener('abort', abortKey, { once: true });
        const timer = setTimeout(abortKey, CLIENT_FETCH_DEADLINE_MS);
        let attempted = false;
        let releaseSlot: (() => void) | undefined;
        let stage: 'deliveryFailed' | 'downloadFailed' | 'storeFailed' = 'storeFailed';
        const assertCurrent = () => {
          if (keyAbort.signal.aborted || passAbort.signal.aborted || !isOfflineOwnerCurrent(lease)) {
            throw new Error('Figure cache operation is no longer current');
          }
        };
        try {
          releaseSlot = await downloadSlot(keyAbort.signal);
          await untilAborted((async () => {
            assertCurrent();
            const hit = await cache.match(key);
            assertCurrent();
            if (hit) {
              availableKeys.add(imageKey);
              return;
            }
            attempted = true;
            diagnostics.attempted++;
            const imageUrl = imageKey;

            stage = 'downloadFailed';
            // Keep the same AbortSignal through headers AND body consumption.
            const image = await fetch(imageUrl, { signal: keyAbort.signal });
            assertCurrent();
            if (!image.ok) throw new Error('Figure download failed');
            if (!image.headers.get('content-type')?.startsWith('image/')) throw new Error('Public image returned non-image bytes');
            const bytes = await image.blob();
            assertCurrent();

            stage = 'storeFailed';
            // Cache.put now receives buffered bytes, so a stalled network body
            // can never continue into a late cache write after our deadline.
            await cache.put(key, new Response(bytes, { headers: image.headers }));
            assertCurrent();
            diagnostics.succeeded++;
            availableKeys.add(imageKey);
            announceFiguresChanged();
          })(), keyAbort.signal);
        } catch {
          if (!attempted) diagnostics.attempted++;
          diagnostics[stage]++;
        } finally {
          releaseSlot?.();
          clearTimeout(timer);
          passAbort.signal.removeEventListener('abort', abortKey);
          finishFlight(availableKeys.has(imageKey));
          if (downloadsInFlight.get(flightKey) === flight) downloadsInFlight.delete(flightKey);
        }
      }
    }
    await Promise.all(Array.from({ length: FIGURE_DOWNLOAD_CONCURRENCY }, () => cacheNext()));
    if (!isOfflineOwnerCurrent(lease)) return unavailable();
    return { newlyCached: diagnostics.succeeded, availableKeys };
  } finally {
    clearTimeout(passTimer);
    unsubscribeOwner();
    if (isOfflineOwnerCurrent(lease)) reportFigureCacheDiagnostics(diagnostics);
  }
}

/** Backward-compatible count-only wrapper used by optional cache warmers. */
export async function cacheFigures(
  imageKeys: (string | null | undefined)[],
  expectedOwnerKey?: string | null,
): Promise<number> {
  return (await ensureFiguresCached(imageKeys, expectedOwnerKey)).newlyCached;
}

/** The cached bytes as an object URL, or null when this figure was never stored. */
export async function readCachedFigure(imageKey: string): Promise<string | null> {
  if (!isOfflineImageKey(imageKey)) return null;
  const api = cacheApi();
  if (!api) return null;
  const owner = readOfflineOwner();
  if (!owner) return null;
  const lease: OwnerLease = {
    ownerKey: owner.ownerKey,
    generation: owner.generation,
  };
  try {
    if (!isOfflineOwnerCurrent(lease)) return null;
    const cache = await api.open(FIGURE_CACHE);
    if (!isOfflineOwnerCurrent(lease)) return null;
    const hit = await cache.match(figureCacheKey(imageKey, lease.ownerKey));
    if (!hit) return null;
    if (!isOfflineOwnerCurrent(lease)) return null;
    const blob = await hit.blob();
    if (!isOfflineOwnerCurrent(lease)) return null;
    const objectUrl = URL.createObjectURL(blob);
    if (!isOfflineOwnerCurrent(lease)) {
      URL.revokeObjectURL(objectUrl);
      return null;
    }
    return objectUrl;
  } catch {
    return null;
  }
}

/** Count only entries owned by the requested current account. */
export async function countCachedFigures(expectedOwnerKey?: string): Promise<number> {
  const api = cacheApi();
  if (!api) return 0;
  const owner = readOfflineOwner();
  if (!owner) return 0;
  if (expectedOwnerKey && owner.ownerKey !== expectedOwnerKey) return 0;

  try {
    const cache = await api.open(FIGURE_CACHE);
    const entries = await cache.keys();
    return entries.filter((entry) => {
      const raw = typeof entry === 'string' ? entry : entry.url;
      const url = new URL(raw, typeof location === 'undefined' ? 'https://md3.info' : location.origin);
      return (
        url.pathname === '/__offline-figure'
        && url.searchParams.get('owner') === owner.ownerKey
      );
    }).length;
  } catch {
    return 0;
  }
}

export async function clearFigureCache(): Promise<void> {
  const api = cacheApi();
  if (!api) return;
  try {
    await api.delete(FIGURE_CACHE);
  } catch {
    // A failed clear must not break sign-out.
  }
}
