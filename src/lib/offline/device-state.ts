/**
 * Centralized lifecycle for personalized data kept on this browser.
 *
 * Account switches publish the new owner/generation first, making stale leases
 * unusable, before clearing synchronous stores. Figure bytes are owner-keyed, so
 * their slower Cache API deletion can safely finish in the background.
 */

import {
  claimDeviceGuestReviewOutbox,
  clearOutbox,
  quarantineLegacyOutbox,
} from '@/lib/outbox';
import { clearFigureCache } from './figures';
import { clearPack, storedPackOwnerKey } from './pack';
import { clearOfflineReviewProgress } from './progress';
import {
  bindVerifiedOfflineOwner,
  clearOfflineOwner,
  DEVICE_GUEST_OWNER_PREFIX,
  readOfflineOwner,
  type OwnerLease,
} from './owner';

export function bindOfflineOwner(ownerKey: string): OwnerLease {
  const previousOwner = readOfflineOwner();
  const packOwner = storedPackOwnerKey();

  // Synchronous and deliberately first: any in-flight response holding the old
  // generation becomes stale before cleanup begins.
  const lease = bindVerifiedOfflineOwner(ownerKey);
  const switched =
    (previousOwner !== null && previousOwner.ownerKey !== lease.ownerKey) ||
    (packOwner !== null && packOwner !== lease.ownerKey);

  if (switched) {
    clearPack();
    clearOfflineReviewProgress();
    if (
      previousOwner
      && !previousOwner.verified
      && previousOwner.ownerKey.startsWith(DEVICE_GUEST_OWNER_PREFIX)
    ) {
      // A verified sign-in claims only the active device guest's review rows.
      // Verified-account switches and malformed/unowned partitions still take
      // the destructive privacy boundary below.
      claimDeviceGuestReviewOutbox(previousOwner.ownerKey, lease.ownerKey);
    } else {
      clearOutbox();
    }
    void clearFigureCache().catch(() => {
      // Figure keys are owner-scoped, so failed best-effort deletion cannot
      // expose the previous owner's bytes to the newly bound account.
    });
  } else {
    // There is no defensible way to assign pre-owner writes to this account.
    quarantineLegacyOutbox();
  }

  return lease;
}

/**
 * Explicit sign-out/device reset. Unlike an account switch, completion means
 * the asynchronous figure cache has also been removed.
 */
export async function clearOfflineUserData(): Promise<void> {
  // Invalidate leases first so work resolving during cleanup cannot commit.
  clearOfflineOwner();
  clearPack();
  clearOfflineReviewProgress();
  clearOutbox();
  await clearFigureCache().catch(() => {
    // Local cleanup failure must not trap the user in a signed-in UI.
  });
}
