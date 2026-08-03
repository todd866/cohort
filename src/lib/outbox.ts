import { fetchWithDeadline } from './fetch-with-deadline';
import { isRetriableWriteStatus } from './write-retry-policy';
import {
  currentDeviceGuestOwnerKey,
  currentOfflineOwnerKey,
  DEVICE_GUEST_OWNER_PREFIX,
  ensureOfflineOwner,
  isOfflineOwnerCurrent,
  readOfflineOwner,
  subscribeOfflineOwner,
  type OwnerLease,
} from './offline/owner';
import { markReviewBootstrapDirty } from './review/bootstrap-safety';

export const OUTBOX_STORAGE_KEY = 'md3:review-queue';
export const OUTBOX_QUARANTINE_KEY = 'md3:outbox-quarantine:v1';
/**
 * A 500-item offline pack can produce 1,000 writes when every item is an MCQ
 * (answer plus confidence). Keep another 200 rows for partial refills.
 */
export const REVIEW_OUTBOX_MAX = 1_200;
export const FLAG_OUTBOX_MAX = 50;
const QUARANTINE_MAX = 100;
const CHANGE_EVENT = 'outbox:change';
/** Match the seven-day offline pack lifetime so every saved answer can replay. */
export const REVIEW_OUTBOX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export type OutboxKind = 'review' | 'flag';

const EXPIRY_MS: Record<OutboxKind, number> = {
  review: REVIEW_OUTBOX_EXPIRY_MS,
  flag: 14 * 24 * 60 * 60 * 1000,     // flags are defect reports — survive auth-block/offline until re-login
};

export interface OutboxEntry {
  /** Stable device-local identity used to merge a replay with newer queue writes. */
  outboxId: string;
  /** Device-local owner partition. Never used as server authentication. */
  ownerKey: string;
  kind: OutboxKind;
  url: string;
  body: Record<string, unknown>;
  timestamp: number;
  key?: string;            // e.g. "card:<id>" — for per-flag pending lookup
  clientRequestId?: string;
  requiresAuth?: boolean;  // last attempt returned 401
  boundedPermanentRetry?: boolean;
  permanentFailureCount?: number;
  permanentRetryUntil?: number;
  nextAttemptAt?: number;
}

type StoredOutboxEntry = Omit<OutboxEntry, 'ownerKey' | 'outboxId'> & {
  ownerKey?: string;
  outboxId?: string;
};
type EnqueueInput = Omit<OutboxEntry, 'ownerKey' | 'outboxId' | 'timestamp'>;

interface QuarantinedOutboxEntry {
  quarantinedAt: number;
  entry: StoredOutboxEntry;
}

// Module-level: reset on page reload (re-login reloads the app → unblocks).
let authBlocked = false;
// A clear during a slow replay must win; otherwise its catch/final write can
// resurrect the account that was just signed out.
let clearGeneration = 0;
/**
 * One replay runner per browser realm.
 *
 * A second flush request is not redundant: the first request may have started
 * while the radio was still offline and the second may be the browser's
 * confirmed `online` event. Dropping that second request behind a boolean lock
 * can strand the queue until another visibility change or reload. Keep one
 * pending pass per owner instead, and drain it after the active pass settles.
 */
let activeFlush: Promise<void> | null = null;
const pendingFlushOwners = new Set<string>();
export function markAuthBlocked(): void { authBlocked = true; }
export function resetAuthBlockedForTest(): void { authBlocked = false; }

