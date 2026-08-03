import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

const OPEN_STATUSES = ['open', 'in-progress'] as const;
const CACHE_TTL_MS = 60_000;

type ExclusionSnapshot = {
  loadedAt: number;
  cardIds: Set<string>;
  questionIds: Set<string>;
};

let cached: ExclusionSnapshot | null = null;

function cloneSet(values: Set<string>): Set<string> {
  return new Set(values);
}

function emptyExclusions() {
  return { cardIds: new Set<string>(), questionIds: new Set<string>() };
}

function exclusionsFromSnapshot(snapshot: ExclusionSnapshot) {
  return {
    cardIds: cloneSet(snapshot.cardIds),
    questionIds: cloneSet(snapshot.questionIds),
  };
}

export async function getOpenIssueExclusions(): Promise<{
  cardIds: Set<string>;
  questionIds: Set<string>;
}> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
    return exclusionsFromSnapshot(cached);
  }

  try {
    const issues = await prisma.contentIssue.findMany({
      where: {
        status: { in: [...OPEN_STATUSES] },
      },
      select: {
        targetType: true,
        targetId: true,
      },
    });

    const directCardIds = new Set<string>();
    const directQuestionIds = new Set<string>();

    for (const issue of issues) {
      if (issue.targetType === 'card') directCardIds.add(issue.targetId);
      if (issue.targetType === 'question') directQuestionIds.add(issue.targetId);
    }

    const [questionLinks, cardLinks] = await Promise.all([
      directQuestionIds.size > 0
        ? prisma.question.findMany({
            where: { id: { in: [...directQuestionIds] } },
            select: { id: true, cardId: true },
          })
        : Promise.resolve([]),
      directCardIds.size > 0
        ? prisma.card.findMany({
            where: { id: { in: [...directCardIds] } },
            select: { id: true, question: { select: { id: true } } },
          })
        : Promise.resolve([]),
    ]);

    const cardIds = new Set(directCardIds);
    const questionIds = new Set(directQuestionIds);

    for (const q of questionLinks) {
      if (q.cardId) cardIds.add(q.cardId);
    }
    for (const c of cardLinks) {
      if (c.question?.id) questionIds.add(c.question.id);
    }

    cached = {
      loadedAt: now,
      cardIds,
      questionIds,
    };

    return exclusionsFromSnapshot(cached);
  } catch (error) {
    logger.warn('Failed to refresh open issue exclusions', {
      error: String(error),
      fallback: cached ? 'stale-snapshot' : 'empty-exclusions',
      cacheAgeMs: cached ? Math.max(0, now - cached.loadedAt) : null,
      cachedCardCount: cached?.cardIds.size ?? 0,
      cachedQuestionCount: cached?.questionIds.size ?? 0,
    });
    if (cached) return exclusionsFromSnapshot(cached);
    return emptyExclusions();
  }
}
