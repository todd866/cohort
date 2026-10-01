/**
 * Client-side guest-claim UI decisions. Pure helpers so the warm banner cannot
 * retry forever on a sticky cookie or Neon blip.
 */

export const GUEST_CLAIM_REQUEST_DEADLINE_MS = 15_000;
/** Keep guest-claim off the review cold-start critical path. */
export const GUEST_CLAIM_START_DEFER_MS = 12_000;
export const GUEST_CLAIM_RETRY_MS = 60_000;
/** Auto-retries per page load; further attempts require a manual Retry click. */
export const GUEST_CLAIM_MAX_AUTO_RETRIES = 2;

export type GuestClaimResponseStatus =
  | 'claimed'
  | 'nothing-to-claim'
  | 'not-eligible'
  | 'failed'
  | string;

export type GuestClaimClientOutcome =
  | { kind: 'imported' }
  | { kind: 'done' }
  | { kind: 'retryable' };

export function interpretGuestClaimResponse(args: {
  ok: boolean;
  status?: GuestClaimResponseStatus;
}): GuestClaimClientOutcome {
  if (!args.ok || args.status === 'failed') {
    return { kind: 'retryable' };
  }
  if (args.status === 'claimed') {
    return { kind: 'imported' };
  }
  // nothing-to-claim, not-eligible (incl. cookie-missing / guest-missing), or
  // any other 200 terminal payload: stop. The server clears sticky cookies on
  // terminal not-eligible; retrying only re-contends Neon.
  return { kind: 'done' };
}

export function shouldScheduleGuestClaimAutoRetry(autoRetryCount: number): boolean {
  return autoRetryCount < GUEST_CLAIM_MAX_AUTO_RETRIES;
}

export type GuestClaimClientBeaconOutcome = 'client_timeout' | 'retryable_http';

/**
 * Fire-and-forget when the browser aborts or gets a retryable failure before
 * the server LearningEvent lands. Never throws.
 */
export function reportGuestClaimClientOutcome(args: {
  outcome: GuestClaimClientBeaconOutcome;
  autoRetryCount: number;
  error?: string;
}): void {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return;
    }
    navigator.sendBeacon('/api/log/client-error', JSON.stringify({
      kind: 'guest_progress_claim',
      outcome: args.outcome,
      autoRetryCount: args.autoRetryCount,
      error: args.error?.slice(0, 200),
      ts: Date.now(),
    }));
  } catch {
    // never let telemetry break the review shell
  }
}
