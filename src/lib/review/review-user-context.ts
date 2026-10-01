import 'server-only';

import { prisma } from '@/lib/prisma';
import type { Institution } from '@/lib/institution';
import { isSupportedInstitution } from '@/lib/institution';
import {
  getActiveRotations,
  type TrackNumber,
} from '@/lib/rotation-context';
import { viewerCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import type { ReviewUserContext } from './bootstrap-types';
import { authorizedReviewTopicRotations } from './review-topic-registry.server';

export type { ReviewUserContext };

/**
 * Cheap authenticated prefs snapshot for the review page.
 *
 * Used when the batch bootstrap is skipped (ordinary mixed feed) so the client
 * does not wait on `/api/user/minimal` before painting the first card.
 */
export async function loadReviewUserContext(args: {
  userId: string;
  institutionOverride?: Institution | null;
  /** Only md3.info may receive the private topic registry. */
  includePrivateReviewTopics?: boolean;
}): Promise<ReviewUserContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      email: true,
      institution: true,
      track: true,
      activeModules: true,
      imageTier: true,
    },
  });
  if (!user) return null;

  const persistedInstitution = isSupportedInstitution(user.institution)
    ? user.institution
    : 'usyd';
  const institution = args.institutionOverride ?? persistedInstitution;
  const track = Number.isInteger(user.track) && user.track! >= 1 && user.track! <= 4
    ? user.track as TrackNumber
    : null;
  const activeModules = user.activeModules.filter((rotation) =>
    viewerCanAccessPersonalRotation(rotation, {
      emails: [user.email],
      imageTier: user.imageTier ?? null,
    })
  );
  const activeRotations = track ? getActiveRotations(track) : [];

  return {
    ownerKey: args.userId,
    institution,
    track,
    activeModules,
    activeRotations,
    reviewTopicRotations: args.includePrivateReviewTopics
      ? authorizedReviewTopicRotations(activeModules)
      : {},
  };
}
