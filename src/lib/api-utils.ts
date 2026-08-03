import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getOrCreateGuestUser, getGuestUserId } from '@/lib/guest-user';
import { isAdminEmail } from '@/lib/admin-shared';
import { checkRateLimit } from '@/lib/rate-limit';

const GUEST_CREATION_LIMIT = 5;
const GUEST_CREATION_WINDOW_MS = 60_000;

type AuthOrGuestSuccess = {
  userId: string;
  isGuest: boolean;
  response?: never;
};

type AuthOrGuestResult = AuthOrGuestSuccess | {
  response: NextResponse;
  userId?: never;
  isGuest?: never;
};

function requestIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
}

/**
 * Require authentication for an API route.
 * Returns the authenticated userId, or a 401 NextResponse.
 */
export async function requireAuth(): Promise<
  { userId: string; isAdmin?: boolean; response?: never }
  | { response: NextResponse; userId?: never; isAdmin?: never }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  // Derived from ADMIN_EMAILS in the session callback. Callers that gate on
  // reporter identity (the flag trust boundary) need it without a second auth()
  // round-trip. Optional, so an absent value — including in a test double —
  // reads as "not an admin" and fails closed.
  return { userId: session.user.id, isAdmin: session.user.isAdmin === true };
}

/**
 * Optionally authenticate — returns userId if logged in, null otherwise.
 * Use this for routes that accept anonymous requests (help, feedback, etc.).
 */
export async function optionalAuth(): Promise<{ userId: string | null }> {
  const session = await auth();
  return { userId: session?.user?.id ?? null };
}

/**
 * Get authenticated user or create/retrieve guest user.
 * Use this for routes that support both logged-in and anonymous users.
 *
 * An existing guest cookie is reused and creation of a new guest `User` row is
 * gated by a shared IP bucket before the insert. Requiring the Request here
 * prevents route wrappers and future callers from accidentally bypassing the
 * pre-creation gate.
 */
export async function requireAuthOrGuest(request: Request): Promise<AuthOrGuestResult> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, isGuest: false };
  }

  const existingGuestId = await getGuestUserId();
  if (existingGuestId) {
    return { userId: existingGuestId, isGuest: true };
  }

  const rateLimit = await checkRateLimit(
    `guest-user-create:${requestIp(request)}`,
    GUEST_CREATION_LIMIT,
    GUEST_CREATION_WINDOW_MS,
  );
  if (!rateLimit.ok) {
    return {
      response: NextResponse.json(
        { error: 'Too many new guest sessions' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1_000))),
          },
        },
      ),
    };
  }

  const guestId = await getOrCreateGuestUser();
  return { userId: guestId, isGuest: true };
}

/**
 * Get authenticated user or existing guest. Does NOT create a new guest
 * user record. Use for write endpoints so anonymous requests can't
 * spawn a User row on every call (DB-bloat / cost-amplification risk).
 *
 * Returns a 401 if the caller has neither a session nor a valid guest
 * cookie — clients must first touch a read endpoint (or a page) to get
 * a cookie before they can write.
 */
export async function requireAuthOrExistingGuest(): Promise<
  | { userId: string; isGuest: boolean; response?: never }
  | { response: NextResponse; userId?: never; isGuest?: never }
> {
  const session = await auth();
  if (session?.user?.id) {
    return { userId: session.user.id, isGuest: false };
  }
  const guestId = await getGuestUserId();
  if (guestId) {
    return { userId: guestId, isGuest: true };
  }
  return {
    response: NextResponse.json(
      { error: 'Authentication required — load the app first to establish a session' },
      { status: 401 }
    ),
  };
}

/**
 * Require admin authentication for an API route.
 * Returns userId, or a 401/403 NextResponse.
 */
export async function requireAdmin(): Promise<
  { userId: string; response?: never } | { response: NextResponse; userId?: never }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'Authentication required' }, { status: 401 }) };
  }
  if (!isAdminEmail(session.user.email)) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { userId: session.user.id };
}
