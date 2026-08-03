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

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireAuth } from '@/lib/api-utils';
import { emailCanAccessPersonalRotation } from '@/lib/personal-rotation-access';

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
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
      },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({
      institution: user.institution,
      track: user.track,
      enabledModules: user.enabledModules,
      activeModules: user.activeModules.filter((rotation) =>
        emailCanAccessPersonalRotation(rotation, user.email)
      ),
    });
  } catch (error) {
    logger.error('Minimal user fetch error', { userId, error: String(error) });
    return NextResponse.json({ error: 'Failed to get user' }, { status: 500 });
  }
}
