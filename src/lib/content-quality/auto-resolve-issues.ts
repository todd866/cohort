/**
 * Auto-resolve ContentIssue records when content is modified.
 *
 * When a card or question is edited (detected via content hash change during
 * db:seed), open ContentIssue records against it are auto-resolved and user
 * flags are cleared. This prevents stale issues from accumulating forever.
 *
 * Called from prisma/seed.ts after version detection identifies changed content.
 */

import { prisma as defaultPrisma } from '@/lib/prisma';

type PrismaLike = typeof defaultPrisma;

export interface AutoResolveResult {
  issuesResolved: number;
  flagsCleared: number;
}

/**
 * Auto-resolve open ContentIssue records for content that has been modified.
 *
 * @param targetType - 'card' or 'question'
 * @param targetIds - IDs of cards/questions whose content changed
 * @param client - Optional Prisma client (used by seed script which has its own client)
 */
export async function autoResolveIssuesForChangedContent(
  targetType: 'card' | 'question',
  targetIds: string[],
  client?: PrismaLike
): Promise<AutoResolveResult> {
  if (targetIds.length === 0) {
    return { issuesResolved: 0, flagsCleared: 0 };
  }

  const db = client ?? defaultPrisma;
  const now = new Date();

  // Resolve all open/in-progress ContentIssue records for these targets
  const resolved = await db.contentIssue.updateMany({
    where: {
      targetType,
      targetId: { in: targetIds },
      status: { in: ['open', 'in-progress'] },
    },
    data: {
      status: 'resolved',
      resolvedAt: now,
      resolvedBy: 'auto-content-change',
      resolution: 'Content was modified after this issue was reported',
    },
  });

  // Clear user flags on the related progress records
  let flagsCleared = 0;

  if (targetType === 'card') {
    const cleared = await db.cardProgress.updateMany({
      where: {
        cardId: { in: targetIds },
        flagged: true,
      },
      data: {
        flagged: false,
      },
    });
    flagsCleared = cleared.count;
  } else {
    const cleared = await db.questionResponse.updateMany({
      where: {
        questionId: { in: targetIds },
        flagged: true,
      },
      data: {
        flagged: false,
      },
    });
    flagsCleared = cleared.count;
  }

  return {
    issuesResolved: resolved.count,
    flagsCleared,
  };
}