function normalizedOwnerKey(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizedClientRequestId(entry: StoredOutboxEntry | EnqueueInput): string | null {
  if (typeof entry.clientRequestId === 'string' && entry.clientRequestId.trim()) {
    return entry.clientRequestId.trim();
  }
  const bodyRequestId = entry.body.clientRequestId;
  return typeof bodyRequestId === 'string' && bodyRequestId.trim()
    ? bodyRequestId.trim()
    : null;
}

function randomOutboxId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Identity is persisted for new rows. The deterministic fallback keeps legacy
 * rows mergeable without first rewriting the queue (which would itself race
 * another browser tab).
 */
function entryIdentity(entry: StoredOutboxEntry): string {
  if (typeof entry.outboxId === 'string' && entry.outboxId.trim()) {
    return `outbox:${entry.outboxId.trim()}`;
  }
  const requestId = normalizedClientRequestId(entry);
  if (requestId) {
    return [
      'request',
      normalizedOwnerKey(entry.ownerKey) ?? 'legacy',
      entry.kind,
      entry.url,
      requestId,
    ].join(':');
  }
  return [
    'legacy',
    normalizedOwnerKey(entry.ownerKey) ?? 'unowned',
    entry.kind,
    entry.url,
    entry.timestamp,
    entry.key ?? '',
    JSON.stringify(entry.body),
  ].join(':');
}

function readQueue(): StoredOutboxEntry[] {
  try {
    const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
    const parsed: Partial<StoredOutboxEntry>[] = raw ? JSON.parse(raw) : [];
    // Legacy entries (pre-outbox) lack `kind` → treat as reviews.
    // Unknown/corrupted kind values are also coerced to 'review' so applyRetention never crashes.
    return parsed.map((e) => ({
      ...e,
      kind: e.kind === 'flag' ? 'flag' : 'review',
      ownerKey: normalizedOwnerKey(e.ownerKey) ?? undefined,
    })) as StoredOutboxEntry[];
  } catch {
    return [];
  }
}

function announceChange(): void {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // no window (SSR/tests without jsdom) — non-critical
  }
}

function writeQueue(entries: StoredOutboxEntry[]): void {
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full/unavailable — non-critical
  }
  announceChange();
}

/** Cap retention PER KIND so reviews and flags never evict each other. */
function applyRetention(entries: StoredOutboxEntry[]): StoredOutboxEntry[] {
  const byKind: Record<OutboxKind, StoredOutboxEntry[]> = { review: [], flag: [] };
  for (const e of entries) byKind[e.kind].push(e);
  return [
    ...byKind.review.slice(-REVIEW_OUTBOX_MAX),
    ...byKind.flag.slice(-FLAG_OUTBOX_MAX),
  ];
}

/**
 * Queue under a captured owner when supplied; otherwise use the current device
 * owner, creating a device-guest partition if this is signed-out use.
 */
export function enqueue(entry: EnqueueInput, ownerKey?: string | null): void {
  const resolvedOwner = normalizedOwnerKey(ownerKey) ?? ensureOfflineOwner().ownerKey;
  const entries = readQueue();
  const clientRequestId = normalizedClientRequestId(entry) ?? undefined;

  // A local-first write is deliberately queued before its live request. If
  // that request later fails, the ordinary fallback enqueue reaches here too.
  // The server idempotency key is also the durable local identity, so retain
  // one replay row instead of spending capacity on equivalent duplicates.
  if (
    clientRequestId
    && entries.some((candidate) =>
      candidate.ownerKey === resolvedOwner
      && candidate.kind === entry.kind
      && candidate.url === entry.url
      && normalizedClientRequestId(candidate) === clientRequestId
    )
  ) {
    return;
  }

  entries.push({
    ...entry,
    outboxId: randomOutboxId(),
    clientRequestId,
    ownerKey: resolvedOwner,
    timestamp: Date.now(),
  });
  if (entry.kind === 'review') markReviewBootstrapDirty(resolvedOwner);
  writeQueue(applyRetention(entries));
}

/**
 * Remove one write after the matching live request is acknowledged.
 *
 * Every discriminator is explicit so an acknowledgement from one account,
 * endpoint, or write kind cannot consume another queued action.
 */
