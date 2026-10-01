/**
 * Every personal write names the device-local owner it was queued under, and
 * the server refuses it when that is not the session account. See
 * owner-mismatch.ts and docs/formal/ReviewOutbox.tla.
 */
export const OFFLINE_OWNER_HEADER = 'x-md3-offline-owner';
/** Set on the 409 so the outbox can tell "wrong account" from other conflicts. */
export const OFFLINE_OWNER_MISMATCH_HEADER = 'x-md3-owner-mismatch';
