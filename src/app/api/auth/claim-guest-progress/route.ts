import { NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth';
import { readGuestUserCookie } from '@/lib/guest-user';
import {
  claimGuestProgressAfterSignIn,
  type GuestProgressClaimResult,
} from '@/lib/guest-progress-claim';
import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';

/**
 * Retry a cookie-backed guest-progress import after authentication.
 *
 * The HttpOnly guest cookie remains the only source of the guest identity.
 * This endpoint accepts no user/guest identifiers, so an authenticated client
 * cannot select another account's rows. A failed bounded attempt leaves the
 * cookie intact and is safe to retry on the next app resume. Terminal
 * not-eligible outcomes clear the sticky cookie so authenticated clients do
 * not re-contend Neon forever.
 */
export async function POST() {
  // This component mounts for every authenticated app load, but almost every
  // steady-state browser has no guest identity left to claim. Check the
  // request's own HttpOnly cookie before invoking Auth.js: its session callback
  // performs database work and can otherwise turn this no-op into a client
  // timeout. A cookie-present request still passes through authentication and
  // the claim helper's transactional eligibility checks below.
  try {
    if (!(await readGuestUserCookie())) {
      return NextResponse.json(
        { status: 'not-eligible', reason: 'cookie-missing' },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
  } catch (error) {
    // Preserve the existing fail-safe path. The claim helper re-reads the
    // cookie, logs a bounded failure, and leaves any recoverable history intact.
    // Logged because a silent throw here would revert this route to its old
    // cost with no signal that the fast path had stopped working.
    logger.warn('guest-progress-claim-cookie-precheck-failed', {
      error: String(error),
    });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }

  const userId = session.user.id;
  const startedAt = Date.now();
  const result = await claimGuestProgressAfterSignIn(userId);
  const durationMs = Date.now() - startedAt;

  after(() => persistGuestClaimTelemetry(userId, result, durationMs));

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

async function persistGuestClaimTelemetry(
  userId: string,
  result: GuestProgressClaimResult,
  durationMs: number,
): Promise<void> {
  // Skip the steady-state "no guest cookie" ping from every signed-in visit.
  if (result.status === 'not-eligible' && result.reason === 'cookie-missing') {
    return;
  }

  const reason = result.status === 'not-eligible' ? result.reason : undefined;
  try {
    await prisma.learningEvent.create({
      data: {
        userId,
        eventType: 'guest_progress_claim',
        sourceType: 'session',
        sourceId: 'guest_progress_claim',
        responseMs: durationMs,
        metadata: {
          status: result.status,
          reason,
          durationMs,
        },
      },
    });
  } catch (error) {
    logger.warn('guest-progress-claim telemetry failed', {
      userId,
      error: String(error),
    });
  }
}
