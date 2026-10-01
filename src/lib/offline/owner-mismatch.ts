import { NextResponse } from 'next/server';
import { DEVICE_GUEST_OWNER_PREFIX } from './owner';
import { OFFLINE_OWNER_HEADER, OFFLINE_OWNER_MISMATCH_HEADER } from './owner-header';

/**
 * Refuse a write queued for a different account than the session cookie.
 *
 * The cookie is shared by every tab and a request carries whatever it is at
 * send time, so after an account switch in another tab a grade made for
 * account A can arrive with B's cookie. TLA+ (docs/formal/ReviewOutbox.tla)
 * found that trace; this check plus the tab check in captureOfflineOwner()
 * is what closed it. A device-guest owner cannot be mapped to an account here
 * (the guest claim moves those rows), and a request naming no owner predates
 * the header, so both pass.
 *
 * Returns the refusal, or null to proceed.
 */
export function offlineOwnerMismatchResponse(
  request: Request,
  user: { id?: string | null; email?: string | null },
): NextResponse | null {
  const claimed = request.headers.get(OFFLINE_OWNER_HEADER)?.trim();
  if (!claimed || claimed.startsWith(DEVICE_GUEST_OWNER_PREFIX)) return null;
  const email = user.email?.trim().toLowerCase();
  if (claimed === user.id || (email && claimed === email)) return null;
  return NextResponse.json(
    { error: 'This answer belongs to another account signed in on this device.' },
    { status: 409, headers: { [OFFLINE_OWNER_MISMATCH_HEADER]: '1' } },
  );
}
