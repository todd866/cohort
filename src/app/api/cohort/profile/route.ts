import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireAuthOrExistingGuest, requireAuthOrGuest } from '@/lib/api-utils';
import { checkUserRateLimit } from '@/lib/rate-limit';
import {
  COHORT_DEFAULT_DEMAND_TOPICS,
  COHORT_PUBLIC_SESSION_TYPES,
  hasSameCohortDemandSelection,
  isCohortDeep,
  mergeCohortFeedProfile,
  parseCohortFeedProfile,
  toStoredFeedProfile,
} from '@/lib/cohort/feed-profile';
import { parseCohortProfilePatch } from '@/lib/cohort/profile-patch';
import { loadCohortSearchTopics } from '@/lib/cohort/search-topic-registry.server';
import { isCohortHostname } from '@/lib/institution';

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
} as const;
const MAX_PROFILE_PATCH_CHARS = 2_048;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
  response.headers.append('Vary', 'Cookie');
  return response;
}

function requireCohortHost(request: NextRequest): NextResponse | null {
  return isCohortHostname(new URL(request.url).hostname)
    ? null
    : json({ error: 'Not found' }, 404);
}

function publicCohortResponseWhere(userId: string) {
  return {
    userId,
    // These values are assigned only by the opaque public Step 1 writer. Keep
    // historical public grades eligible even after a release manifest rotates.
    sessionType: { in: [...COHORT_PUBLIC_SESSION_TYPES] },
  };
}

async function loadDepth(userId: string, now: Date): Promise<{
  deep: boolean;
  publicGradedCount: number;
}> {
  const where = publicCohortResponseWhere(userId);
  const [publicGradedCount, first] = await Promise.all([
    prisma.questionResponse.count({ where }),
    prisma.questionResponse.findFirst({
      where,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  return {
    publicGradedCount,
    deep: isCohortDeep({
      publicGradedCount,
      firstPublicGradedAt: first?.createdAt ?? null,
      now,
    }),
  };
}

export async function GET(request: NextRequest) {
  const hostFailure = requireCohortHost(request);
  if (hostFailure) return hostFailure;
  const auth = await requireAuthOrGuest(request);
  if (auth.response) return privateResponse(auth.response);

  const limit = await checkUserRateLimit(auth.userId, 'cohort-profile', 30, 60_000);
  if (!limit.ok) {
    return json({ error: 'Too many requests' }, 429);
  }

  const [user, depth, searchTopics] = await Promise.all([
    prisma.user.findUnique({
      where: { id: auth.userId },
      select: { feedProfile: true },
    }),
    loadDepth(auth.userId, new Date()),
    loadCohortSearchTopics(),
  ]);
  const profile = parseCohortFeedProfile(user?.feedProfile);
  return json({
    profile,
    ...depth,
    demandTopics: COHORT_DEFAULT_DEMAND_TOPICS,
    searchTopics,
  });
}

async function readBoundedJson(request: NextRequest): Promise<unknown> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROFILE_PATCH_CHARS) {
    throw new RangeError('Profile patch is too large');
  }
  const body = await request.text();
  if (body.length > MAX_PROFILE_PATCH_CHARS) {
    throw new RangeError('Profile patch is too large');
  }
  return JSON.parse(body) as unknown;
}

export async function PATCH(request: NextRequest) {
  const hostFailure = requireCohortHost(request);
  if (hostFailure) return hostFailure;
  const auth = await requireAuthOrExistingGuest();
  if (auth.response) return privateResponse(auth.response);

  const limit = await checkUserRateLimit(auth.userId, 'cohort-profile-write', 20, 60_000);
  if (!limit.ok) {
    return json({ error: 'Too many requests' }, 429);
  }

  let raw: unknown;
  try {
    raw = await readBoundedJson(request);
  } catch (error) {
    return error instanceof RangeError
      ? json({ error: 'Profile patch is too large' }, 413)
      : json({ error: 'Invalid JSON' }, 400);
  }
  const patch = parseCohortProfilePatch(raw);
  if (!patch) return json({ error: 'Invalid profile patch' }, 400);

  const now = new Date();
  const nowIso = now.toISOString();
  const next = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${auth.userId} FOR UPDATE
    `;
    if (locked.length === 0) return null;

    const user = await tx.user.findUnique({
      where: { id: auth.userId },
      select: { feedProfile: true },
    });
    if (!user) return null;

    const current = parseCohortFeedProfile(user.feedProfile);
    const hookChanged = patch.hookCompleted === true && !current.hookCompletedAt;
    const experienceChanged = Boolean(
      patch.experience && patch.experience !== current.explicit.experience,
    );
    const demandChanged = Boolean(
      patch.demand
      && !hasSameCohortDemandSelection(current.explicit.demand, patch.demand),
    );
    const nextProfile = mergeCohortFeedProfile(current, {
      ...(hookChanged ? { hookCompletedAt: nowIso } : {}),
      ...(experienceChanged && patch.experience ? { experience: patch.experience } : {}),
      ...(demandChanged && patch.demand ? {
        demand: {
          topics: patch.demand.topics,
          askedAt: nowIso,
          ...(patch.demand.dismissed ? { dismissed: true } : {}),
        },
      } : {}),
    }, nowIso);

    // Always rewrite through the safe serializer: this moves legacy prose out
    // of explicit.demand even when this request is otherwise an exact retry.
    await tx.user.update({
      where: { id: auth.userId },
      data: {
        feedProfile: toStoredFeedProfile(user.feedProfile, nextProfile) as Prisma.InputJsonValue,
      },
    });

    if (experienceChanged && patch.experience) {
      await tx.feedEvent.create({
        data: {
          userId: auth.userId,
          eventType: 'profile_answer',
          itemId: 'cohort-experience-v1',
          itemType: 'profiling',
          result: patch.experience,
        },
      });
    }
    if (demandChanged && patch.demand) {
      await tx.feedEvent.create({
        data: {
          userId: auth.userId,
          eventType: 'profile_answer',
          itemId: 'cohort-demand-v1',
          itemType: 'profiling',
          result: patch.demand.dismissed ? 'dismissed' : patch.demand.topics.join(','),
          metadata: {
            schemaVersion: 2,
            topics: patch.demand.topics,
            dismissed: patch.demand.dismissed === true,
          },
        },
      });
    }
    return nextProfile;
  });

  if (!next) return json({ error: 'Profile identity not found' }, 404);

  const [depth, searchTopics] = await Promise.all([
    loadDepth(auth.userId, now),
    loadCohortSearchTopics(),
  ]);
  return json({
    profile: next,
    ...depth,
    demandTopics: COHORT_DEFAULT_DEMAND_TOPICS,
    searchTopics,
  });
}
