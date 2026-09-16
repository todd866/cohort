/**
 * The offline study pack — the personalised slice md3 is allowed to keep on the
 * device so the app still works with no signal (hospital basements, lifts, the
 * train).
 *
 * WHY THIS IS NOT IN THE SERVICE WORKER
 * -------------------------------------
 * sw.js v1 opportunistically cached navigations and session JSON by URL. That
 * retained one user's personalised feed — and short-lived signed media URLs —
 * across logout and account switches, which is why v2 narrowed the worker to
 * immutable `/_next/static/` assets only. Nothing about wanting offline study
 * changes that reasoning, so personalised content lives HERE instead: one
 * explicit, user-keyed record that the app writes deliberately after an
 * authenticated response, and wipes on sign-out or user change.
 *
 * The store is localStorage, like the outbox that holds queued grades. The
 * reserve is bounded by serialized size as well as item count and shrinks
 * further when the browser reports a lower available quota.
 * Figure bytes are separate and live in the Cache API
 * (src/lib/offline/figures.ts).
 */

import {
  filterOfflineTombstones,
  recordConsumedOfflineItem,
  restoreConsumedOfflineItem,
} from './progress';
import { isOfflineImageKey } from './image-key';

export const OFFLINE_PACK_KEY = 'md3:offline-pack:v1';
export const OFFLINE_PACK_CHANGE_EVENT = 'offline-pack:change';
export type PackChangeReason = 'save' | 'consume' | 'append' | 'clear' | 'rekey' | 'storage';

/**
 * Aim for a long offline session while retaining the actual storage budget.
 * Large explanations and browser quota can reduce the saved count.
 */
export const PACK_MAX_ITEMS = 1_000;

/** Serialized string code units, not UTF-8 bytes. The outbox shares this storage. */
export const PACK_MAX_BYTES = 3_000_000;
/** Extra space for queued answers after a browser quota forces a smaller pack. */
export const PACK_QUOTA_HEADROOM_CODE_UNITS = 128 * 1_024;

/** A pack older than this is stale enough that the scheduler would have moved on. */
export const PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * v10 invalidates packs built before MCQ bridges respected mastery and the
 * 24-hour review cooldown. Otherwise a mastered card from the old bypass
 * could remain in an offline reserve for the full seven-day pack TTL.
 */
export const OFFLINE_PACK_SCHEMA_VERSION = 10;
/** Version of the non-review tab snapshots populated by the bulk pack route. */
export const OFFLINE_VIEW_SCHEMA_VERSION = 3;
/** v2 introduced the deliberately narrow, offline-safe brief projection. */
const OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION = 2;

export interface OfflinePack {
  schemaVersion: number;
  /** Zero means the pack predates Clinical/Stats snapshot hydration. */
  viewSchemaVersion: number;
  /** Last authoritative bulk scheduler fill; feed merges must not move it. */
  bulkFilledAt: number;
  /** The user this pack belongs to. A mismatch is a wipe, never a read. */
  userKey: string;
  savedAt: number;
  /** Scheduled rotations used by the default offline "All" review. */
  rotations: string[];
  /** Rotations cached only after an explicit focused review. */
  focusRotations: string[];
  items: unknown[];
  /** The personal course brief, when the signed-in user owns one. */
  brief: unknown | null;
  /** Owner-gated bedside protocols, serialized only after the server gate. */
  clinical: unknown | null;
  /** Best-effort Anki-style statistics snapshot for the Profile tab. */
  reviewStats: unknown | null;
}

export interface PackStatus {
  present: boolean;
  itemCount: number;
  hasBrief: boolean;
  hasClinical: boolean;
  hasReviewStats: boolean;
  savedAt: number | null;
}

export interface SaveInput {
  rotations: string[];
  /** Set only for a user-selected focus; focused scheduled work is never default. */
  explicitFocus?: boolean;
  /** Omit to preserve the existing explicit-focus rotation list. */
  focusRotations?: string[];
  items: unknown[];
  /** Set only after a complete authenticated offline-pack response. */
  viewSchemaVersion?: number;
  /** Set only by the authoritative bulk fill, not a live feed merge. */
  bulkFilledAt?: number;
  /** Omit to leave a previously cached brief untouched; pass null to clear it. */
  brief?: unknown | null;
  /** Omit to preserve the existing owner-gated Clinical snapshot. */
  clinical?: unknown | null;
  /** Omit to preserve the existing review-statistics snapshot. */
  reviewStats?: unknown | null;
}

/**
 * The local review renderer currently guarantees complete offline media only
 * for cards/MCQs whose figures use the stable `/figures/` delivery contract.
 * Videos, linked groups, and passthrough third-party image URLs require a live
 * request and must not be advertised as part of the durable reserve.
 */