export function acknowledgeOutbox(
  kind: OutboxKind,
  url: string,
  clientRequestId: string,
  ownerKey: string,
): void {
  const resolvedOwner = normalizedOwnerKey(ownerKey);
  const resolvedRequestId = normalizedOwnerKey(clientRequestId);
  if (!resolvedOwner || !resolvedRequestId) return;

  const entries = readQueue();
  const remaining = entries.filter((entry) =>
    !(
      entry.ownerKey === resolvedOwner
      && entry.kind === kind
      && entry.url === url
      && normalizedClientRequestId(entry) === resolvedRequestId
    )
  );
  if (remaining.length !== entries.length) writeQueue(remaining);
}

export function getQueueSize(
  kind?: OutboxKind,
  ownerKey: string | null = currentOfflineOwnerKey(),
): number {
  const resolvedOwner = normalizedOwnerKey(ownerKey);
  if (!resolvedOwner) return 0;
  const entries = readQueue().filter((entry) => entry.ownerKey === resolvedOwner);
  return kind ? entries.filter((e) => e.kind === kind).length : entries.length;
}

/** Reactive UI source: status of the flag for a given key. */
export function getPendingForKey(
  key: string,
  ownerKey: string | null = currentOfflineOwnerKey(),
): 'pending' | 'blocked' | null {
  const resolvedOwner = normalizedOwnerKey(ownerKey);
  if (!resolvedOwner) return null;
  const entries = readQueue().filter(
    (e) => e.ownerKey === resolvedOwner && e.kind === 'flag' && e.key === key,
  );
  if (entries.length === 0) return null;
  return entries.some((e) => e.requiresAuth) ? 'blocked' : 'pending';
}

