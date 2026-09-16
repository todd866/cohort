/**
 * Minimal User API - Fast endpoint for essential user data
 *
 * Returns only what's needed for page routing/display:
 * - institution
 * - track
 * - enabledModules
 * - activeModules
 *
 * Use this instead of /api/user when you don't need full stats.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireAuthOrExistingGuest } from '@/lib/api-utils';
import { viewerCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import { authorizedReviewTopicRotations } from '@/lib/review/review-topic-registry.server';

function isMd3Hostname(hostname: string): boolean {
  const host = hostname.toLowerCase().split(':')[0];
  return host === 'md3.info' || host === 'www.md3.info';
}

// Guests included. This is the read behind useUserMinimal, which feeds
// useActiveModules and useUserTrack — i.e. what the review page uses to decide
// whether the rotation chooser is still needed. Guests can answer that chooser
// now, so refusing them here means the saved answer never comes back and the
// chooser re-opens on every load. Read-only, so the existing-guest variant
// never mints a User row for an anonymous caller.
export async function GET(request: NextRequest) {
  const auth = await requireAuthOrExistingGuest();
  // No session and no guest cookie is the ordinary state of a first-time
  // visitor, not an error. Returning an empty context (like
  // /api/modules/active does) keeps the client on its localStorage fallback
  // without throwing on every anonymous first paint.
  if (auth.response) {
    return NextResponse.json({
      institution: null,
      track: null,
      enabledModules: [],
      activeModules: [],
      reviewTopicRotations: {},
    });
  }
  const userId = auth.userId;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        institution: true,
        track: true,
        enabledModules: true,
        activeModules: true,
        imageTier: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const activeModules = user.activeModules.filter((rotation) =>
      viewerCanAccessPersonalRotation(rotation, {
        emails: [user.email],
        imageTier: user.imageTier ?? null,
      })
    );

    return NextResponse.json({
      institution: user.institution,
      track: user.track,
      enabledModules: user.enabledModules,
      activeModules,
      reviewTopicRotations: isMd3Hostname(request.headers.get('host') ?? '')
        ? authorizedReviewTopicRotations(activeModules)
        : {},
    });
  } catch (error) {
    logger.error('Minimal user fetch error', { userId, error: String(error) });
    return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
  }
}
