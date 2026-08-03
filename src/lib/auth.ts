import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import Resend from 'next-auth/providers/resend';
import { PrismaAdapter } from '@auth/prisma-adapter';
import type { Adapter } from 'next-auth/adapters';
import { Resend as ResendClient } from 'resend';
import prisma from './prisma';
import { logger } from './logger';
import { AUTH_PAGES, SESSION_CONFIG } from './auth-session-config';
import { createAliasAwareAdapter } from './auth-alias';
import { claimGuestProgressAfterSignIn } from './guest-progress-claim';
import { recordAuthSuccessBestEffort } from './tracking/auth-funnel';
import {
  buildVerificationEmailContext,
  prepareDualHostAuthEnvironment,
} from './auth-verification-email';
import { getOutboundEmailConfig } from './outbound-email-config';
import type { NextAuthConfig } from 'next-auth';

// next-auth v5's request wrapper canonicalizes every request to AUTH_URL or
// NEXTAUTH_URL. The live deployment serves both md3.info and cohort.md, so a
// first-party canonical value would cross hosts during OAuth/email callbacks
// and strand a host-only session cookie. Clear only that known dual-host
// misconfiguration; custom single-host FOSS deployments retain their URL.
const clearedAuthOrigins = prepareDualHostAuthEnvironment(process.env);
if (clearedAuthOrigins.length > 0) {
  logger.warn('auth-fixed-origin-disabled-for-dual-host', {
    variables: clearedAuthOrigins,
  });
}

// Build providers list dynamically based on configured env vars
const providers: NextAuthConfig['providers'] = [];

// Email (Magic Link) via Resend is operator-owned and stays disabled until
// both the credential and sender identity are explicitly configured.
const outboundEmail = getOutboundEmailConfig();
if (outboundEmail) {
  const resend = new ResendClient(outboundEmail.apiKey);

  providers.push(
    Resend({
      id: 'email', // Keep v4 provider id for backwards compat with signIn('email') calls
      from: outboundEmail.from,
      sendVerificationRequest: async ({ identifier: email, url }) => {
        // Route through the same-host intermediate page to handle in-app
        // browsers. The helper rejects callback origins outside the explicit
        // first-party/configured allowlist before any email is sent.
        const verification = buildVerificationEmailContext(url);

        const result = await resend.emails.send({
          from: outboundEmail.from,
          to: email,
          subject: verification.subject,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Sign in to ${verification.productName}</h1>
              <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
                Click the button below to sign in to your account. This link will expire in 24 hours.
              </p>
              <a href="${verification.verifyUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
                ${verification.actionLabel}
              </a>
              <p style="color: #888; font-size: 14px; margin-top: 24px;">
                If the button doesn't work, copy and paste this link into your browser:
              </p>
              <p style="color: #2563eb; font-size: 13px; word-break: break-all;">
                ${verification.verifyUrl}
              </p>
              <p style="color: #888; font-size: 14px; margin-top: 16px;">
                If you didn't request this email, you can safely ignore it.
              </p>
            </div>
          `,
        });

        if (result.error) {
          logger.error('Failed to send verification email', {
            provider: 'resend',
            reason: 'delivery_failed',
          });
          throw new Error('Failed to send verification email');
        }
      },
    })
  );
}

// Google OAuth - enabled if credentials are set
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

// GitHub OAuth - enabled if credentials are set
if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.GITHUB_ID,
      clientSecret: process.env.GITHUB_SECRET,
    })
  );
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  trustHost: true,
  adapter: createAliasAwareAdapter(PrismaAdapter(prisma) as Adapter),
  providers,
  session: SESSION_CONFIG,
  // Preserve v4 cookie names so existing sessions survive the migration
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production'
        ? '__Secure-next-auth.session-token'
        : 'next-auth.session-token',
    },
    callbackUrl: {
      name: process.env.NODE_ENV === 'production'
        ? '__Secure-next-auth.callback-url'
        : 'next-auth.callback-url',
    },
    csrfToken: {
      name: process.env.NODE_ENV === 'production'
        ? '__Host-next-auth.csrf-token'
        : 'next-auth.csrf-token',
    },
  },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Fetch betaAccess from DB (user object from adapter doesn't include custom fields)
        const dbUser = await prisma.user.findUnique({
          where: { id: user.id },
          select: { betaAccess: true, institution: true, imageTier: true },
        });
        session.user.betaAccess = dbUser?.betaAccess ?? false;
        session.user.institution = dbUser?.institution ?? null;
        session.user.imageTier =
          dbUser?.imageTier === 'copyright' ? 'copyright' : 'standard';
        // Attribute the pre-sign-in funnel using the HttpOnly guest cookie.
        // Fail open for authentication, but never accept a client-provided id;
        // linkSessionToUser also refuses cross-account reassignment.
        try {
          const { readAnonymousSessionCookie, linkSessionToUser } = await import(
            './tracking/anonymous-session'
          );
          const anonymousSessionId = await readAnonymousSessionCookie();
          if (anonymousSessionId) {
            await linkSessionToUser(anonymousSessionId, user.id);
          }
        } catch (error) {
          logger.warn('anonymous-session-link-failed', { userId: user.id, error: String(error) });
        }
        // Access flags — avoids exposing email lists to client
        const { isAdminEmail } = await import('./admin-shared');
        const { hasVideoAccess } = await import('./video-access');
        session.user.isAdmin = isAdminEmail(session.user.email);
        session.user.hasVideoAccess = hasVideoAccess(session.user.email);
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account, isNewUser }) {
      if (!user.id) {
        logger.warn('auth-success-missing-user-id', { provider: account?.provider ?? null });
        return;
      }
      // Claim the trusted cookie-backed guest review history before recording
      // funnel success. The claim is internally fail-open for authentication,
      // serializable, and clears the guest cookie only after commit.
      await claimGuestProgressAfterSignIn(user.id);
      await recordAuthSuccessBestEffort({
        userId: user.id,
        provider: account?.provider ?? null,
        isNewUser: isNewUser === true,
      });
    },
  },
  pages: AUTH_PAGES,
});

// Extend the session type to include custom fields
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      betaAccess?: boolean;
      institution?: string | null;
      isAdmin?: boolean;
      hasVideoAccess?: boolean;
      imageTier?: 'standard' | 'copyright';
    };
  }
}
