/**
 * Guest User Management
 *
 * Provides cookie-based guest user IDs so guests get the same
 * study experience as logged-in users (same scheduler, progress tracking).
 *
 * Guest users:
 * - Get a persistent UUID stored in a cookie (30 days)
 * - Have a User record created on first visit
 * - Can convert to full account later (preserves progress)
 */

import { cookies } from 'next/headers';
import { prisma } from './prisma';

const GUEST_COOKIE_NAME = 'md3_guest_id';
const GUEST_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

function guestCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge,
    path: '/',
  };
}

/**
 * Read the raw guest identity from the trusted HttpOnly cookie. Eligibility
 * must still be checked transactionally before moving any data.
 */
export async function readGuestUserCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(GUEST_COOKIE_NAME)?.value ?? null;
}

/**
 * Retire the browser's guest identity after a successful progress claim.
 */
export async function clearGuestUserCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(GUEST_COOKIE_NAME, '', guestCookieOptions(0));
}

/**
 * Get or create a guest user ID from cookies.
 * Returns the user ID (not the cookie value).
 */
export async function getOrCreateGuestUser(): Promise<string> {
  const cookieStore = await cookies();
  const existingId = cookieStore.get(GUEST_COOKIE_NAME)?.value;

  if (existingId) {
    // Check if user exists
    const user = await prisma.user.findFirst({
      where: { id: existingId },
      select: { id: true },
    });

    if (user) {
      // Refresh cookie on each visit - rolling expiry so active guests never lose progress
      cookieStore.set(
        GUEST_COOKIE_NAME,
        user.id,
        guestCookieOptions(GUEST_COOKIE_MAX_AGE),
      );
      return user.id;
    }
  }

  // Create new guest user
  const guestUser = await prisma.user.create({
    data: {
      name: 'Guest',
      // No email - distinguishes guest from real users
    },
    select: { id: true },
  });

  // Set cookie
  cookieStore.set(
    GUEST_COOKIE_NAME,
    guestUser.id,
    guestCookieOptions(GUEST_COOKIE_MAX_AGE),
  );

  return guestUser.id;
}

/**
 * Get guest user ID if it exists (doesn't create one).
 */
export async function getGuestUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const guestId = cookieStore.get(GUEST_COOKIE_NAME)?.value;

  if (!guestId) return null;

  // Verify user exists
  const user = await prisma.user.findFirst({
    where: { id: guestId },
    select: { id: true },
  });

  return user?.id ?? null;
}

/**
 * Check if a user ID is a guest (no email).
 */
export async function isGuestUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  return user?.email === null;
}
