/**
 * Leech Regeneration
 *
 * When a card is leech-suppressed, find alternative cards covering
 * the same topic, or flag the concept for content regeneration.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export interface LeechAlternativeResult {
  /** Alternative cards that cover the same topic */
  alternatives: Array<{ id: string }>;
  /** True if no alternatives found and content needs regeneration */
  needsRegeneration: boolean;
  /** The leech card's concept ID (for flagging) */
  conceptId: string | null;
}

/**
 * Find alternative cards for a leech-suppressed card.
 *
 * Looks for other cards on the same topics that the user hasn't also
 * leeched. If none exist, flags the concept for regeneration.
 */
export async function findLeechAlternatives(
  userId: string,
  leechCardId: string
): Promise<LeechAlternativeResult> {
  const leechCard = await prisma.card.findUnique({
    where: { id: leechCardId },
    select: { id: true, rotation: true, topics: true, conceptId: true },
  });

  if (!leechCard) {
    return { alternatives: [], needsRegeneration: false, conceptId: null };
  }

  if (leechCard.topics.length === 0) {
    return { alternatives: [], needsRegeneration: true, conceptId: leechCard.conceptId };
  }

  // Find other cards with overlapping topics in the same rotation
  const alternativeCards = await prisma.card.findMany({
    where: {
      id: { not: leechCardId },
      rotation: leechCard.rotation,
      deletedAt: null,
      topics: { hasSome: leechCard.topics },
    },
    select: { id: true },
    take: 5,
  });

  // Exclude cards that are also leech-suppressed for this user
  const leechSuppressed = alternativeCards.length > 0
    ? await prisma.cardProgress.findMany({
        where: {
          userId,
          cardId: { in: alternativeCards.map(c => c.id) },
          leechSuppressedUntil: { gt: new Date() },
        },
        select: { cardId: true },
      })
    : [];

  const suppressedIds = new Set(leechSuppressed.map(p => p.cardId));
  const validAlternatives = alternativeCards.filter(c => !suppressedIds.has(c.id));

  const needsRegeneration = validAlternatives.length === 0;

  if (needsRegeneration) {
    logger.info('Leech card has no alternatives, concept needs regeneration', {
      leechCardId,
      conceptId: leechCard.conceptId,
      topics: leechCard.topics,
    });
  }

  return {
    alternatives: validAlternatives,
    needsRegeneration,
    conceptId: leechCard.conceptId,
  };
}
