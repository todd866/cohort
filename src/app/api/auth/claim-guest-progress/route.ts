import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { claimGuestProgressAfterSignIn } from '@/lib/guest-progress-claim';

/**
 * Retry a cookie-backed guest-progress import after authentication.
 *
 * The HttpOnly guest cookie remains the only source of the guest identity.
 * This endpoint accepts no user/guest identifiers, so an authenticated client
 * cannot select another account's rows. A failed bounded attempt leaves the
 * cookie intact and is safe to retry on the next app resume.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  const result = await claimGuestProgressAfterSignIn(session.user.id);
  if (result.status === 'failed') {
    return NextResponse.json(
      { status: result.status },
      { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
