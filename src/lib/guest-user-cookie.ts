import 'server-only';

import { cookies } from 'next/headers';

/**
 * The HttpOnly cookie that carries a browser's guest identity.
 *
 * This module is deliberately free of any database import. It runs in the root
 * layout on every render, and its whole purpose is to be cheaper than the work
 * it gates — see `hasGuestUserCookie`.
 */
export const GUEST_COOKIE_NAME = 'md3_guest_id';

/**
 * Whether this request carries a guest identity at all.
 *
 * Presence is not eligibility: a cookie may point at a deleted or already
 * non-anonymous user. Callers must still verify transactionally before moving
 * any row. This answers only the cheap question — "is there anything here that
 * could possibly need importing?" — which is enough to skip a no-op round trip.
 */
export async function hasGuestUserCookie(): Promise<boolean> {
  const cookieStore = await cookies();
  return Boolean(cookieStore.get(GUEST_COOKIE_NAME)?.value);
}
