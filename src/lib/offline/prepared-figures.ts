import { readCachedFigure } from './figures';
import { isOfflineOwnerCurrent, readOfflineOwner, subscribeOfflineOwner, type OwnerLease } from './owner';

export const PREPARED_FIGURES_CHANGE_EVENT = 'prepared-figures:change';
export const PREPARED_FIGURE_LIMIT = 16;
type Entry = { lease: OwnerLease; url: string | null; image: HTMLImageElement | null; ready: boolean; wanted: boolean; readers: number; pending: Promise<void> };
const entries = new Map<string, Entry>();
let sourceLease: OwnerLease | null = null;
let managedSources = new Set<string>();
let subscribed = false;

function discard(key: string, entry: Entry) {
  if (entries.get(key) === entry) entries.delete(key);
  if (entry.url) URL.revokeObjectURL(entry.url);
  entry.url = null;
  entry.image = null;
  entry.ready = false;
}

/** The durable cache remains intact; only decoded in-memory URLs are released. */
export function clearPreparedFigures(): void {
  for (const [key, entry] of entries) discard(key, entry);
  sourceLease = null;
  managedSources.clear();
}

/** Live URLs stay only in memory; durable preparation owns these requests. */
export function registerPreparedFigureSources(urls: readonly string[], ownerKey: string): () => void {
  const owner = readOfflineOwner();
  if (!owner || owner.ownerKey !== ownerKey) return () => {};
  const lease: OwnerLease = { ownerKey, generation: owner.generation };
  sourceLease = lease;
  managedSources = new Set(urls);
  return () => { if (sourceLease === lease) { sourceLease = null; managedSources.clear(); } };
}

export function isManagedFigureSource(url: string): boolean {
  return Boolean(sourceLease && isOfflineOwnerCurrent(sourceLease) && managedSources.has(url));
}

function currentEntry(key: string): Entry | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (!isOfflineOwnerCurrent(entry.lease)) { discard(key, entry); return null; }
  return entry;
}

/** CacheStorage promises can stall; release the entry so later warming can retry. */
function readPreparedBytes(key: string): Promise<string | null> {
  return new Promise(resolve => {
    let finished = false;
    const timer = setTimeout(() => { finished = true; resolve(null); }, 15_000);
    void readCachedFigure(key).then(url => {
      if (finished) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(url);
    }, () => { finished = true; clearTimeout(timer); resolve(null); });
  });
}

/** A synchronous lookup lets a prepared review render without a loading frame. */
export function peekPreparedFigure(key: string | null | undefined): string | null {
  const entry = key ? currentEntry(key) : null;
  return entry?.ready ? entry.url : null;
}

/** Pin a prepared URL while an image renderer uses it, even as lookahead advances. */
export function acquirePreparedFigure(key: string): { url: string; release: () => void } | null {
  const entry = currentEntry(key);
  if (!entry?.ready || !entry.url) return null;
  entry.readers += 1;
  let released = false;
  return { url: entry.url, release: () => {
    if (released) return;
    released = true;
    entry.readers -= 1;
    if (!entry.wanted && entry.readers === 0) discard(key, entry);
  } };
}

async function decode(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      img.decode(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Decode timed out')), 15_000); }),
    ]);
    return img;
  } finally { if (timer) clearTimeout(timer); }
}

/** Decode only a bounded review window, using precisely the bytes already stored. */
export async function prepareCachedFigures(keys: readonly string[], expectedOwnerKey: string): Promise<void> {
  const owner = readOfflineOwner();
  if (!owner || owner.ownerKey !== expectedOwnerKey || typeof Image === 'undefined') return;
  if (!subscribed) {
    subscribed = true;
    subscribeOfflineOwner(() => {
      for (const [key, entry] of entries) if (!isOfflineOwnerCurrent(entry.lease)) discard(key, entry);
    });
  }
  const lease: OwnerLease = { ownerKey: owner.ownerKey, generation: owner.generation };
  const wanted = new Set([...new Set(keys)].slice(0, PREPARED_FIGURE_LIMIT));
  for (const [key, entry] of entries) {
    entry.wanted = wanted.has(key) && isOfflineOwnerCurrent(entry.lease);
    if (!entry.wanted && entry.readers === 0) discard(key, entry);
  }
  const pending: Promise<void>[] = [];
  for (const key of wanted) {
    const existing = currentEntry(key);
    if (existing) { pending.push(existing.pending); continue; }
    const entry: Entry = { lease, url: null, image: null, ready: false, wanted: true, readers: 0, pending: Promise.resolve() };
    entries.set(key, entry);
    entry.pending = (async () => {
      try {
        const url = await readPreparedBytes(key);
        if (!url) { discard(key, entry); return; }
        if (!isOfflineOwnerCurrent(lease) || entries.get(key) !== entry) { URL.revokeObjectURL(url); return; }
        entry.url = url;
        const image = await decode(url);
        if (!isOfflineOwnerCurrent(lease) || entries.get(key) !== entry) { discard(key, entry); return; }
        entry.ready = true;
        entry.image = image;
        window.dispatchEvent(new Event(PREPARED_FIGURES_CHANGE_EVENT));
      } catch { discard(key, entry); }
    })();
    pending.push(entry.pending);
  }
  await Promise.all(pending);
}