export function isOfflineCapableStudyItem(item: unknown): boolean {
  const row = item as { type?: unknown; imageKey?: unknown; imageUrl?: unknown };
  if (row?.type !== 'card' && row?.type !== 'question') return false;
  if (
    typeof row.imageUrl === 'string'
    && row.imageUrl.length > 0
    && (typeof row.imageKey !== 'string' || row.imageKey.length === 0)
  ) {
    return false;
  }
  return (
    typeof row.imageKey !== 'string'
    || row.imageKey.length === 0
    || isOfflineImageKey(row.imageKey)
  );
}

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

function announcePackChange(reason: PackChangeReason): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(OFFLINE_PACK_CHANGE_EVENT, { detail: reason }));
  }
}

export function subscribePackChanges(callback: (reason: PackChangeReason) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const localChange = (event: Event) => callback((event as CustomEvent<PackChangeReason>).detail);
  const storageChange = (event: StorageEvent) => {
    if (event.key === OFFLINE_PACK_KEY || event.key === null) callback('storage');
  };
  window.addEventListener(OFFLINE_PACK_CHANGE_EVENT, localChange);
  window.addEventListener('storage', storageChange);
  return () => {
    window.removeEventListener(OFFLINE_PACK_CHANGE_EVENT, localChange);
    window.removeEventListener('storage', storageChange);
  };
}

function hasUnclassifiedClinicalMedia(_items: unknown[]): boolean {
  // Consent gating is opt-in via explicit `sensitive: true`. Older packs may
  // lack that flag, which is now treated as ordinary media rather than a
  // reason to wipe the pack.
  return false;
}

function readRaw(): OfflinePack | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(OFFLINE_PACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OfflinePack>;
    if (!parsed || typeof parsed.userKey !== 'string' || !Array.isArray(parsed.items)) return null;
    const parsedSchemaVersion =
      typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1;
    const parsedViewSchemaVersion =
      typeof parsed.viewSchemaVersion === 'number' ? parsed.viewSchemaVersion : 0;
    const storedRotations = Array.isArray(parsed.rotations) ? parsed.rotations : [];
    // Sensitivity is a display-safety boundary, not a best-effort migration.
    // Older card-only packs are unsafe too: their cached `imageMeta` cannot
    // distinguish reviewed-safe photography from media that must be gated.
    if (parsedSchemaVersion < OFFLINE_PACK_SCHEMA_VERSION) {
      localStorage.removeItem(OFFLINE_PACK_KEY);
      return null;
    }
    if (hasUnclassifiedClinicalMedia(parsed.items)) {
      localStorage.removeItem(OFFLINE_PACK_KEY);
      return null;
    }
    const rotations = storedRotations
      .filter((rotation): rotation is string => typeof rotation === 'string')
      .slice(0, 1);
    const focusRotations = Array.isArray(parsed.focusRotations)
      ? parsed.focusRotations.filter(
          (rotation): rotation is string =>
            typeof rotation === 'string' && rotation.length > 0,
        )
      : [];
    return {
      schemaVersion: Math.max(parsedSchemaVersion, OFFLINE_PACK_SCHEMA_VERSION),
      viewSchemaVersion: parsedViewSchemaVersion,
      bulkFilledAt: typeof parsed.bulkFilledAt === 'number' ? parsed.bulkFilledAt : 0,
      userKey: parsed.userKey,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      rotations,
      focusRotations,
      items: parsed.items.filter(isOfflineCapableStudyItem),
      // v1 stored the complete personal dossier. v2 stores only the explicit
      // operational projection, so never expose a legacy dossier while offline.
      brief: parsedViewSchemaVersion >= OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION
        ? parsed.brief ?? null
        : null,
      clinical: parsed.clinical ?? null,
      reviewStats: parsed.reviewStats ?? null,
    };
  } catch {
    return null;
  }
}

/** Owner metadata only; used by the centralized account transition. */
export function storedPackOwnerKey(): string | null {
  return readRaw()?.userKey ?? null;
}

export function clearPack(): void {
  if (!hasStorage()) return;
  try {
    const existed = localStorage.getItem(OFFLINE_PACK_KEY) !== null;
    localStorage.removeItem(OFFLINE_PACK_KEY);
    if (existed) announcePackChange('clear');
  } catch {
    // Nothing useful to do — a failed clear must not break sign-out.
  }
}

