/**
 * The device-local identity boundary for offline data.
 *
 * This key is not authentication and is never trusted by the server. It exists
 * so browser storage can fail closed when a shared device changes accounts.
 * Authenticated sessions bind their immutable user id; signed-out use gets a
 * random device-guest key so queued writes are still partitioned.
 */

export const OFFLINE_OWNER_STORAGE_KEY = 'md3:offline-owner:v1';
export const OFFLINE_OWNER_CHANGE_EVENT = 'offline-owner:change';
export const DEVICE_GUEST_OWNER_PREFIX = 'device-guest:';

interface StoredOwnerState {
  schemaVersion: 1;
  ownerKey: string | null;
  verified: boolean;
  generation: number;
}

export interface OfflineOwner {
  ownerKey: string;
  verified: boolean;
  generation: number;
}

export interface OwnerLease {
  ownerKey: string;
  generation: number;
}

const EMPTY_STATE: StoredOwnerState = {
  schemaVersion: 1,
  ownerKey: null,
  verified: false,
  generation: 0,
};

let memoryState: StoredOwnerState = EMPTY_STATE;
let preferMemoryState = false;

function validOwnerKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseState(raw: string | null): StoredOwnerState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredOwnerState>;
    const generation =
      typeof parsed.generation === 'number' &&
      Number.isSafeInteger(parsed.generation) &&
      parsed.generation >= 0
        ? parsed.generation
        : 0;
    return {
      schemaVersion: 1,
      ownerKey: validOwnerKey(parsed.ownerKey) ? parsed.ownerKey : null,
      verified: validOwnerKey(parsed.ownerKey) && parsed.verified === true,
      generation,
    };
  } catch {
    return EMPTY_STATE;
  }
}

function readState(): StoredOwnerState {
  if (preferMemoryState || typeof localStorage === 'undefined') return memoryState;
  try {
    memoryState = parseState(localStorage.getItem(OFFLINE_OWNER_STORAGE_KEY));
    return memoryState;
  } catch {
    // Storage-denied/private contexts still need a stable lease so live
    // submissions are not rejected by the account-safety check.
    preferMemoryState = true;
    return memoryState;
  }
}

function announceOwnerChange(): void {
  try {
    window.dispatchEvent(new CustomEvent(OFFLINE_OWNER_CHANGE_EVENT));
  } catch {
    // SSR/private mode: storage ownership is best-effort on this surface.
  }
}

function writeState(state: StoredOwnerState): void {
  memoryState = state;
  if (typeof localStorage === 'undefined') {
    preferMemoryState = true;
    announceOwnerChange();
    return;
  }
  try {
    localStorage.setItem(OFFLINE_OWNER_STORAGE_KEY, JSON.stringify(state));
    preferMemoryState = false;
  } catch {
    // Keep the just-written owner in memory. Offline durability is unavailable,
    // but live writes can still pass the lease check in this page lifetime.
    preferMemoryState = true;
  }
  announceOwnerChange();
}

function nextGeneration(current: StoredOwnerState): number {
  return current.generation < Number.MAX_SAFE_INTEGER
    ? current.generation + 1
    : 1;
}

function randomGuestOwnerKey(): string {
  try {
    return `${DEVICE_GUEST_OWNER_PREFIX}${crypto.randomUUID()}`;
  } catch {
    return `${DEVICE_GUEST_OWNER_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function readOfflineOwner(): OfflineOwner | null {
  const state = readState();
  if (!state.ownerKey) return null;
  return {
    ownerKey: state.ownerKey,
    verified: state.verified,
    generation: state.generation,
  };
}

export function currentOfflineOwnerKey(): string | null {
  return readOfflineOwner()?.ownerKey ?? null;
}

/** Resolve an implicit flush only for the signed-out device-guest partition. */
export function currentDeviceGuestOwnerKey(): string | null {
  const owner = readOfflineOwner();
  return owner && !owner.verified ? owner.ownerKey : null;
}

export function ensureOfflineOwner(): OfflineOwner {
  const existing = readOfflineOwner();
  if (existing) return existing;

  const current = readState();
  const guestOwnerKey = randomGuestOwnerKey();
  const created: StoredOwnerState = {
    schemaVersion: 1,
    ownerKey: guestOwnerKey,
    verified: false,
    generation: nextGeneration(current),
  };
  writeState(created);
  return {
    ownerKey: guestOwnerKey,
    verified: false,
    generation: created.generation,
  };
}

export function captureOfflineOwner(): OwnerLease {
  const owner = ensureOfflineOwner();
  return { ownerKey: owner.ownerKey, generation: owner.generation };
}

/**
 * Bind an owner proved by the current authenticated session.
 *
 * This is deliberately synchronous: a stale async response must observe the
 * new generation before account cleanup starts.
 */
export function bindVerifiedOfflineOwner(ownerKey: string): OwnerLease {
  const normalized = ownerKey.trim();
  if (!normalized) throw new Error('A non-empty offline owner key is required');

  const current = readState();
  if (current.ownerKey === normalized && current.verified) {
    return { ownerKey: normalized, generation: current.generation };
  }

  const next: StoredOwnerState = {
    schemaVersion: 1,
    ownerKey: normalized,
    verified: true,
    generation: nextGeneration(current),
  };
  writeState(next);
  return { ownerKey: normalized, generation: next.generation };
}

/**
 * Keep a tombstone generation instead of deleting the record. Rebinding the
 * same account later must not make a lease captured before sign-out current.
 */
export function clearOfflineOwner(): void {
  const current = readState();
  writeState({
    schemaVersion: 1,
    ownerKey: null,
    verified: false,
    generation: nextGeneration(current),
  });
}

export function isOfflineOwnerCurrent(lease: OwnerLease): boolean {
  const current = readOfflineOwner();
  return Boolean(
    current &&
    current.ownerKey === lease.ownerKey &&
    current.generation === lease.generation,
  );
}

/**
 * React/browser consumers use this to invalidate already-materialized personal
 * state. The custom event covers this tab; `storage` covers account changes in
 * another tab (including `localStorage.clear()`, whose key is null).
 */
export function subscribeOfflineOwner(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.key === OFFLINE_OWNER_STORAGE_KEY || event.key === null) {
      // A real cross-tab storage mutation supersedes any earlier local fallback.
      memoryState = event.key === null ? EMPTY_STATE : parseState(event.newValue);
      preferMemoryState = false;
      onChange();
    }
  };
  window.addEventListener(OFFLINE_OWNER_CHANGE_EVENT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(OFFLINE_OWNER_CHANGE_EVENT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
