import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { withGuards } from '@/lib/with-guards';
import { logger } from '@/lib/logger';

const curriculumRequestSchema = z.object({
  description: z.string(),
});

const MAX_DESCRIPTION = 5000;

/**
 * "My course isn't on the list" — the one write that both records the answer
 * and stops the question.
 *
 * It does two things that belong together and were previously impossible to do
 * in one call. It files the learner's description in the `UserFeedback`
 * moderation queue under `onboarding-other`, where the morning check works it
 * into an actual feed (step 11c-bis); and it stamps
 * `User.curriculumRequestedAt`, which the review page reads to stop re-opening
 * the rotation chooser. Without the stamp, someone who had just told us their
 * whole situation was asked the same question on their next load, which reads
 * as not having been listened to.
 *
 * What it deliberately does NOT do is set a rotation. Guessing an enrolment
 * from prose is the bug the chooser exists to prevent, and this endpoint is the
 * path taken precisely by the people no rotation fits. They fall through to the
 * default feed until a human decides better.
 *
 * The prose is untrusted, so it goes only where untrusted prose already goes: a
 * queue a person reads. Nothing here interpolates it into a prompt, and the
 * trust boundary on `UserFeedback` continues to apply downstream.
 *
 * Guests are allowed (`auth: 'optional-existing-guest'` semantics via
 * withGuards' optional auth): they are the ones deciding whether md3 is worth
 * registering for, and `claimGuestProgressRecords` carries the stamp onto the
 * account they later create.
 */
export const POST = withGuards(
  async (request: NextRequest, { userId }) => {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = curriculumRequestSchema.safeParse(rawBody);
    const description = parsed.success ? parsed.data.description.trim() : '';
    if (!description) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 });
    }
    if (description.length > MAX_DESCRIPTION) {
      return NextResponse.json(
        { error: `Description too long (max ${MAX_DESCRIPTION.toLocaleString()} characters)` },
        { status: 400 },
      );
    }

    let email: string | null = null;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      email = user?.email ?? null;
    }

    await prisma.userFeedback.create({
      data: {
        userId,
        email,
        message: description,
        category: 'onboarding-other',
        path: '/review',
        userAgent: request.headers.get('user-agent') || null,
      },
    });

    // The stamp is secondary to the record: if it fails, the request is still
    // filed and a human still sees it. Losing the description because a write
    // to the user row failed would be the worse trade.
    if (userId) {
      try {
        await prisma.user.update({
          where: { id: userId },
          data: { curriculumRequestedAt: new Date() },
        });
      } catch (error) {
        logger.error('Curriculum request stamp failed', { userId, error: String(error) });
      }
    }

    return NextResponse.json({ success: true });
  },
  {
    auth: 'optional',
    rateLimit: { name: 'curriculum-request', limit: 5, windowMs: 60_000, byIp: true },
    errorLabel: 'curriculum-request',
  },
);
