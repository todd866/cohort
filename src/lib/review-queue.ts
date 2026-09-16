// Back-compat shim. The durable queue now lives in ./outbox and is shared by
// grades (kind: 'review') and flags (kind: 'flag'). Existing callers keep working.
import {
  acknowledgeOutbox,
  enqueue,
  flushOutbox,
  getQueueSize,
  clearExpiredEntries,
} from './outbox';

export function enqueueReview(
  url: string,
  body: Record<string, unknown>,
  ownerKey?: string | null,
  clientRequestId?: string,
): void {
  enqueue({
    kind: 'review',
    url,
    body,
    ...(clientRequestId ? { clientRequestId } : {}),
    boundedPermanentRetry: true,
  }, ownerKey);
}

export function flushReviewQueue(ownerKey?: string | null): Promise<void> {
  return flushOutbox(ownerKey);
}

export function acknowledgeReview(
  url: string,
  clientRequestId: string,
  ownerKey: string,
): void {
  acknowledgeOutbox('review', url, clientRequestId, ownerKey);
}

export { getQueueSize, clearExpiredEntries };
