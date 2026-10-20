/**
 * Device-local bytes for a flag image that has not reached the server yet.
 *
 * The outbox row (localStorage) carries only `imageRef`; the bytes live here,
 * in IndexedDB, keyed by that ref and stamped with the owner partition that
 * queued them. Replay reads a record only for its own owner, so an image queued
 * by one account can never be uploaded under another. Records are deleted once
 * the flag is acknowledged, and swept when the outbox no longer references them
 * (account switch, sign-out, expiry, retention).
 */
import { FLAG_IMAGE_MIME_TYPES, FLAG_IMAGE_PASSTHROUGH_BYTES } from './image-contract';

export interface QueuedFlagImage {
  /** Also the server upload id (a v4 UUID), so a re-upload is idempotent. */
  id: string;
  ownerKey: string;
  blob: Blob;
  type: string;
  size: number;
  createdAt: number;
}

export interface QueuedFlagImageStore {
  put(record: QueuedFlagImage): Promise<void>;
  get(id: string): Promise<QueuedFlagImage | undefined>;
  delete(id: string): Promise<void>;
  list(): Promise<QueuedFlagImage[]>;
}

/** At most this many queued images per device: at most ~30 MB, since a queued image is sent under the 3 MB passthrough. */
export const QUEUED_FLAG_IMAGE_MAX = 10;
/** An image written just before its outbox row is not yet an orphan. */
export const QUEUED_FLAG_IMAGE_ORPHAN_GRACE_MS = 5 * 60 * 1000;

const DB_NAME = 'md3-flag-images';
const STORE = 'images';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    }).catch((error) => { dbPromise = null; throw error; });
  }
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE, mode);
  const result = await request(run(tx.objectStore(STORE)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

const indexedDbStore: QueuedFlagImageStore = {
  put: async (record) => { await withStore('readwrite', (s) => s.put(record)); },
  get: (id) => withStore('readonly', (s) => s.get(id) as IDBRequest<QueuedFlagImage | undefined>),
  delete: async (id) => { await withStore('readwrite', (s) => s.delete(id)); },
  list: () => withStore('readonly', (s) => s.getAll() as IDBRequest<QueuedFlagImage[]>),
};

let store: QueuedFlagImageStore | null = null;
function activeStore(): QueuedFlagImageStore | null {
  if (store) return store;
  return typeof indexedDB === 'undefined' ? null : indexedDbStore;
}

export function setQueuedFlagImageStoreForTest(next: QueuedFlagImageStore | null): void {
  store = next;
}

export function createMemoryQueuedFlagImageStore(): QueuedFlagImageStore & { records: Map<string, QueuedFlagImage> } {
  const records = new Map<string, QueuedFlagImage>();
  return {
    records,
    put: async (r) => { records.set(r.id, r); },
    get: async (id) => records.get(id),
    delete: async (id) => { records.delete(id); },
    list: async () => [...records.values()],
  };
}

export function isAcceptableQueuedFlagImage(blob: Blob): boolean {
  return (FLAG_IMAGE_MIME_TYPES as readonly string[]).includes(blob.type)
    && blob.size > 0 && blob.size <= FLAG_IMAGE_PASSTHROUGH_BYTES;
}

/** Persist the bytes before the outbox row that references them. */
export async function putQueuedFlagImage(id: string, ownerKey: string, blob: Blob): Promise<void> {
  const target = activeStore();
  if (!target) throw new Error('Image storage unavailable');
  if (!isAcceptableQueuedFlagImage(blob)) throw new Error('Image is not an accepted type or size');
  const existing = await target.list();
  if (existing.length >= QUEUED_FLAG_IMAGE_MAX) throw new Error('Too many images are waiting to send');
  await target.put({ id, ownerKey, blob, type: blob.type, size: blob.size, createdAt: Date.now() });
}

/**
 * Read only within the owner partition that queued it. Null means absent;
 * a storage failure throws so replay retries instead of dropping the image.
 */
export async function getQueuedFlagImage(id: string, ownerKey: string): Promise<QueuedFlagImage | null> {
  const target = activeStore();
  if (!target) throw new Error('Image storage unavailable');
  const record = await target.get(id);
  return record && record.ownerKey === ownerKey ? record : null;
}

export async function deleteQueuedFlagImage(id: string): Promise<void> {
  try { await activeStore()?.delete(id); } catch { /* swept later */ }
}

/**
 * Delete every record the outbox no longer references, and every record that
 * belongs to an owner other than `currentOwnerKey`. A same-owner record younger
 * than the grace window is kept: its outbox row may not be written yet.
 */
export async function sweepQueuedFlagImages(
  referenced: ReadonlySet<string>,
  currentOwnerKey: () => string | null,
  now = Date.now(),
): Promise<number> {
  const target = activeStore();
  if (!target) return 0;
  let removed = 0;
  try {
    for (const record of await target.list()) {
      // Re-read the owner per record: an account switch during the sweep must
      // not make the NEW owner's fresh images look foreign.
      const owner = currentOwnerKey();
      const foreign = record.ownerKey !== owner;
      const orphan = !referenced.has(record.id) && now - record.createdAt > QUEUED_FLAG_IMAGE_ORPHAN_GRACE_MS;
      if (foreign || orphan) { await target.delete(record.id); removed += 1; }
    }
  } catch { /* best effort; the owner check on read still holds */ }
  return removed;
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('Image could not be read'));
    reader.readAsDataURL(blob);
  });
}
