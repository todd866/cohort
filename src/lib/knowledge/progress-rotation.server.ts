import 'server-only';

import { prisma } from '@/lib/prisma';
import { isMd1Program, MD1_DECK } from '@/lib/md1-program';
import { viewerCanAccessPersonalRotation } from '@/lib/personal-rotation-access';
import { getCurrentRotation } from '@/lib/rotations';

/**
 * The rotation a learner's progress map (the profile topic heatmap, the exams
 * panel readiness and the tutor's brief) is drawn for: a first-year's MD1
 * deck, otherwise the calendar block from getCurrentRotation.
 *
 * The map carries sample card fronts, so the deck is chosen only when the live
 * deck-access check passes. User.institution is a self-chosen preference and
 * grants nothing: a first-year without the grant gets no map.
 */
export async function getProgressRotation(userId: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { institution: true, email: true, imageTier: true },
    });
    if (!isMd1Program(user?.institution)) return getCurrentRotation(userId);
    return viewerCanAccessPersonalRotation(MD1_DECK, {
      emails: [user?.email],
      imageTier: user?.imageTier ?? null,
    }) ? MD1_DECK : null;
  } catch {
    return null;
  }
}
