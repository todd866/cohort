/**
 * Asking the browser not to throw the offline pack away.
 *
 * Everything the offline mode depends on — the pack and outbox in localStorage,
 * the shell and figure bytes in Cache Storage — is "best effort" by default:
 * under storage pressure the browser may clear it without asking. The failure
 * that produces is precisely the one this feature exists to prevent, opening the
 * app somewhere with no signal to find nothing cached.
 *
 * `navigator.storage.persist()` upgrades the origin to "persistent", which the
 * browser will not evict automatically. It matters more on iOS than elsewhere:
 * every browser there is WebKit, whose quotas are tighter and whose eviction is
 * more aggressive than Chrome's.
 *
 * Whether the request is granted is the browser's call, not ours — Chrome
 * decides silently on engagement heuristics, Firefox may prompt. So this reports
 * the outcome rather than assuming it, and the offline page displays it: on iOS
 * that display is the only way to find out what actually happened on the device.
 */

export type PersistenceState = 'persisted' | 'granted' | 'denied' | 'unsupported';

function storageApi(): StorageManager | null {
  if (typeof navigator === 'undefined') return null;
  const storage = navigator.storage;
  // Safari shipped `persisted` before `persist` at one point; treat a partial
  // implementation as absent rather than calling into a hole.
  if (!storage || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') {
    return null;
  }
  return storage;
}

/** Request persistence unless it is already granted. Safe to call on every load. */
export async function ensurePersistentStorage(): Promise<PersistenceState> {
  const storage = storageApi();
  if (!storage) return 'unsupported';

  try {
    if (await storage.persisted()) return 'persisted';
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** Report the current state without requesting anything — for display only. */
export async function readPersistenceState(): Promise<PersistenceState> {
  const storage = storageApi();
  if (!storage) return 'unsupported';
  try {
    return (await storage.persisted()) ? 'persisted' : 'denied';
  } catch {
    return 'denied';
  }
}