/** Give queued answers priority over the same owner's replaceable reserve. */
export function releaseOfflinePackStorageForReview(userKey: string): boolean {
  if (!hasStorage() || !userKey || readRaw()?.userKey !== userKey) return false;
  clearPack();
  try {
    return localStorage.getItem(OFFLINE_PACK_KEY) === null;
  } catch {
    return false;
  }
}

/**
 * Keep the study pack across device-guest → authenticated bind.
 *
 * Clearing here used to wipe the warm reserve exactly when cold-start needed
 * it most: sign-in upgrades the owner, the review remounts, and the user stares
 * at a skeleton while unified-session fights background cache compute.
 */
export function rekeyPackOwner(fromKey: string, toKey: string): boolean {
  if (!hasStorage() || !fromKey || !toKey || fromKey === toKey) return false;
  const pack = readRaw();
  if (!pack || pack.userKey !== fromKey) return false;

  const next: OfflinePack = { ...pack, userKey: toKey };
  try {
    localStorage.setItem(OFFLINE_PACK_KEY, JSON.stringify(next));
    announcePackChange('rekey');
    return true;
  } catch {
    clearPack();
    return false;
  }
}

/**
 * Persist the pack. Writing under a different user replaces the record wholesale
 * rather than merging, so an account switch cannot leave the previous user's
 * cards behind.
 */
export function savePack(
  userKey: string,
  input: SaveInput,
  changeReason: PackChangeReason = 'save',
): void {
  if (!hasStorage() || !userKey) return;

  const existing = readRaw();
  const sameUser = existing?.userKey === userKey;

  const brief =
    input.brief !== undefined ? input.brief : sameUser ? (existing?.brief ?? null) : null;
  const clinical =
    input.clinical !== undefined
      ? input.clinical
      : sameUser
        ? (existing?.clinical ?? null)
        : null;
  const reviewStats =
    input.reviewStats !== undefined
      ? input.reviewStats
      : sameUser
        ? (existing?.reviewStats ?? null)
        : null;
  const viewSchemaVersion =
    input.viewSchemaVersion !== undefined
      ? input.viewSchemaVersion
      : input.brief !== undefined
        ? sameUser
          ? Math.max(
              existing?.viewSchemaVersion ?? 0,
              OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION,
            )
          : OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION
        : sameUser
          ? (existing?.viewSchemaVersion ?? 0)
          : 0;
  const bulkFilledAt =
    input.bulkFilledAt !== undefined
      ? input.bulkFilledAt
      : sameUser
        ? (existing?.bulkFilledAt ?? 0)
        : 0;
  const rotations = input.rotations
    .filter((rotation) => rotation.length > 0)
    .slice(0, 1);
  const focusRotations =
    input.focusRotations !== undefined
      ? input.focusRotations.filter((rotation) => rotation.length > 0)
      : sameUser
        ? (existing?.focusRotations ?? [])
        : [];
  const allowedRotations = new Set([...rotations, ...focusRotations]);

  const seen = new Set<string>();
  const items = filterOfflineTombstones(
    userKey,
    input.items.filter((item) => {
      if (!isOfflineCapableStudyItem(item)) return false;
      const rotation = (item as { rotation?: unknown }).rotation;
      return typeof rotation === 'string' && allowedRotations.has(rotation);
    }),
  ).filter((item) => {
    const identity = itemIdentity(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, PACK_MAX_ITEMS);
  const pack: OfflinePack = {
    schemaVersion: OFFLINE_PACK_SCHEMA_VERSION,
    viewSchemaVersion,
    bulkFilledAt,
    userKey,
    savedAt: Date.now(),
    rotations,
    focusRotations,
    items,
    brief,
    clinical,
    reviewStats,
  };

  const serializePrefix = (count: number) => JSON.stringify({ ...pack, items: items.slice(0, count) });
  let count = items.length;
  let serialised = JSON.stringify(pack);
  if (serialised.length > PACK_MAX_BYTES) {
    // Keep the largest ordered prefix; halving discarded almost half of an
    // otherwise usable reserve when a payload only slightly exceeded the cap.
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (serializePrefix(mid).length <= PACK_MAX_BYTES) low = mid;
      else high = mid - 1;
    }
    count = low;
    serialised = serializePrefix(count);
  }

  // Failed writes must not expose an old account through a cold offline read.
  if (existing && !sameUser) clearPack();
  // An oversized snapshot/item must not erase a usable same-owner reserve.
  if (serialised.length > PACK_MAX_BYTES || (items.length > 0 && count === 0)) return;

  try {
    localStorage.setItem(OFFLINE_PACK_KEY, serialised);
    announcePackChange(changeReason);
    return;
  } catch (error) {
    if (!isStorageQuotaError(error)) return;
  }

  // Browser quota also includes other records. Probe smaller prefixes with at
  // most log2(PACK_MAX_ITEMS) writes, preserving any successful one atomically.
  // Never remove the outbox or the previous same-owner pack to make room.
  let low = 1;
  let high = count - 1;
  let savedCount = 0;
  let savedSerialised = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const candidate = serializePrefix(mid);
      localStorage.setItem(OFFLINE_PACK_KEY, candidate);
      savedCount = mid;
      savedSerialised = candidate;
      low = mid + 1;
    } catch (error) {
      if (!isStorageQuotaError(error)) break;
      high = mid - 1;
    }
  }
  if (savedCount === 0) return;

  // The largest successful browser-quota probe can leave almost no space for
  // the next answer. Leave explicit headroom below that known fitting size;
  // the ordinary 3M budget path above remains unchanged.
  const quotaBudget = savedSerialised.length - PACK_QUOTA_HEADROOM_CODE_UNITS;
  low = 0;
  high = savedCount;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serializePrefix(mid).length <= quotaBudget) low = mid;
    else high = mid - 1;
  }
  if (low === 0) {
    // Under an exceptionally small quota, queued progress takes priority over
    // an unusably small reserve. This removes only replaceable cached content.
    clearPack();
    return;
  }
  try {
    localStorage.setItem(OFFLINE_PACK_KEY, serializePrefix(low));
    announcePackChange(changeReason);
  } catch {
    // Do not leave the full-quota probe behind if storage availability changed.
    clearPack();
  }
}

