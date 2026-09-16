import { fetchWithDeadline } from './fetch-with-deadline';
import {
  OFFLINE_OWNER_CHANGE_EVENT,
  isOfflineOwnerCurrent,
  type OwnerLease,
} from './offline/owner';

const MAX_ATTEMPTS = 3;
/** Cap on a single attempt. Without it an unsettling request wedges the caller
 *  forever — the same hang that stranded the mobile review feed (outbox, 2026-07-09). */
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_MS = [1000, 2000]; // delay before 2nd and 3rd attempt

export interface SubmitWithRetryOptions {
  /**
   * Device owner captured when the learner acted. An account transition aborts
   * the transport and prevents the old payload being retried under a new login.
   */
  ownerLease?: OwnerLease;
}

export class OfflineOwnerChangedError extends Error {
  constructor() {
    super('Offline data owner changed during write');
    this.name = 'OfflineOwnerChangedError';
  }
}

function assertOwnerCurrent(ownerLease?: OwnerLease): void {
  if (ownerLease && !isOfflineOwnerCurrent(ownerLease)) {
    throw new OfflineOwnerChangedError();
  }
}

function isRetryable(error: unknown): boolean {
  // Network-level failures (cold start, DNS, connection reset)
  if (error instanceof TypeError) return true;
  // Our own per-attempt deadline, and a genuine abort, are transient too.
  if (error instanceof Error && /timed out/.test(error.message)) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return false;
}

function isRetryableStatus(status: number): boolean {
  // 502/503/504 are typically transient (cold start, gateway timeout)
  return status === 502 || status === 503 || status === 504;
}

/**
 * POST with automatic retry on transient failures (cold starts, network blips).
 * Returns the Response on success (caller still checks res.ok for 4xx/5xx).
 * Only throws after all retries are exhausted on network-level errors.
 */
export async function submitWithRetry(
  url: string,
  body: Record<string, unknown>,
  options: SubmitWithRetryOptions = {},
): Promise<Response> {
  let lastError: unknown;
  const ownerController = new AbortController();
  const ownerChanged = () => {
    if (options.ownerLease && !isOfflineOwnerCurrent(options.ownerLease)) {
      ownerController.abort(new OfflineOwnerChangedError());
    }
  };
  if (typeof window !== 'undefined' && options.ownerLease) {
    window.addEventListener(OFFLINE_OWNER_CHANGE_EVENT, ownerChanged);
  }

  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      assertOwnerCurrent(options.ownerLease);
      try {
        const res = await fetchWithDeadline(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ownerController.signal,
        }, REQUEST_TIMEOUT_MS);
        assertOwnerCurrent(options.ownerLease);

        // Retry on transient HTTP errors (cold start 502/503/504)
        if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS - 1) {
          await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
          assertOwnerCurrent(options.ownerLease);
          continue;
        }

        return res;
      } catch (err) {
        assertOwnerCurrent(options.ownerLease);
        lastError = err;

        if (!isRetryable(err) || attempt >= MAX_ATTEMPTS - 1) {
          throw err;
        }

        await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        assertOwnerCurrent(options.ownerLease);
      }
    }
  } finally {
    if (typeof window !== 'undefined' && options.ownerLease) {
      window.removeEventListener(OFFLINE_OWNER_CHANGE_EVENT, ownerChanged);
    }
  }

  throw lastError;
}
