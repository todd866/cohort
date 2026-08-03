/**
 * Durable continuity for review work completed before the server has caught up.
 *
 * The offline pack is a replaceable scheduler snapshot. This ledger is not:
 * once an item leaves the screen it remains tombstoned here so an older
 * unified-session/offline-pack response cannot put it back. The record is
 * owner-bound for the same shared-device privacy boundary as the pack/outbox.
 */
import { markReviewBootstrapDirty } from '@/lib/review/bootstrap-safety';

export const OFFLINE_REVIEW_PROGRESS_KEY = 'md3:offline-review-progress:v1';
export const OFFLINE_REVIEW_PROGRESS_EVENT = 'md3:offline-review-progress-change';
export const OFFLINE_REVIEW_PROGRESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A "this session" counter should survive a shift, not become a weekly total. */
export const OFFLINE_REVIEW_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TOMBSTONES = 1_200;

export interface OfflineReviewStats {
  scopeKey: string;
  total: number;
  correct: number;
  updatedAt: number;
}

export interface OfflineReviewTombstone {
  key: string;
  consumedAt: number;
}

export interface OfflineReviewProgress {
  schemaVersion: 1;
  userKey: string;
  revision: number;
  updatedAt: number;
  tombstones: OfflineReviewTombstone[];
  stats: OfflineReviewStats | null;
}

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function itemIdentity(item: unknown): string | null {
  const row = item as { type?: unknown; id?: unknown };
  const type = row?.type;
  const id = row?.id;
  if (
    (type !== 'card' && type !== 'question' && type !== 'video')
    || typeof id !== 'string'
    || id.length === 0
  ) {
    return null;
  }
  return `${type}:${id}`;
}

function parseProgress(raw: string | null): OfflineReviewProgress | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OfflineReviewProgress>;
    if (
      parsed.schemaVersion !== 1
      || typeof parsed.userKey !== 'string'
      || parsed.userKey.length === 0
    ) {
      return null;
    }
    const updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0;
    if (Date.now() - updatedAt > OFFLINE_REVIEW_PROGRESS_TTL_MS) return null;

    const seen = new Set<string>();
    const tombstones = Array.isArray(parsed.tombstones)
      ? parsed.tombstones.flatMap((candidate) => {
          if (
            !candidate
            || typeof candidate.key !== 'string'
            || candidate.key.length === 0
            || seen.has(candidate.key)
          ) {
            return [];
          }
          seen.add(candidate.key);
          return [{
            key: candidate.key,
            consumedAt:
              typeof candidate.consumedAt === 'number'
                ? candidate.consumedAt
                : updatedAt,
          }];
        }).slice(-MAX_TOMBSTONES)
      : [];
    const stats = parsed.stats
      && typeof parsed.stats.scopeKey === 'string'
      && typeof parsed.stats.total === 'number'
      && Number.isFinite(parsed.stats.total)
      && typeof parsed.stats.correct === 'number'
      && Number.isFinite(parsed.stats.correct)
      && typeof parsed.stats.updatedAt === 'number'
      && Date.now() - parsed.stats.updatedAt <= OFFLINE_REVIEW_SESSION_TTL_MS
      ? {
          scopeKey: parsed.stats.scopeKey,
          total: Math.max(0, Math.floor(parsed.stats.total)),
          correct: Math.max(
            0,
            Math.min(Math.floor(parsed.stats.correct), Math.floor(parsed.stats.total)),
          ),
          updatedAt: parsed.stats.updatedAt,
        }
      : null;

    return {
      schemaVersion: 1,
      userKey: parsed.userKey,
      revision:
        typeof parsed.revision === 'number'
        && Number.isSafeInteger(parsed.revision)
        && parsed.revision >= 0
          ? parsed.revision
          : 0,
      updatedAt,
      tombstones,
      stats,
    };
  } catch {
    return null;
  }
}

function readRaw(): OfflineReviewProgress | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(OFFLINE_REVIEW_PROGRESS_KEY);
    const parsed = parseProgress(raw);
    if (!parsed && raw) localStorage.removeItem(OFFLINE_REVIEW_PROGRESS_KEY);
    return parsed;
  } catch {
    return null;
  }
}

function writeProgress(progress: OfflineReviewProgress): void {
  if (!hasStorage()) return;
  // The credentialless offline shell intentionally does not mount the global
  // safety observer. Dirty the server-visible proof in the write itself so an
  // offline suppress/continue (which may have no review outbox row) can never
  // leave an old :clean cookie behind.
  if (progress.tombstones.length > 0) {
    markReviewBootstrapDirty(progress.userKey);
  }
  try {
    localStorage.setItem(OFFLINE_REVIEW_PROGRESS_KEY, JSON.stringify(progress));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(OFFLINE_REVIEW_PROGRESS_EVENT));
    }
  } catch {
    // The grade outbox is the irreplaceable write. A continuity ledger must
    // never make grading fail when storage is exhausted/private.
  }
}

function nextRevision(revision: number): number {
  return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : 1;
}

