import type { Prisma } from '@prisma/client';

export const BRIDGE_CARD_REPEAT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface BridgeCardProgress {
  status: string;
  lastReview: Date | null;
  nextDueAt: Date;
}

/** A weak parent MCQ does not make an already-reviewed prerequisite due again. */
export function isBridgeCardEligible(
  progress: BridgeCardProgress | undefined,
  now: Date,
): boolean {
  if (!progress) return true;
  if (progress.lastReview
    && progress.lastReview.getTime() >= now.getTime() - BRIDGE_CARD_REPEAT_COOLDOWN_MS) {
    return false;
  }
  return progress.nextDueAt.getTime() <= now.getTime();
}

/** Used by BOTH bridge tiers before limiting the candidate window. */
export function bridgeCardBlockedProgressWhere(
  userId: string,
  now: Date,
): Prisma.CardProgressWhereInput {
  return {
    userId,
    OR: [
      { lastReview: { gte: new Date(now.getTime() - BRIDGE_CARD_REPEAT_COOLDOWN_MS) } },
      { nextDueAt: { gt: now } },
    ],
  };
}
