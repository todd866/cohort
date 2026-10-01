import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { withGuards } from '@/lib/with-guards';

const helpPostSchema = z.object({
  message: z.string(),
  category: z.string().optional(),
  email: z.string().optional(),
  path: z.string().optional(),
});

/**
 * POST /api/help
 * Submit a help request / general feedback message.
 * This is a human support/moderation queue. Raw UserFeedback prose is never a
 * direct agent prompt or housekeeping work item; a future automation must add
 * an explicit reviewed promotion boundary before consuming it.
 *
 * Anonymous-allowed (auth: 'optional'), so it is IP-rate-limited to stop bots
 * flooding the UserFeedback table — that's a moderation burden, not a cost
 * concern. withGuards also sanitises unexpected errors to a generic 500.
 */
export const POST = withGuards(
  async (request: NextRequest, { userId }) => {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parseResult = helpPostSchema.safeParse(rawBody);
    if (!parseResult.success || parseResult.data.message.trim().length === 0) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }
    const { message, category, email, path } = parseResult.data;

    // Content uploads allow up to 50k characters, regular feedback allows 5k
    const isContentUpload =
      category && typeof category === 'string' && category.startsWith('upload-');
    const maxLength = isContentUpload ? 50000 : 5000;

    if (message.length > maxLength) {
      return NextResponse.json(
        { error: `Message too long (max ${maxLength.toLocaleString()} characters)` },
        { status: 400 }
      );
    }

    // Look up user email as fallback if authenticated and no email provided
    let feedbackEmail = email || null;
    if (!feedbackEmail && userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      feedbackEmail = user?.email || null;
    }

    const feedback = await prisma.userFeedback.create({
      data: {
        userId,
        email: feedbackEmail,
        message: message.trim(),
        category: category || 'general',
        path: path || null,
        userAgent: request.headers.get('user-agent') || null,
      },
    });

    return NextResponse.json({
      success: true,
      id: feedback.id,
    });
  },
  {
    auth: 'optional',
    rateLimit: { name: 'help', limit: 10, windowMs: 60_000, byIp: true },
    errorLabel: 'help',
  }
);
