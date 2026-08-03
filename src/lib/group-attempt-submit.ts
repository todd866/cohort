import { submitWithRetry } from './submit-with-retry';
import { acknowledgeReview, enqueueReview } from './review-queue';
import { genClientRequestId } from './client-request-id';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from './offline/owner';

const GROUP_ATTEMPT_URL = '/api/study/group-attempt';

/**
 * Durably record a question-group attempt. Mirrors the grade path
 * (useMcqReview): write ahead synchronously, then try immediately with retries
 * and acknowledge only an exact successful response. Auth/rate/server failures
 * remain queued; permanent 4xx responses receive a bounded compatibility retry
 * before being reported and dropped. Previously these POSTs were
 * fire-and-forget (`.catch(console.error)`), so offline/failed group attempts
 * were silently lost and carried no ServeDecision attribution.
 */
export function submitGroupAttempt(body: Record<string, unknown>): void {
  const ownerLease = captureOfflineOwner();
  // Mint exactly once per learner action. The same object/key is reused by
  // transport retries and persisted outbox replay.
  const requestBody = {
    ...body,
    clientRequestId: typeof body.clientRequestId === 'string' && body.clientRequestId.length > 0
      ? body.clientRequestId
      : genClientRequestId(),
  };
  const clientRequestId = requestBody.clientRequestId;

  enqueueReview(GROUP_ATTEMPT_URL, requestBody, ownerLease.ownerKey);

  submitWithRetry(GROUP_ATTEMPT_URL, requestBody, { ownerLease })
    .then((res) => {
      if (!isOfflineOwnerCurrent(ownerLease)) return;
      if (res.ok) {
        acknowledgeReview(GROUP_ATTEMPT_URL, clientRequestId, ownerLease.ownerKey);
      }
    })
    .catch(() => {});
}