function emptyProgress(userKey: string): OfflineReviewProgress {
  return {
    schemaVersion: 1,
    userKey,
    revision: 0,
    updatedAt: Date.now(),
    tombstones: [],
    stats: null,
  };
}

export function readOfflineReviewProgress(
  userKey: string | null,
): OfflineReviewProgress | null {
  if (!userKey) return null;
  const progress = readRaw();
  return progress?.userKey === userKey ? progress : null;
}

export function clearOfflineReviewProgress(): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(OFFLINE_REVIEW_PROGRESS_KEY);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(OFFLINE_REVIEW_PROGRESS_EVENT));
    }
  } catch {
    // Account teardown must continue even if browser storage is unavailable.
  }
}

/**
 * Tombstone before mutating the pack. A fill that resolves between these two
 * synchronous writes still filters against the ledger at its own commit.
 */
export function recordConsumedOfflineItem(userKey: string, item: unknown): boolean {
  if (!userKey) return false;
  const key = itemIdentity(item);
  if (!key) return false;

  const existing = readOfflineReviewProgress(userKey) ?? emptyProgress(userKey);
  if (existing.tombstones.some((candidate) => candidate.key === key)) return false;
  const now = Date.now();
  writeProgress({
    ...existing,
    revision: nextRevision(existing.revision),
    updatedAt: now,
    tombstones: [
      ...existing.tombstones,
      { key, consumedAt: now },
    ].slice(-MAX_TOMBSTONES),
  });
  return true;
}

/** Undo a local-only consume (currently the suppress → Z/back path). */
export function restoreConsumedOfflineItem(userKey: string, item: unknown): boolean {
  if (!userKey) return false;
  const key = itemIdentity(item);
  if (!key) return false;
  const existing = readOfflineReviewProgress(userKey);
  if (!existing?.tombstones.some((candidate) => candidate.key === key)) return false;
  const now = Date.now();
  writeProgress({
    ...existing,
    revision: nextRevision(existing.revision),
    updatedAt: now,
    tombstones: existing.tombstones.filter((candidate) => candidate.key !== key),
  });
  return true;
}

export function writeOfflineReviewStats(
  userKey: string,
  scopeKey: string,
  stats: { total: number; correct: number },
): void {
  if (!userKey || !scopeKey) return;
  const existing = readOfflineReviewProgress(userKey) ?? emptyProgress(userKey);
  const now = Date.now();
  writeProgress({
    ...existing,
    revision: nextRevision(existing.revision),
    updatedAt: now,
    stats: {
      scopeKey,
      total: Math.max(0, Math.floor(stats.total)),
      correct: Math.max(0, Math.min(Math.floor(stats.correct), Math.floor(stats.total))),
      updatedAt: now,
    },
  });
}

export function readOfflineReviewStats(
  userKey: string,
  scopeKey: string,
): { total: number; correct: number } | null {
  const stats = readOfflineReviewProgress(userKey)?.stats;
  if (!stats || stats.scopeKey !== scopeKey) return null;
  return { total: stats.total, correct: stats.correct };
}

export function clearOfflineReviewStats(userKey: string, scopeKey?: string): boolean {
  const existing = readOfflineReviewProgress(userKey);
  if (!existing?.stats) return false;
  if (scopeKey && existing.stats.scopeKey !== scopeKey) return false;
  const now = Date.now();
  writeProgress({
    ...existing,
    revision: nextRevision(existing.revision),
    updatedAt: now,
    stats: null,
  });
  return true;
}

export function filterOfflineTombstones<T>(userKey: string, items: T[]): T[] {
  const progress = readOfflineReviewProgress(userKey);
  if (!progress || progress.tombstones.length === 0) return items;
  const blocked = new Set(progress.tombstones.map((candidate) => candidate.key));
  return items.filter((item) => {
    const key = itemIdentity(item);
    return key === null || !blocked.has(key);
  });
}

export function offlineTombstoneExclusions(
  userKey: string,
  limitPerType = 100,
): { cards: string[]; questions: string[] } {
  const progress = readOfflineReviewProgress(userKey);
  const cards: string[] = [];
  const questions: string[] = [];
  for (const tombstone of progress?.tombstones ?? []) {
    const separator = tombstone.key.indexOf(':');
    const type = tombstone.key.slice(0, separator);
    const id = tombstone.key.slice(separator + 1);
    if (type === 'card') cards.push(id);
    if (type === 'question') questions.push(id);
  }
  return {
    cards: cards.slice(-limitPerType),
    questions: questions.slice(-limitPerType),
  };
}

/**
 * Retire only the tombstones represented by the authoritative refresh that has
 * just committed. A concurrent grade increments the revision, making this a
 * no-op instead of erasing its new protection.
 */
export function retireOfflineTombstones(
  userKey: string,
  expectedRevision: number,
): boolean {
  const existing = readOfflineReviewProgress(userKey);
  if (
    !existing
    || existing.revision !== expectedRevision
    || existing.tombstones.length === 0
  ) {
    return false;
  }
  const now = Date.now();
  writeProgress({
    ...existing,
    revision: nextRevision(existing.revision),
    updatedAt: now,
    tombstones: [],
  });
  return true;
}