function isStorageQuotaError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'name' in error
    && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/**
 * Read the pack for `userKey`.
 *
 * `allowUnverified` exists for one specific case: a cold launch with no network,
 * where next-auth cannot reach `/api/auth/session` and so cannot tell us who is
 * signed in. Refusing to read there would defeat the entire feature. The
 * safety property that actually matters — one user never seeing another's
 * content — is held by wiping on sign-out and on any verified user mismatch,
 * not by this read.
 */
export function readPack(
  userKey: string | null,
  opts: { allowUnverified?: boolean } = {},
): OfflinePack | null {
  const pack = readRaw();
  if (!pack) return null;

  if (Date.now() - pack.savedAt > PACK_TTL_MS) {
    clearPack();
    return null;
  }

  if (userKey) {
    if (pack.userKey !== userKey) {
      clearPack();
      return null;
    }
    return {
      ...pack,
      items: filterOfflineTombstones(userKey, pack.items),
    };
  }

  return opts.allowUnverified
    ? {
        ...pack,
        items: filterOfflineTombstones(pack.userKey, pack.items),
      }
    : null;
}

function itemIdentity(item: unknown): string {
  const row = item as { type?: unknown; id?: unknown };
  return `${String(row?.type ?? 'item')}:${String(row?.id ?? '')}`;
}

/**
 * Add a served batch to the pack without discarding the reserve.
 *
 * The review feed hands over ~15 items at a time; the bulk fill puts 1,000 there.
 * A plain `savePack` from the feed would replace the whole reserve with that
 * batch — leaving 15 cards for a day out of signal. Existing items are kept and
 * the new ones appended, deduped, up to the cap.
 */
export function addToPack(userKey: string, input: SaveInput): void {
  if (!hasStorage() || !userKey) return;

  const existing = readRaw();
  const sameUser = existing?.userKey === userKey;
  const kept = sameUser ? (existing?.items ?? []) : [];

  const seen = new Set(kept.map(itemIdentity));
  const fresh = input.items.filter((item) => !seen.has(itemIdentity(item)));

  // A live default batch replaces the one default objective. Explicit focus
  // batches remain separately selectable and can never widen cold-launch All.
  const inputRotations = [...new Set(input.rotations.filter((rotation) => rotation.length > 0))];
  const focusedInputRotations = input.explicitFocus ? inputRotations : [];
  const nextDefaultRotation = input.explicitFocus ? null : (inputRotations[0] ?? null);
  const rotations = input.explicitFocus
    ? (sameUser ? (existing?.rotations ?? []) : [])
    : nextDefaultRotation
      ? [nextDefaultRotation]
      : sameUser
        ? (existing?.rotations ?? [])
        : [];
  const focusRotations = sameUser
    ? [...new Set([...(existing?.focusRotations ?? []), ...focusedInputRotations])]
    : focusedInputRotations;
  // A full bulk reserve would otherwise truncate a newly focused MND
  // batch from the tail. Explicit focus is opt-in, so keep those fresh rows at
  // the front while the default serving scope remains `rotations`.
  const mergedItems = input.explicitFocus || focusedInputRotations.length > 0
    ? [...fresh, ...kept]
    : [...kept, ...fresh];

  const objectiveChanged = !input.explicitFocus
    && sameUser
    && nextDefaultRotation !== null
    && existing?.rotations?.[0] !== nextDefaultRotation;
  savePack(userKey, {
    ...input,
    rotations,
    focusRotations,
    items: mergedItems,
    ...(objectiveChanged ? { bulkFilledAt: 0 } : {}),
  }, 'append');
}

