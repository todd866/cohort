/**
 * Anonymous session tracking for users who aren't logged in.
 * Allows tracking interactions to optimize content and nudge users to log in.
 */

import { prisma } from '@/lib/prisma';
import { cookies } from 'next/headers';
import crypto from 'crypto';

const SESSION_COOKIE_NAME = 'md3_anon_session';
const SESSION_EXPIRY_DAYS = 30;

/**
 * Generate a privacy-respecting fingerprint from browser info.
 * Does NOT include IP address or precise device identifiers.
 */
export function generateFingerprint(
  userAgent: string,
  screenSize?: string,
  timezone?: string
): string {
  const components = [
    userAgent.slice(0, 100), // Truncate to avoid excessive data
    screenSize ?? 'unknown',
    timezone ?? 'unknown',
  ];
  return crypto.createHash('sha256').update(components.join('|')).digest('hex').slice(0, 32);
}

/**
 * Get or create an anonymous session for the current request.
 * Returns the session ID and whether it's new.
 */
export async function getOrCreateAnonymousSession(
  fingerprint: string
): Promise<{ sessionId: string; isNew: boolean }> {
  const cookieStore = await cookies();
  const existingSessionId = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (existingSessionId) {
    // Verify session exists and update lastActiveAt
    const session = await prisma.anonymousSession.findUnique({
      where: { id: existingSessionId },
    });

    // A session linked during sign-in is no longer an anonymous identity. On
    // a later logout/shared-device visit, rotate to a new guest session rather
    // than attributing that person's activity to the prior account.
    if (session && !session.userId) {
      await prisma.anonymousSession.update({
        where: { id: existingSessionId },
        data: { lastActiveAt: new Date() },
      });
      return { sessionId: existingSessionId, isNew: false };
    }
    // Session doesn't exist, create new one below
  }

  // Fingerprints are coarse analytics attributes, not identity or bearer
  // credentials. Without the random HttpOnly cookie, always create a fresh
  // session; resuming by UA/screen/timezone can merge people on shared/common
  // devices and later attach one person's events to another person's account.
  const newSession = await prisma.anonymousSession.create({
    data: { fingerprint },
  });

  cookieStore.set(SESSION_COOKIE_NAME, newSession.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_EXPIRY_DAYS * 24 * 60 * 60,
  });

  return { sessionId: newSession.id, isNew: true };
}

/**
 * Read the current anonymous session ID from the HttpOnly cookie.
 * Returns null if no cookie is set. The cookie is the only trusted source —
 * never accept sessionId from query params, body, or response echoes (those
 * would let a sessionId act as a bearer token if it leaked).
 */
export async function readAnonymousSessionCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Record activity for an anonymous session.
 */
export async function recordAnonymousActivity(
  sessionId: string,
  activity: {
    cardsViewed?: number;
    mcqsAttempted?: number;
    pagesRead?: number;
  }
): Promise<void> {
  await prisma.anonymousSession.update({
    where: { id: sessionId },
    data: {
      lastActiveAt: new Date(),
      cardsViewed: activity.cardsViewed ? { increment: activity.cardsViewed } : undefined,
      mcqsAttempted: activity.mcqsAttempted ? { increment: activity.mcqsAttempted } : undefined,
      pagesRead: activity.pagesRead ? { increment: activity.pagesRead } : undefined,
    },
  });
}

/**
 * Get activity totals for an anonymous session.
 * Used to determine when to show login nudge.
 */
export async function getAnonymousSessionActivity(sessionId: string): Promise<{
  cardsViewed: number;
  mcqsAttempted: number;
  pagesRead: number;
  totalInteractions: number;
} | null> {
  const session = await prisma.anonymousSession.findUnique({
    where: { id: sessionId },
    select: { cardsViewed: true, mcqsAttempted: true, pagesRead: true },
  });

  if (!session) return null;

  return {
    cardsViewed: session.cardsViewed,
    mcqsAttempted: session.mcqsAttempted,
    pagesRead: session.pagesRead,
    totalInteractions: session.cardsViewed + session.mcqsAttempted + session.pagesRead,
  };
}

/**
 * Link an anonymous session to a user after login.
 * Also stamps userId on all FeedEvents from this session for queryability.
 */
export async function linkSessionToUser(sessionId: string, userId: string): Promise<void> {
  // Guard the Prisma undefined-where footgun: a falsy sessionId would make the
  // feedEvent.updateMany below drop its where key (`{ sessionFingerprint: undefined }`
  // → `{}`) and stamp EVERY FeedEvent with this userId. Never run on bad input.
  if (!sessionId || !userId) return;
  await prisma.$transaction(async (tx) => {
    const session = await tx.anonymousSession.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!session) return;
    // A copied/stale cookie must never reassign another account's attribution.
    if (session.userId && session.userId !== userId) return;

    await tx.anonymousSession.update({
      where: { id: sessionId },
      data: { userId },
    });
    await tx.feedEvent.updateMany({
      where: {
        sessionFingerprint: sessionId,
        OR: [{ userId: null }, { userId }],
      },
      data: { userId },
    });
  });
}

/**
 * Login nudge thresholds.
 */
export const LOGIN_NUDGE_THRESHOLDS = {
  CARDS_VIEWED: 5,     // After viewing 5 cards
  MCQS_ATTEMPTED: 10,  // After attempting 10 MCQs
  PAGES_READ: 3,       // After reading 3 pages
  TOTAL_INTERACTIONS: 8, // After any 8 interactions
};

/**
 * Check if we should show a login nudge.
 */
export function shouldShowLoginNudge(activity: {
  cardsViewed: number;
  mcqsAttempted: number;
  pagesRead: number;
  totalInteractions: number;
}): { show: boolean; reason?: string } {
  if (activity.cardsViewed >= LOGIN_NUDGE_THRESHOLDS.CARDS_VIEWED) {
    return { show: true, reason: 'Log in to save your progress!' };
  }
  if (activity.mcqsAttempted >= LOGIN_NUDGE_THRESHOLDS.MCQS_ATTEMPTED) {
    return { show: true, reason: 'Your study streak won\'t count without an account.' };
  }
  if (activity.pagesRead >= LOGIN_NUDGE_THRESHOLDS.PAGES_READ) {
    return { show: true, reason: 'Welcome back! Log in to pick up where you left off.' };
  }
  if (activity.totalInteractions >= LOGIN_NUDGE_THRESHOLDS.TOTAL_INTERACTIONS) {
    return { show: true, reason: 'Create a free account to track your progress!' };
  }
  return { show: false };
}
