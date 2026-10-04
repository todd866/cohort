import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-utils';
import { prisma } from '@/lib/prisma';
import { reviewChallengePreference } from '@/lib/study/review-challenge-preference';
import { isCohortHostname } from '@/lib/institution';
import { logger } from '@/lib/logger';

const select = { reviewChallenge: true, reviewChallengeRevision: true } as const;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie' },
  });
}

function requireCohortHost(request: NextRequest): NextResponse | null {
  return isCohortHostname(new URL(request.url).hostname)
    ? null
    : json({ error: 'Not found' }, 404);
}

function parsePatch(value: unknown): { level: number; expectedRevision: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || !Object.hasOwn(body, 'level') || !Object.hasOwn(body, 'expectedRevision')) return null;
  if (typeof body.level !== 'number' || !Number.isInteger(body.level) || body.level < -2 || body.level > 2
    || typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return null;
  return { level: body.level, expectedRevision: body.expectedRevision };
}

export async function GET(request: NextRequest) {
  const hostFailure = requireCohortHost(request);
  if (hostFailure) return hostFailure;
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  try {
    const user = await prisma.user.findUnique({ where: { id: auth.userId }, select });
    if (!user) return json({ error: 'Authentication required' }, 401);
    return json(reviewChallengePreference(user));
  } catch (error) {
    logger.error('Cohort review difficulty read failed', { error: String(error) });
    return json({ error: 'Difficulty is temporarily unavailable.' }, 503);
  }
}

export async function PATCH(request: NextRequest) {
  const hostFailure = requireCohortHost(request);
  if (hostFailure) return hostFailure;
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid difficulty.' }, 400); }
  const patch = parsePatch(body);
  if (!patch) {
    return json({ error: 'Invalid difficulty or revision.' }, 400);
  }
  const { level, expectedRevision } = patch;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id: auth.userId }, select });
      if (!current || current.reviewChallengeRevision !== expectedRevision) return { changed: false, user: current };
      if (current.reviewChallenge === level) return { changed: true, user: current };
      const changed = await tx.user.updateMany({
        where: { id: auth.userId, reviewChallengeRevision: expectedRevision },
        data: { reviewChallenge: level, reviewChallengeRevision: { increment: 1 } },
      });
      const user = await tx.user.findUnique({ where: { id: auth.userId }, select });
      return { changed: changed.count > 0, user };
    });
    if (!result.user) return json({ error: 'Authentication required' }, 401);
    const preference = reviewChallengePreference(result.user);
    return json(result.changed ? preference : {
      ...preference, error: 'Difficulty changed elsewhere. Please try again.',
    }, result.changed ? 200 : 409);
  } catch (error) {
    logger.error('Cohort review difficulty save failed', { error: String(error) });
    return json({ error: 'Could not save difficulty. Please retry.' }, 503);
  }
}
