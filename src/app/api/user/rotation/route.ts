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
import { requireAuthOrExistingGuest, requireAuthOrGuest } from '@/lib/api-utils';
import { getCurrentBlockIndex, getRotationForTrack, BLOCKS, TRACKS, type TrackNumber } from '@/lib/rotation-context';
import { ROTATION_TO_MODULES } from '@/lib/study/unified-session-manifold-items';
import { PERSONAL_ROTATION_IDS } from '@/lib/rotations';
import { isSupplementaryRotation } from '@/lib/supplementary-rotations';

const VALID_ROTATIONS = ['critical-care', 'paam', 'cah', 'pwh'] as const;

/**
 * Rebuild activeModules around the rotation the learner is now in, keeping the
 * enrolments that are not part of any rotation.
 *
 * THE KEPT SET IS PERSONAL **AND** SUPPLEMENTARY. It used to be personal only,
 * and that silently un-enrolled two learners from the anatomy deck when Block 3
 * rolled over. anatomy is the one supplementary deck that is not also a personal
 * deck, so it was the only casualty — surgical-sciences and neurosurg sat beside
 * it in the same arrays and survived purely because they are personal decks too.
 * The damage looked impossible to attribute for that reason: no write path drops
 * exactly one of three ModuleNode-less slugs, and neither suspected endpoint can
 * produce that result.
 *
 * WHICH CALLER FIRED IS NOT ESTABLISHED, only that this function did — the array
 * order is the fingerprint. Both callers reach it. The GET auto-heal runs on a
 * plain read but only when the block index has moved, and the two invalidations
 * (2026-09-14 18:50 and 09:03) fall mid-Block-3, which began 17 August, so a
 * roll is not a plausible trigger for them. The POST path rebuilds
 * unconditionally whenever a rotation or track is set, which fits two learners
 * tripping it at different times on an ordinary day. Do not reason from "it
 * happens at block boundaries"; it happens whenever either caller runs.
 *
 * The general shape: this function decides what SURVIVES a rotation change, so
 * every category of non-rotation enrolment has to be named here. A category
 * nobody remembers is silently deleted from every user who has it. Adding a new
 * kind of deck means adding it to this predicate, and the two tests in
 * route.test.ts pin both categories so the next one fails loudly instead.
 */
function activeModulesForRotation(
  currentModules: readonly string[],
  rotationModules: readonly string[],
): string[] {
  const preserved = currentModules.filter(
    (moduleId) =>
      PERSONAL_ROTATION_IDS.includes(moduleId as (typeof PERSONAL_ROTATION_IDS)[number]) ||
      isSupplementaryRotation(moduleId),
  );
  return [...new Set(['usyd-md3', ...preserved, ...rotationModules])];
}

const rotationPostSchema = z.object({
  rotation: z.enum(VALID_ROTATIONS).nullable().optional(),
  track: z.number().int().min(1).max(4).nullable().optional(),
});

export async function GET() {
  // Guests too — this is where the track a guest chose comes back after the
  // chooser reloads the page. Read-only, so the existing-guest variant never
  // mints a row for an anonymous caller.
  const auth = await requireAuthOrExistingGuest();
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
  // Guests too. They are the ones deciding whether to register, and until they
  // do they were served a hardcoded default rotation — a CC student spent 48
  // minutes on paediatrics before anything asked what they study
  // (narutorox4all, 2026-08-23). requireAuthOrGuest rather than the
  // existing-guest variant because the chooser must work on a first visit,
  // before any read endpoint has minted a cookie; row creation stays behind
  // that helper's per-IP rate limit, and a deliberate tap is exactly the
  // moment a visitor is worth a row.
  const auth = await requireAuthOrGuest(request);
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
    const { rotation, track: requestedTrack } = parseResult.data;

    // A bare rotation choice (the onboarding chooser sends only {rotation})
    // still deserves a track: infer the track whose CURRENT block is that
    // rotation, so modules auto-heal at the next block change instead of the
    // user silently falling back to the default rotation again.
    let track = requestedTrack;
    if ((track === undefined || track === null) && rotation) {
      const blockIndex = getCurrentBlockIndex();
      const inferred = (Object.keys(TRACKS) as unknown as TrackNumber[]).find(
        (t) => TRACKS[t][blockIndex] === rotation,
      );
      if (inferred !== undefined) track = Number(inferred) as TrackNumber;
    }

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
