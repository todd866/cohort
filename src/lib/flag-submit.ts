import { submitWithRetry } from './submit-with-retry';
import { enqueue, markAuthBlocked } from './outbox';
import {
  captureOfflineOwner,
  isOfflineOwnerCurrent,
} from './offline/owner';

export type FlagResult = 'delivered' | 'queued' | 'auth-required' | 'dropped';

export interface FlagPayload {
  type: 'card' | 'question' | 'component' | 'page';
  id: string;
  reason: string;
  message?: string;
  context?: Record<string, unknown>;
}

const FLAG_URL = '/api/content/flag';

function genId(): string {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/**
 * Submit a content flag durably. The ✓ in the UI must only be shown when this
 * resolves 'delivered'. 'queued'/'auth-required' mean the flag is safe in the
 * outbox and will replay; 'dropped' means the request was rejected as invalid
 * or its originating account changed before the write settled.
 */
export async function submitFlag(payload: FlagPayload): Promise<FlagResult> {
  const ownerLease = captureOfflineOwner();
  const key = `${payload.type}:${payload.id}`;
  const clientRequestId = genId();
  const body: Record<string, unknown> = { ...payload, clientRequestId };

  try {
    const res = await submitWithRetry(FLAG_URL, body, { ownerLease });
    if (!isOfflineOwnerCurrent(ownerLease)) return 'dropped';
    if (res.ok) return 'delivered';

    if (res.status === 401 || res.status === 403) {
      try {
        navigator.sendBeacon('/api/log/client-error', JSON.stringify({
          url: FLAG_URL, error: 'flag-auth-failure', status: res.status, ts: Date.now(),
        }));
      } catch { /* non-critical */ }
      enqueue(
        { kind: 'flag', key, clientRequestId, url: FLAG_URL, body, requiresAuth: true },
        ownerLease.ownerKey,
      );
      markAuthBlocked();
      return 'auth-required';
    }

    if (res.status >= 500) {
      enqueue(
        { kind: 'flag', key, clientRequestId, url: FLAG_URL, body },
        ownerLease.ownerKey,
      );
      return 'queued';
    }

    // 4xx (e.g. 400 validation) — not retryable.
    try {
      navigator.sendBeacon('/api/log/client-error', JSON.stringify({
        url: FLAG_URL, error: 'flag-rejected', status: res.status, ts: Date.now(),
      }));
    } catch { /* non-critical */ }
    return 'dropped';
  } catch {
    if (!isOfflineOwnerCurrent(ownerLease)) return 'dropped';
    enqueue(
      { kind: 'flag', key, clientRequestId, url: FLAG_URL, body },
      ownerLease.ownerKey,
    );
    return 'queued';
  }
}
