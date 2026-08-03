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
 * The store is localStorage (same idiom as the outbox, which already holds the
 * grades queued while offline) rather than IndexedDB. That was measured, not
 * assumed: a card serialises to ~450 bytes against the real corpus, so even a
 * full 500-item pack is a few hundred KB — well inside the quota, and the
 * asynchronous machinery would buy nothing. Figure bytes are the exception and
 * live in the Cache API (src/lib/offline/figures.ts).
 */

import { personalDeckSlugs } from '@/lib/personal-decks';
import {
  filterOfflineTombstones,
  recordConsumedOfflineItem,
  restoreConsumedOfflineItem,
} from './progress';

export const OFFLINE_PACK_KEY = 'md3:offline-pack:v1';

/**
 * Enough that a full day out of signal cannot exhaust it. Measured against the
 * real corpus, a card serialises to ~450 bytes and a question to a few KB, so
 * 500 items is a few hundred KB — comfortably inside the localStorage budget,
 * which is why this does not need IndexedDB.
 */
export const PACK_MAX_ITEMS = 500;

/** localStorage is ~5 MB per origin and the outbox shares it. Stay well clear. */
export const PACK_MAX_BYTES = 3_000_000;

/** A pack older than this is stale enough that the scheduler would have moved on. */
export const PACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * v6 invalidates legacy raw-question and QuestionReinforcement-bearing packs
 * from before the opaque USMLE + derived-card boundary.
 */
export const OFFLINE_PACK_SCHEMA_VERSION = 6;
/** Version of the non-review tab snapshots populated by the bulk pack route. */
export const OFFLINE_VIEW_SCHEMA_VERSION = 3;
/** v2 introduced the deliberately narrow, offline-safe brief projection. */
const OFFLINE_BRIEF_PROJECTION_SCHEMA_VERSION = 2;
const PERSONAL_ROTATIONS = new Set(personalDeckSlugs());

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
  /** Personal decks cached only after an explicit focused review. */
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
  /** Omit to preserve the existing explicit-focus deck list. */
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
    || row.imageKey.startsWith('/figures/')
  );
}

function hasStorage(): boolean {
  return typeof localStorage !== 'undefined';
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
    // UnifiedItem did not historically persist reliable module membership or
    // reinforcement-parent lineage. Purge the whole pre-containment pack when
    // it contains either a raw Question or an answer-bearing derived card; a
    // fresh online fill can recreate safe items through the current server
    // boundary. This includes relationless `qcard:<parentId>:fact:*` siblings.
    if (
      parsedSchemaVersion < OFFLINE_PACK_SCHEMA_VERSION
      && parsed.items.some((item) => {
        const row = item as { type?: unknown; sourceComponent?: unknown };
        return row?.type === 'question'
          || row?.sourceComponent === 'QuestionReinforcement';
      })
    ) {
      localStorage.removeItem(OFFLINE_PACK_KEY);
      return null;
    }
    // v1-v3 treated every active module as a default pack rotation, so an
    // enrolled MND/AnKing deck could reappear on a cold offline launch. v4
    // separates that historical data from the default schedule immediately.
    const rotations = parsedSchemaVersion < 4
      ? storedRotations.filter((rotation) => !PERSONAL_ROTATIONS.has(rotation))
      : storedRotations;
    const focusRotations = Array.isArray(parsed.focusRotations)
      ? parsed.focusRotations.filter((rotation) => PERSONAL_ROTATIONS.has(rotation))
      : [];
    return {
      schemaVersion: Math.max(parsedSchemaVersion, OFFLINE_PACK_SCHEMA_VERSION),
      viewSchemaVersion: parsedViewSchemaVersion,
      bulkFilledAt:
        parsedSchemaVersion < 4
          ? 0
          : typeof parsed.bulkFilledAt === 'number'
            ? parsed.bulkFilledAt
            : 0,
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
    localStorage.removeItem(OFFLINE_PACK_KEY);
  } catch {
    // Nothing useful to do — a failed clear must not break sign-out.
  }
}

/**
 * Persist the pack. Writing under a different user replaces the record wholesale
 * rather than merging, so an account switch cannot leave the previous user's
 * cards behind.
 */
export function savePack(userKey: string, input: SaveInput): void {
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
  const focusRotations =
    input.focusRotations !== undefined
      ? input.focusRotations.filter((rotation) => PERSONAL_ROTATIONS.has(rotation))
      : sameUser
        ? (existing?.focusRotations ?? [])
        : [];

  let items = filterOfflineTombstones(
    userKey,
    input.items.filter(isOfflineCapableStudyItem),
  ).slice(0, PACK_MAX_ITEMS);
  const pack: OfflinePack = {
    schemaVersion: OFFLINE_PACK_SCHEMA_VERSION,
    viewSchemaVersion,
    bulkFilledAt,
    userKey,
    savedAt: Date.now(),
    rotations: input.rotations,
    focusRotations,
    items,
    brief,
    clinical,
    reviewStats,
  };

  // Trim from the tail until it fits. An oversized pack that throws QuotaExceeded
  // would also take the grade outbox down with it, so shed items instead.
  let serialised = JSON.stringify(pack);
  while (serialised.length > PACK_MAX_BYTES && items.length > 1) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    pack.items = items;
    serialised = JSON.stringify(pack);
  }

  try {
    localStorage.setItem(OFFLINE_PACK_KEY, serialised);
  } catch {
    // Quota or private-mode failure. Drop the pack rather than leave a partial one.
    clearPack();
  }
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
 * The review feed hands over ~15 items at a time; the bulk fill puts 500 there.
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

  // A bulk fill owns the default offline schedule. A later explicitly-focused
  // live batch may add useful reserve items (for example MND) without silently
  // turning that opt-in deck into a default cold-launch rotation.
  const scheduledInputRotations = input.rotations.filter(
    (rotation) => !PERSONAL_ROTATIONS.has(rotation),
  );
  const focusedInputRotations = input.rotations.filter(
    (rotation) => PERSONAL_ROTATIONS.has(rotation),
  );
  const rotations = sameUser && (existing?.bulkFilledAt ?? 0) > 0
    ? (existing?.rotations ?? [])
    : sameUser
      ? [...new Set([...(existing?.rotations ?? []), ...scheduledInputRotations])]
      : scheduledInputRotations;
  const focusRotations = sameUser
    ? [...new Set([...(existing?.focusRotations ?? []), ...focusedInputRotations])]
    : focusedInputRotations;
  // A full 500-item bulk reserve would otherwise truncate a newly focused MND
  // batch from the tail. Explicit focus is opt-in, so keep those fresh rows at
  // the front while the default serving scope remains `rotations`.
  const mergedItems = focusedInputRotations.length > 0
    ? [...fresh, ...kept]
    : [...kept, ...fresh];

  savePack(userKey, { ...input, rotations, focusRotations, items: mergedItems });
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
  });
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
  });
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