/**
 * Remove an item the learner has advanced past from the durable reserve.
 *
 * This is intentionally owner-bound and synchronous. Mobile browsers can
 * suspend a PWA immediately after a tap; leaving consumption only in React
 * state would make the original card reappear after every cold launch and
 * would keep the reserve permanently above its refill threshold.
 */
export function consumePackItem(
  userKey: string,
  item: unknown,
  opts: { tombstone?: boolean } = {},
): boolean {
  if (!hasStorage() || !userKey) return false;

  // Write the tombstone first. A bulk fill can be in flight while the learner
  // grades; every later pack commit filters this ledger before it writes.
  if (opts.tombstone !== false) recordConsumedOfflineItem(userKey, item);

  const existing = readRaw();
  if (!existing || existing.userKey !== userKey) return false;

  const identity = itemIdentity(item);
  const items = existing.items.filter((candidate) => itemIdentity(candidate) !== identity);
  if (items.length === existing.items.length) return false;

  savePack(userKey, {
    rotations: existing.rotations,
    items,
  }, 'consume');
  return true;
}

/**
 * Put a locally consumed item back after an explicit undo.
 *
 * This is intentionally narrow: scheduler grades are append-only events, but
 * suppress can be undone before leaving the page. Removing its tombstone and
 * restoring the reserve in one synchronous turn keeps a subsequent cold launch
 * consistent with the visible card.
 */
export function restorePackItem(userKey: string, item: unknown): boolean {
  if (!hasStorage() || !userKey || !isOfflineCapableStudyItem(item)) return false;
  const existing = readRaw();
  if (!existing || existing.userKey !== userKey) return false;

  restoreConsumedOfflineItem(userKey, item);
  const identity = itemIdentity(item);
  const withoutDuplicate = existing.items.filter(
    (candidate) => itemIdentity(candidate) !== identity,
  );
  savePack(userKey, {
    rotations: existing.rotations,
    items: [item, ...withoutDuplicate],
  }, 'append');
  return true;
}

/**
 * Cache the personal brief without disturbing the study items.
 *
 * The brief page and the review feed write to the same record from different
 * routes; a plain `savePack` from the brief page would carry `items: []` and
 * silently wipe the offline deck.
 */
export function saveBrief(userKey: string, brief: unknown): void {
  if (!hasStorage() || !userKey) return;
  const existing = readRaw();
  const sameUser = existing?.userKey === userKey;
  // A brief-only write proves the v2 brief projection is current; it says
  // nothing about later Clinical snapshot revisions. Preserve v3 only when the
  // existing pack already earned it through a complete offline-pack response.
  const viewSchemaVersion = sameUser
    ? Math.max(
        existing?.viewSchemaVersion ?? 0,
        OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION,
      )
    : OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION;
  savePack(userKey, {
    rotations: sameUser ? (existing?.rotations ?? []) : [],
    items: sameUser ? (existing?.items ?? []) : [],
    brief,
    viewSchemaVersion,
  });
}

/**
 * The identity a pack is bound to. Prefers the account id; email is the fallback
 * for the rare session shape that carries no id. Both the review feed and the
 * brief page must derive it the same way or a pack saved by one would be wiped
 * by the other.
 */
export function offlineUserKey(
  user: { id?: string | null; email?: string | null } | null | undefined,
): string | null {
  if (!user) return null;
  if (user.id) return user.id;
  if (user.email) return user.email.trim().toLowerCase();
  return null;
}

/** Metadata only — safe to render in UI without proving who is signed in. */
export function packStatus(): PackStatus {
  const pack = readRaw();
  if (!pack) {
    return {
      present: false,
      itemCount: 0,
      hasBrief: false,
      hasClinical: false,
      hasReviewStats: false,
      savedAt: null,
    };
  }
  const visibleItems = filterOfflineTombstones(pack.userKey, pack.items);
  return {
    present: true,
    itemCount: visibleItems.length,
    hasBrief: pack.brief !== null && pack.brief !== undefined,
    hasClinical: pack.clinical !== null && pack.clinical !== undefined,
    hasReviewStats: pack.reviewStats !== null && pack.reviewStats !== undefined,
    savedAt: pack.savedAt,
  };
}
