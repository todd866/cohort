import { enqueue, flushOutbox, hasQueuedRequest, takeFlagReplayOutcome } from './outbox';
import { captureOfflineOwner, isOfflineOwnerCurrent, type OwnerLease } from './offline/owner';
import { deleteQueuedFlagImage, putQueuedFlagImage } from './flags/queued-image-store';
import { randomUuid } from './random-uuid';

export type FlagResult = 'delivered' | 'queued' | 'auth-required' | 'dropped' | 'image-unavailable';

export interface FlagPayload {
  type: 'card' | 'question' | 'component' | 'page';
  id: string;
  /**
   * Opaque public-delivery capability. When present, `id` is the same opaque
   * value; the canonical question id is resolved only by the server.
   */
  deliveryId?: string;
  reason: string;
  message?: string;
  /** Verified private attachment ID only. Never enqueue image bytes. */
  attachmentId?: string;
  context?: Record<string, unknown>;
}

const FLAG_URL = '/api/content/flag';

export interface FlagSubmitOptions {
  /** Image bytes to send with the flag. Persisted on the device until sent. */
  image?: Blob | null;
}

export interface QueuedFlag {
  clientRequestId: string;
  /** Settles after the first delivery attempt; the flag is already durable. */
  result: Promise<FlagResult>;
}

/**
 * Write a flag ahead to the durable outbox, then send it in the background.
 *
 * Resolves as soon as the flag (and any image, in IndexedDB) is on the device,
 * so the sheet can close at once. The single outbox replay runner sends it,
 * which keeps one sender per clientRequestId: no live request races a replay.
 * Rejects when the flag or its image cannot be stored; nothing is queued then.
 */
export async function queueFlag(payload: FlagPayload, options: FlagSubmitOptions = {}): Promise<QueuedFlag> {
  const ownerLease = captureOfflineOwner();
  const key = `${payload.type}:${payload.id}`;
  const clientRequestId = randomUuid();
  const body: Record<string, unknown> = { ...payload, clientRequestId };
  let imageRef: string | undefined;
  if (options.image) {
    imageRef = randomUuid();
    await putQueuedFlagImage(imageRef, ownerLease.ownerKey, options.image);
  }
  if (!isOfflineOwnerCurrent(ownerLease)) {
    if (imageRef) void deleteQueuedFlagImage(imageRef);
    return { clientRequestId, result: Promise.resolve('dropped') };
  }
  enqueue(
    { kind: 'flag', key, clientRequestId, url: FLAG_URL, body, ...(imageRef ? { imageRef } : {}) },
    ownerLease.ownerKey,
  );
  // enqueue cannot report a storage failure; confirm the row landed before
  // the caller closes the sheet on the strength of it.
  if (!hasQueuedRequest('flag', clientRequestId, ownerLease.ownerKey)) {
    if (imageRef) void deleteQueuedFlagImage(imageRef);
    throw new Error('Flag could not be saved on this device');
  }
  return { clientRequestId, result: deliverQueuedFlag(ownerLease, clientRequestId) };
}

async function deliverQueuedFlag(ownerLease: OwnerLease, clientRequestId: string): Promise<FlagResult> {
  try { await flushOutbox(ownerLease.ownerKey); } catch { /* the row stays queued */ }
  if (!isOfflineOwnerCurrent(ownerLease)) return 'dropped';
  return takeFlagReplayOutcome(clientRequestId) ?? 'queued';
}

/**
 * Submit a content flag durably and wait for the first delivery attempt. The ✓
 * in the UI must only be shown when this resolves 'delivered'. 'queued' and
 * 'auth-required' mean the flag is safe in the outbox and will replay;
 * 'dropped' means the server rejected it as invalid or the account changed.
 */
export async function submitFlag(payload: FlagPayload, options: FlagSubmitOptions = {}): Promise<FlagResult> {
  return (await queueFlag(payload, options)).result;
}
