import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { headers } from 'next/headers';
import { buildIdentitySignals, type IdentitySignals } from './identity-signals';
import {
  linkSessionToUser,
  readAnonymousSessionCookie,
} from '@/lib/tracking/anonymous-session';

export interface AuthSuccessInput {
  userId: string;
  provider: string | null;
  isNewUser: boolean;
}

interface AuthSuccessEvent {
  userId: string;
  eventType: 'auth_success';
  itemType: 'auth';
  action: 'signup_success' | 'signin_success';
  metadata: {
    provider: string | null;
    isNewUser: boolean;
    identitySignals?: IdentitySignals;
  };
}

export interface AuthFunnelDependencies {
  readAnonymousSessionCookie: () => Promise<string | null>;
  linkSessionToUser: (sessionId: string, userId: string) => Promise<void>;
  createFeedEvent: (data: AuthSuccessEvent) => Promise<unknown>;
  warn: (message: string, metadata: Record<string, unknown>) => void;
  identitySignals?: (anonymousCookie: string | null) => Promise<IdentitySignals | undefined>;
}

const defaultDependencies: AuthFunnelDependencies = {
  readAnonymousSessionCookie,
  linkSessionToUser,
  createFeedEvent: (data) => prisma.feedEvent.create({ data }),
  warn: (message, metadata) => logger.warn(message, metadata),
  identitySignals: async (anonymousCookie) => buildIdentitySignals({
    anonymousCookie,
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    trustedVercel: process.env.VERCEL === '1',
    forwardedIp: process.env.VERCEL === '1' ? (await headers()).get('x-forwarded-for') : null,
  }),
};

/**
 * Attribute an Auth.js success to its pre-auth funnel without ever making
 * authentication depend on analytics. The HttpOnly cookie is the only accepted
 * anonymous-session identity; provider account ids and email addresses are not
 * copied into FeedEvent.
 */
export async function recordAuthSuccessBestEffort(
  input: AuthSuccessInput,
  dependencies: AuthFunnelDependencies = defaultDependencies,
): Promise<void> {
  let anonymousSessionId: string | null = null;
  try {
    anonymousSessionId = await dependencies.readAnonymousSessionCookie();
    if (anonymousSessionId) {
      await dependencies.linkSessionToUser(anonymousSessionId, input.userId);
    }
  } catch (error) {
    dependencies.warn('auth-attribution-link-failed', {
      userId: input.userId,
      error: String(error),
    });
  }

  let identitySignals: IdentitySignals | undefined;
  try {
    identitySignals = await dependencies.identitySignals?.(anonymousSessionId);
  } catch {
    // Optional correlation must not block login or leak headers into logs.
    dependencies.warn('auth-identity-signals-unavailable', {});
  }
  try {
    await dependencies.createFeedEvent({
      userId: input.userId,
      eventType: 'auth_success',
      itemType: 'auth',
      action: input.isNewUser ? 'signup_success' : 'signin_success',
      metadata: {
        provider: input.provider,
        isNewUser: input.isNewUser,
        ...(identitySignals ? { identitySignals } : {}),
      },
    });
  } catch (error) {
    dependencies.warn('auth-success-event-failed', {
      userId: input.userId,
      error: String(error),
    });
  }
}
