/**
 * User Rotation Preference API
 *
 * GET - Get user's current rotation and track
 * POST - Set user's current rotation (and inferred track)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { requireAuth } from '@/lib/api-utils';
import { getCurrentBlockIndex, getRotationForTrack, BLOCKS, TRACKS, type TrackNumber } from '@/lib/rotation-context';
import { ROTATION_TO_MODULES } from '@/lib/study/unified-session-manifold-items';
import { PERSONAL_ROTATION_IDS } from '@/lib/rotations';

const VALID_ROTATIONS = ['critical-care', 'paam', 'cah', 'pwh'] as const;

function activeModulesForRotation(
  currentModules: readonly string[],
  rotationModules: readonly string[],
): string[] {
  const personalModules = currentModules.filter((moduleId) =>
    PERSONAL_ROTATION_IDS.includes(moduleId as (typeof PERSONAL_ROTATION_IDS)[number])
  );
  return [...new Set(['usyd-md3', ...personalModules, ...rotationModules])];
}

const rotationPostSchema = z.object({
  rotation: z.enum(VALID_ROTATIONS).nullable().optional(),
  track: z.number().int().min(1).max(4).nullable().optional(),
});

export async function GET() {
  const auth = await requireAuth();
  if (auth.response) return auth.response;
  const userId = auth.userId;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { track: true, activeModules: true },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // If user has a track, derive current rotation from it
    let currentRotation: string | null = null;
    if (user.track) {
      const blockIndex = getCurrentBlockIndex();
      currentRotation = getRotationForTrack(user.track as TrackNumber, blockIndex);
    }

    // Auto-heal stale modules: if modules don't include the current rotation's
    // modules, update them. Prevents "all cards reviewed" when blocks change.
    if (currentRotation) {
      const expected = ROTATION_TO_MODULES[currentRotation] || [];
      const current = (user.activeModules as string[]) || [];
      const hasExpected = expected.length === 0 ||
        expected.some(m => current.includes(m));
      if (!hasExpected && expected.length > 0) {
        const nextModules = activeModulesForRotation(current, expected);
        await prisma.user.update({
          where: { id: userId },
          data: { activeModules: nextModules },
        });
        logger.info('Auto-healed stale modules', { userId, from: current, to: nextModules });
      }
    }

    return NextResponse.json({
      track: user.track,
      currentRotation,
    });
  } catch (error) {
    logger.error('Error fetching rotation', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Internal server error' },
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
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      );
    }

    const parseResult = rotationPostSchema.safeParse(rawBody);
    if (!parseResult.success) {
      const hasRotationIssue = parseResult.error.issues.some(
        (issue) => issue.path[0] === 'rotation'
      );
      if (hasRotationIssue) {
        return NextResponse.json(
          { error: 'Invalid rotation' },
          { status: 400 }
        );
      }

      const hasTrackIssue = parseResult.error.issues.some(
        (issue) => issue.path[0] === 'track'
      );
      if (hasTrackIssue) {
        return NextResponse.json(
          { error: 'Invalid track (must be 1-4)' },
          { status: 400 }
        );
      }

      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { rotation, track } = parseResult.data;

    // Update user's track
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { track: track === undefined ? undefined : track },
      select: { track: true, activeModules: true },
    });

    // Auto-create UserRotation records from block calendar when track is set
    if (track !== undefined && track !== null) {
      const trackRotations = TRACKS[track as TrackNumber];
      await Promise.all(
        BLOCKS.map((block, blockIndex) => {
          const rotationId = trackRotations[blockIndex];
          return prisma.userRotation.upsert({
            where: { userId_rotation: { userId, rotation: rotationId } },
            create: {
              userId,
              rotation: rotationId,
              startDate: block.start,
              examDate: block.exam,
            },
            // Don't overwrite user-customised exam dates
            update: {},
          });
        })
      );
    }

    // Derive current rotation from the newly-set track
    const blockIndex = getCurrentBlockIndex();
    const currentRotation = track
      ? getRotationForTrack(track as TrackNumber, blockIndex)
      : rotation ?? null;

    // Auto-sync active modules to match the current rotation so the session
    // filter doesn't blank out cards. Without this, modules stay stale from
    // the previous rotation and block all content.
    if (currentRotation) {
      const rotationModules = ROTATION_TO_MODULES[currentRotation] || [];
      if (rotationModules.length > 0) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            activeModules: activeModulesForRotation(
              (updatedUser.activeModules as string[]) || [],
              rotationModules,
            ),
          },
        });
      }
    }

    return NextResponse.json({
      track: updatedUser.track,
      currentRotation,
    });
  } catch (error) {
    logger.error('Error updating rotation', { userId, error: String(error) });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
