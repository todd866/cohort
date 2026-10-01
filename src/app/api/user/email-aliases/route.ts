/**
 * Email Aliases API
 *
 * GET - List all email aliases for current user
 * POST - Add a new email alias (sends verification email)
 * DELETE - Remove an email alias
 *
 * Allows users to log in with multiple email addresses.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-utils';
import { prisma } from '@/lib/prisma';
import { Resend } from 'resend';
import crypto from 'crypto';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { resolveTrustedAppOrigin } from '@/lib/auth-verification-email';
import { checkUserRateLimit } from '@/lib/rate-limit';
import { getOutboundEmailConfig } from '@/lib/outbound-email-config';

const emailAliasPostSchema = z.object({
  email: z.string().trim().email('Invalid email format'),
  label: z.string().trim().max(100).nullable().optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    const aliases = await prisma.userEmail.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        verified: true,
        verifiedAt: true,
        label: true,
        createdAt: true,
      },
    });

    // Also get the primary email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    return NextResponse.json({
      primaryEmail: user?.email,
      aliases,
    });
  } catch (error) {
    logger.error('Failed to get email aliases', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Failed to get email aliases' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = emailAliasPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const emailIssue = parseResult.error.issues.find(
        (issue) => issue.path[0] === 'email'
      );
      if (emailIssue) {
        // Zod .email() returns 'Invalid email format' for bad format,
        // other validators return their own messages
        return NextResponse.json({ error: emailIssue.message }, { status: 400 });
      }

      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { email, label } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();
    const outboundEmail = getOutboundEmailConfig();
    if (!outboundEmail) {
      return NextResponse.json(
        { error: 'Email verification is not configured for this deployment' },
        { status: 503 },
      );
    }

    let appOrigin: string;
    try {
      appOrigin = resolveTrustedAppOrigin(request.url);
    } catch {
      return NextResponse.json(
        { error: 'Email verification is unavailable for this request origin' },
        { status: 400 },
      );
    }
    const isCohort = new URL(appOrigin).hostname.toLowerCase().replace(/^www\./, '') === 'cohort.md';
    const productName = isCohort ? 'Cohort' : 'MD3 Study';
    const resend = new Resend(outboundEmail.apiKey);
    const rateLimit = await checkUserRateLimit(
      userId,
      'email-alias-verification',
      5,
      60 * 60 * 1000,
    );
    if (!rateLimit.ok) {
      return NextResponse.json(
        { error: 'Too many email verification requests' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))),
          },
        },
      );
    }

    // Check if this email is already the user's primary email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (user?.email?.toLowerCase() === normalizedEmail) {
      return NextResponse.json(
        { error: 'This is already your primary email' },
        { status: 400 }
      );
    }

    // Check if email is already used by another user or alias
    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });

    if (existingUser && existingUser.id !== userId) {
      return NextResponse.json(
        { error: 'This email is already associated with another account' },
        { status: 400 }
      );
    }

    const existingAlias = await prisma.userEmail.findFirst({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
    });

    if (existingAlias) {
      if (existingAlias.userId === userId) {
        return NextResponse.json(
          { error: 'This email is already added to your account' },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: 'This email is already associated with another account' },
        { status: 400 }
      );
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create alias + token atomically. If either throws the whole thing rolls
    // back — previously the alias could be left orphaned when token create
    // failed, which tripped the "already added" check on retry.
    const alias = await prisma.$transaction(async (tx) => {
      const created = await tx.userEmail.create({
        data: {
          email: normalizedEmail,
          userId,
          label: label || null,
          verified: false,
        },
      });
      await tx.verificationToken.create({
        data: {
          identifier: `alias:${created.id}`,
          token: verificationToken,
          expires: tokenExpiry,
        },
      });
      return created;
    });

    // Send verification email. If this fails, clean up the alias + token so the
    // user can retry from a clean state (rather than being blocked by an
    // orphan "already added" alias).
    {
      const verifyUrl = new URL('/api/user/email-aliases/verify', appOrigin);
      verifyUrl.searchParams.set('token', verificationToken);
      verifyUrl.searchParams.set('id', alias.id);

      try {
        const delivery = await resend.emails.send({
          from: outboundEmail.from,
          to: normalizedEmail,
          subject: `Verify your email alias - ${productName}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 20px;">
              <h1 style="color: #1a1a1a; font-size: 24px; margin-bottom: 24px;">Verify your email alias</h1>
              <p style="color: #4a4a4a; font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
                You requested to add this email address as an alias to your ${productName} account.
                Click the button below to verify this email and enable sign-in with it.
              </p>
              <a href="${verifyUrl.toString()}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 500;">
                Verify Email
              </a>
              <p style="color: #888; font-size: 14px; margin-top: 24px;">
                This link will expire in 24 hours. If you didn't request this, you can safely ignore this email.
              </p>
            </div>
          `,
        });
        if (delivery.error) {
          throw new Error('delivery_failed');
        }
      } catch {
        logger.error('Email send failed — rolling back alias', {
          userId,
          aliasId: alias.id,
          provider: 'resend',
          reason: 'delivery_failed',
        });
        await prisma.$transaction([
          prisma.verificationToken.deleteMany({
            where: { identifier: `alias:${alias.id}` },
          }),
          prisma.userEmail.delete({ where: { id: alias.id } }),
        ]).catch((cleanupError) => {
          logger.error('Email alias cleanup failed', {
            userId,
            aliasId: alias.id,
            error: String(cleanupError),
          });
        });
        return NextResponse.json(
          { error: 'Could not send verification email. Please try again.' },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      alias: {
        id: alias.id,
        email: alias.email,
        verified: alias.verified,
        label: alias.label,
      },
      message: 'Verification email sent. Please check your inbox.',
    });
  } catch (error) {
    logger.error('Failed to add email alias', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Failed to add email alias' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    const { searchParams } = new URL(request.url);
    const aliasId = searchParams.get('id');

    if (!aliasId) {
      return NextResponse.json({ error: 'Alias ID is required' }, { status: 400 });
    }

    // Verify the alias belongs to this user
    const alias = await prisma.userEmail.findFirst({
      where: {
        id: aliasId,
        userId,
      },
    });

    if (!alias) {
      return NextResponse.json({ error: 'Alias not found' }, { status: 404 });
    }

    // Delete the alias
    await prisma.userEmail.delete({
      where: { id: aliasId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete email alias', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Failed to delete email alias' },
      { status: 500 }
    );
  }
}
