import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
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
  };
}

export interface AuthFunnelDependencies {
  readAnonymousSessionCookie: () => Promise<string | null>;
  linkSessionToUser: (sessionId: string, userId: string) => Promise<void>;
  createFeedEvent: (data: AuthSuccessEvent) => Promise<unknown>;
  warn: (message: string, metadata: Record<string, unknown>) => void;
}

const defaultDependencies: AuthFunnelDependencies = {
  readAnonymousSessionCookie,
  linkSessionToUser,
  createFeedEvent: (data) => prisma.feedEvent.create({ data }),
  warn: (message, metadata) => logger.warn(message, metadata),
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
  try {
    const anonymousSessionId = await dependencies.readAnonymousSessionCookie();
    if (anonymousSessionId) {
      await dependencies.linkSessionToUser(anonymousSessionId, input.userId);
    }
  } catch (error) {
    dependencies.warn('auth-attribution-link-failed', {
      userId: input.userId,
      error: String(error),
    });
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
      },
    });
  } catch (error) {
    dependencies.warn('auth-success-event-failed', {
      userId: input.userId,
      error: String(error),
    });
  }
}
