import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

/**
 * Seed initial study queue based on institution.
 * For USMLE: Seeds Step 1 content.
 * For the primary clinical institution: seeds critical-care or first rotation in track.
 * Failure is non-fatal — profile update still succeeds.
 */
export async function seedInitialQueue(
  userId: string,
  institution: string,
  options: { resetExistingProgress?: boolean } = {}
) {
  const TARGET_CARDS = 200;
  const resetExistingProgress = options.resetExistingProgress === true;

  try {
    if (resetExistingProgress) {
      await prisma.cardProgress.deleteMany({ where: { userId } });
    }

    let rotationPriority: string[];

    if (institution === 'usmle') {
      rotationPriority = ['usmle-step1'];
    } else if (institution === 'usyd') {
      rotationPriority = ['critical-care', 'paam', 'cah', 'pwh'];
    } else {
      rotationPriority = ['critical-care'];
    }

    let seededCount = 0;
    const now = new Date();

    for (const rotation of rotationPriority) {
      if (seededCount >= TARGET_CARDS) break;

      const remaining = TARGET_CARDS - seededCount;
      const cards = await prisma.card.findMany({
        where: {
          rotation,
          deletedAt: null,
        },
        take: remaining,
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      if (cards.length > 0) {
        await prisma.cardProgress.createMany({
          data: cards.map(card => ({
            cardId: card.id,
            userId,
            retrievalStrength: 0,
            stabilityDays: 1,
            totalReviews: 0,
            correctCount: 0,
            nextDueAt: now,
            lastReview: null,
            lastQuality: null,
            status: 'learning',
          })),
          skipDuplicates: true,
        });
        seededCount += cards.length;
      }
    }

    logger.info('Seeded initial queue', {
      userId,
      institution,
      seededCount,
      resetExistingProgress,
    });
  } catch (error) {
    logger.error('Failed to seed initial queue', { userId, institution, error: String(error) });
  }
}
