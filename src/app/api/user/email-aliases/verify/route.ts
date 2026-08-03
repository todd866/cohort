/**
 * Email Alias Verification Endpoint
 *
 * GET - Verify an email alias via token from email link
 *
 * Redirects to settings page with success/error message.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { resolveTrustedAppOrigin } from '@/lib/auth-verification-email';

function settingsRedirect(
  origin: string,
  key: 'error' | 'success',
  value: string,
): NextResponse {
  const destination = new URL('/profile/settings', origin);
  destination.searchParams.set(key, value);
  return NextResponse.redirect(destination);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const aliasId = searchParams.get('id');

  let appOrigin: string;
  try {
    appOrigin = resolveTrustedAppOrigin(request.url);
  } catch {
    return NextResponse.json(
      { error: 'Email verification is unavailable for this request origin' },
      { status: 400 },
    );
  }

  if (!token || !aliasId) {
    return settingsRedirect(appOrigin, 'error', 'invalid_verification_link');
  }

  try {
    // Find and validate the verification token
    const verificationToken = await prisma.verificationToken.findFirst({
      where: {
        identifier: `alias:${aliasId}`,
        token: token,
      },
    });

    if (!verificationToken) {
      return settingsRedirect(appOrigin, 'error', 'invalid_or_expired_token');
    }

    // Check if token is expired
    if (verificationToken.expires < new Date()) {
      // Clean up expired token
      await prisma.verificationToken.delete({
        where: {
          identifier_token: {
            identifier: verificationToken.identifier,
            token: verificationToken.token,
          },
        },
      });

      return settingsRedirect(appOrigin, 'error', 'verification_link_expired');
    }

    // Find the alias
    const alias = await prisma.userEmail.findUnique({
      where: { id: aliasId },
    });

    if (!alias) {
      return settingsRedirect(appOrigin, 'error', 'alias_not_found');
    }

    // Consume the token in the same transaction that verifies the alias. A
    // retry can therefore never observe a verified alias with a live token, or
    // a consumed token with an unverified alias.
    await prisma.$transaction([
      prisma.userEmail.update({
        where: { id: aliasId },
        data: {
          verified: true,
          verifiedAt: new Date(),
        },
      }),
      prisma.verificationToken.delete({
        where: {
          identifier_token: {
            identifier: verificationToken.identifier,
            token: verificationToken.token,
          },
        },
      }),
    ]);

    return settingsRedirect(appOrigin, 'success', 'email_alias_verified');
  } catch (error) {
    logger.error('Failed to verify email alias', { aliasId, error: String(error) });
    return settingsRedirect(appOrigin, 'error', 'verification_failed');
  }
}