export function subscribeOutbox(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(CHANGE_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function clearExpiredEntries(): void {
  const now = Date.now();
  writeQueue(readQueue().filter((e) => now - e.timestamp < EXPIRY_MS[e.kind]));
}

/**
 * Remove all queued personal writes, or only one owner's partition.
 *
 * The all-owner form also removes legacy quarantine and is used by account
 * switch/sign-out. Incrementing clearGeneration prevents an in-flight flush
 * from restoring its stale snapshot after this returns.
 */
export function clearOutbox(ownerKey?: string): void {
  clearGeneration += 1;
  authBlocked = false;
  const resolvedOwner = normalizedOwnerKey(ownerKey);
  if (resolvedOwner) {
    pendingFlushOwners.delete(resolvedOwner);
  } else {
    pendingFlushOwners.clear();
  }
  try {
    if (resolvedOwner) {
      writeQueue(readQueue().filter((entry) => entry.ownerKey !== resolvedOwner));
      return;
    }
    localStorage.removeItem(OUTBOX_STORAGE_KEY);
    localStorage.removeItem(OUTBOX_QUARANTINE_KEY);
  } catch {
    // A failed clear must not break account transition/sign-out.
  }
  announceChange();
}

/**
 * Claim the current signed-out device guest's pending reviews for the account
 * that has just been proved by the live session.
 *
 * This is the sole owner-transition exception: verified A -> verified B still
 * clears everything. The source must be an unverified device-guest partition,
 * the target must already be the current verified owner, and only review rows
 * move. Foreign partitions, legacy rows, and guest flags are removed so a
 * shared device cannot leak an earlier account's local actions.
 *
 * Stable clientRequestId/outboxId values are deliberately preserved. If the
 * pre-sign-in request committed but its acknowledgement was lost, replay under
 * the account meets the SyncOperation receipt moved by the server-side guest
 * claim and remains exactly once.
 */
export function claimDeviceGuestReviewOutbox(
  deviceGuestOwnerKey: string,
  verifiedOwnerKey: string,
): number {
  const sourceOwner = normalizedOwnerKey(deviceGuestOwnerKey);
  const targetOwner = normalizedOwnerKey(verifiedOwnerKey);
  const currentOwner = readOfflineOwner();
  if (
    !sourceOwner
    || !sourceOwner.startsWith(DEVICE_GUEST_OWNER_PREFIX)
    || !targetOwner
    || targetOwner.startsWith(DEVICE_GUEST_OWNER_PREFIX)
    || !currentOwner?.verified
    || currentOwner.ownerKey !== targetOwner
  ) {
    return 0;
  }

  const entries = readQueue();
  const guestReviews = entries.filter(
    (entry) => entry.ownerKey === sourceOwner && entry.kind === 'review',
  );
  const candidates: StoredOutboxEntry[] = [
    // A same-account row can exist after a crash between binding and cleanup.
    // Keep it, but unblock authentication now that the session is verified.
    ...entries
      .filter((entry) => entry.ownerKey === targetOwner)
      .map((entry) => ({ ...entry, requiresAuth: undefined })),
    ...guestReviews.map((entry) => ({
      ...entry,
      ownerKey: targetOwner,
      requiresAuth: undefined,
    })),
  ];

  // Avoid a duplicate local replay when a crash left both sides of the
  // transition behind. Server idempotency is still the final authority.
  const replayIdentity = (entry: StoredOutboxEntry): string => {
    const requestId = normalizedClientRequestId(entry);
    return requestId
      ? [entry.kind, entry.url, requestId].join(':')
      : entryIdentity(entry);
  };
  const guestReviewIdentities = new Set(guestReviews.map(replayIdentity));
  const seen = new Set<string>();
  const claimed: StoredOutboxEntry[] = [];
  for (const entry of candidates) {
    const identity = replayIdentity(entry);
    if (seen.has(identity)) continue;
    seen.add(identity);
    claimed.push(entry);
  }

  // Invalidate an in-flight guest flush before rewriting its partition. Its
  // network request may already have committed, which is why request ids above
  // remain unchanged for the authenticated replay.
  clearGeneration += 1;
  authBlocked = false;
  pendingFlushOwners.delete(sourceOwner);
  try {
    localStorage.removeItem(OUTBOX_QUARANTINE_KEY);
  } catch {
    // Active replay still fails closed to the current target-only queue.
  }
  writeQueue(applyRetention(claimed));
  return guestReviewIdentities.size;
}

/**
 * Move pre-owner queue rows out of the active replay store. There is no safe
 * way to infer their account from the current session, pack, or request id.
 */
export function quarantineLegacyOutbox(): number {
  const entries = readQueue();
  const legacy = entries.filter((entry) => !normalizedOwnerKey(entry.ownerKey));
  if (legacy.length === 0) return 0;

  const quarantinedAt = Date.now();
  try {
    const raw = localStorage.getItem(OUTBOX_QUARANTINE_KEY);
    const existing: QuarantinedOutboxEntry[] = raw ? JSON.parse(raw) : [];
    const next = [
      ...existing,
      ...legacy.map((entry) => ({ quarantinedAt, entry })),
    ].slice(-QUARANTINE_MAX);
    localStorage.setItem(OUTBOX_QUARANTINE_KEY, JSON.stringify(next));
  } catch {
    // Still remove these rows from active replay below. Failing closed matters
    // more than retaining an unattributable write.
  }

  writeQueue(entries.filter((entry) => normalizedOwnerKey(entry.ownerKey)));
  return legacy.length;
}

export function getQuarantinedOutboxSize(): number {
  try {
    const raw = localStorage.getItem(OUTBOX_QUARANTINE_KEY);
    const entries: unknown[] = raw ? JSON.parse(raw) : [];
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Cap on a single queued-write replay. Without it a request that never settles
 * (sleeping mobile radio, captive portal) wedges flushOutbox forever — and the
 * review feed is gated behind the flush (`useReviewSession` mount effect), so a
 * wedged flush means a permanently stuck "Preparing review…" skeleton.
 */
const FLUSH_REQUEST_TIMEOUT_MS = 8_000;

// Review writes are user-authored learning records. A permanent-looking 4xx
// can still be a short client/server compatibility window during a deploy, so
// new review entries get a small poison-safe retry budget before being dropped.
const PERMANENT_RETRY_WINDOW_MS = 15 * 60 * 1000;
const PERMANENT_RETRY_BASE_DELAY_MS = 60 * 1000;
const MAX_PERMANENT_RETRY_FAILURES = 3;

function reportDroppedWrite(entry: StoredOutboxEntry, status: number): void {
  try {
    navigator.sendBeacon('/api/log/client-error', JSON.stringify({
      url: entry.url,
      error: 'outbox-write-dropped',
      status,
      kind: entry.kind,
      ts: Date.now(),
    }));
  } catch { /* non-critical */ }
}

type FlushOutcome =
  | { action: 'remove' }
  | { action: 'retain'; entry: StoredOutboxEntry };

/**
 * Apply replay outcomes to the queue as it exists *now*, not to the snapshot
 * read before network I/O. This preserves rows enqueued while a slow flush was
 * running and never resurrects rows cleared by this or another browser tab.
 */
function commitFlushOutcomes(
  snapshot: StoredOutboxEntry[],
  outcomes: Map<string, FlushOutcome>,
): void {
  if (outcomes.size === 0) return;
  const snapshotIds = new Set(snapshot.map(entryIdentity));
  const latest = readQueue();
  const merged: StoredOutboxEntry[] = [];

  for (const current of latest) {
    const id = entryIdentity(current);
    if (!snapshotIds.has(id)) {
      merged.push(current);
      continue;
    }

    const outcome = outcomes.get(id);
    if (!outcome) {
      // This snapshot row was not attempted (for example after a clear).
      merged.push(current);
    } else if (outcome.action === 'retain') {
      merged.push(outcome.entry);
    }
    // Successful/permanently failed rows are deliberately removed.
  }

  writeQueue(applyRetention(merged));
}

/** Replay one owner partition after the public boundary has resolved it. */
async function flushOwnerOnce(ownerKey: string): Promise<void> {
  const currentOwner = readOfflineOwner();
  if (!currentOwner || currentOwner.ownerKey !== ownerKey) return;
  const ownerLease: OwnerLease = {
    ownerKey: currentOwner.ownerKey,
    generation: currentOwner.generation,
  };
  const ownerAbort = new AbortController();
  const unsubscribeOwner = subscribeOfflineOwner(() => {
    if (!isOfflineOwnerCurrent(ownerLease)) ownerAbort.abort();
  });
  try {
    clearExpiredEntries();
    const entries = readQueue();
    const ownedEntries = entries.filter((entry) => entry.ownerKey === ownerKey);
    if (ownedEntries.length === 0) return;
    const generationAtStart = clearGeneration;

    // Beacon that we are recovering queued work (a prior session failed to save).
    try {
      const oldest = Date.now() - Math.min(...ownedEntries.map((e) => e.timestamp));
      navigator.sendBeacon('/api/log/client-error', JSON.stringify({
        url: 'outbox-flush',
        error: 'replaying-queued-writes',
        status: ownedEntries.length,
        flags: ownedEntries.filter((e) => e.kind === 'flag').length,
        elapsed: Math.round(oldest / 1000),
        ts: Date.now(),
      }));
    } catch { /* non-critical */ }

    // Other accounts and unowned legacy entries stay byte-for-byte inactive.
    const outcomes = new Map<string, FlushOutcome>();
    for (const entry of ownedEntries) {
      if (
        generationAtStart !== clearGeneration
        || !isOfflineOwnerCurrent(ownerLease)
      ) {
        break;
      }
      // Auth-blocked: keep auth entries queued, do not hammer the endpoint.
      if (authBlocked && entry.requiresAuth) {
        outcomes.set(entryIdentity(entry), { action: 'retain', entry });
        continue;
      }
      // Give a rolling deployment time to converge without hammering it with
      // an unchanged payload from an old client bundle.
      if (entry.nextAttemptAt && entry.nextAttemptAt > Date.now()) {
        outcomes.set(entryIdentity(entry), { action: 'retain', entry });
        continue;
      }
      try {
        const res = await fetchWithDeadline(entry.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entry.body),
          signal: ownerAbort.signal,
        }, FLUSH_REQUEST_TIMEOUT_MS);
        if (
          generationAtStart !== clearGeneration
          || !isOfflineOwnerCurrent(ownerLease)
        ) {
          break;
        }
        if (res.status === 401 || res.status === 403) {
          authBlocked = true;
          outcomes.set(entryIdentity(entry), {
            action: 'retain',
            entry: { ...entry, requiresAuth: true },
          });
        } else if (!res.ok && isRetriableWriteStatus(res.status)) {
          outcomes.set(entryIdentity(entry), { action: 'retain', entry });
        } else if (!res.ok) {
          const now = Date.now();
          const permanentFailureCount = (entry.permanentFailureCount ?? 0) + 1;
          const permanentRetryUntil = entry.permanentRetryUntil
            ?? now + PERMANENT_RETRY_WINDOW_MS;
          if (
            entry.boundedPermanentRetry
            && permanentFailureCount < MAX_PERMANENT_RETRY_FAILURES
            && now < permanentRetryUntil
          ) {
            outcomes.set(entryIdentity(entry), {
              action: 'retain',
              entry: {
                ...entry,
                permanentFailureCount,
                permanentRetryUntil,
                nextAttemptAt: now
                  + PERMANENT_RETRY_BASE_DELAY_MS * (2 ** (permanentFailureCount - 1)),
              },
            });
          } else {
            // The compatibility budget is exhausted (or this is a legacy/
            // non-review entry). Drop and report without the request body so
            // one poison entry cannot block the outbox forever.
            reportDroppedWrite(entry, res.status);
            outcomes.set(entryIdentity(entry), { action: 'remove' });
          }
        } else {
          outcomes.set(entryIdentity(entry), { action: 'remove' });
        }
      } catch {
        if (
          generationAtStart !== clearGeneration
          || !isOfflineOwnerCurrent(ownerLease)
        ) {
          break;
        }
        outcomes.set(entryIdentity(entry), { action: 'retain', entry });
      }
    }
    if (
      generationAtStart === clearGeneration
      && isOfflineOwnerCurrent(ownerLease)
    ) {
      commitFlushOutcomes(entries, outcomes);
    }
  } finally {
    unsubscribeOwner();
  }
}

/**
 * Replay only the explicitly verified owner. With no argument, replay is
 * allowed solely for the stored device-guest owner; a stale verified account is
 * never inferred after sign-out.
 *
 * Calls that arrive while another replay is active request a coalesced follow-up
 * pass. This matters for the transition from an offline request to the browser's
 * confirmed online event.
 */
export async function flushOutbox(currentOwnerKey?: string | null): Promise<void> {
  const ownerKey =
    currentOwnerKey === undefined
      ? currentDeviceGuestOwnerKey()
      : normalizedOwnerKey(currentOwnerKey);
  if (!ownerKey) return;

  const currentOwner = readOfflineOwner();
  if (!currentOwner || currentOwner.ownerKey !== ownerKey) return;

  pendingFlushOwners.add(ownerKey);
  if (!activeFlush) {
    // Assign the shared promise before invoking the async runner, while still
    // starting the first transport synchronously as existing callers expect.
    // Calls arriving during a slow request add one coalesced follow-up pass.
    let resolveRun!: () => void;
    let rejectRun!: (reason: unknown) => void;
    const trackedRun = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    activeFlush = trackedRun;

    const run = async () => {
      while (pendingFlushOwners.size > 0) {
        const nextOwner = pendingFlushOwners.values().next().value as string;
        pendingFlushOwners.delete(nextOwner);
        await flushOwnerOnce(nextOwner);
      }
    };
    void run().then(
      () => {
        if (activeFlush === trackedRun) activeFlush = null;
        resolveRun();
      },
      (error: unknown) => {
        if (activeFlush === trackedRun) activeFlush = null;
        rejectRun(error);
      },
    );
  }

  await activeFlush;
}
