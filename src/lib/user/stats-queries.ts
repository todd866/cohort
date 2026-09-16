import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/** Strip JSX/MDX markup from topic names (e.g., <Term abbr="ENT" /> -> ENT) */
function stripJsxFromTopic(topic: string): string {
  let cleaned = topic.replace(/<Term\s+abbr="([^"]+)"\s*\/?>/gi, '$1');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  return cleaned.replace(/\s+/g, ' ').trim();
}

const TOPIC_BLOCKLIST = new Set(['Term', 'abbr', 'term']);

export interface ProfileStatsScope {
  /** Rotations hidden only when a query is broad (`rotation === null`). */
  excludeRotations?: readonly string[];
}

function broadRotationExclusions(
  rotation: string | null,
  scope?: ProfileStatsScope,
): string[] {
  return rotation ? [] : [...(scope?.excludeRotations ?? [])];
}

function rawRotationClause(rotation: string | null, excludedRotations: string[]) {
  if (rotation) return Prisma.sql`AND c.rotation = ${rotation}`;
  if (excludedRotations.length > 0) {
    return Prisma.sql`AND NOT (c.rotation = ANY(${excludedRotations}::text[]))`;
  }
  return Prisma.empty;
}

export async function getCardStats(
  userId: string,
  rotation: string | null,
  scope?: ProfileStatsScope,
) {
  const excludedRotations = broadRotationExclusions(rotation, scope);
  const broadRotationFilter = excludedRotations.length > 0
    ? { rotation: { notIn: excludedRotations } }
    : {};
  const cardFilter = rotation
    ? { rotation, deletedAt: null as Date | null, shelvedAt: null as Date | null }
    : {
        deletedAt: null as Date | null,
        shelvedAt: null as Date | null,
        ...broadRotationFilter,
      };

  const progressCardFilter = rotation
    ? { card: { rotation, deletedAt: null as Date | null, shelvedAt: null as Date | null } }
    : {
        card: {
          deletedAt: null as Date | null,
          shelvedAt: null as Date | null,
          ...broadRotationFilter,
        },
      };

  const [progress, totalCards, dueCards] = await Promise.all([
    prisma.cardProgress.aggregate({
      where: { userId, ...progressCardFilter },
      _count: true,
      _sum: { totalReviews: true },
      _avg: { retrievalStrength: true },
    }),
    prisma.card.count({ where: cardFilter }),
    prisma.cardProgress.count({
      where: {
        userId,
        nextDueAt: { lte: new Date() },
        ...progressCardFilter,
      },
    }),
  ]);

  return {
    cardsStudied: progress._count,
    totalCards,
    totalReviews: progress._sum.totalReviews || 0,
    averageMastery: Math.round((progress._avg.retrievalStrength || 0) * 100),
    dueCards,
    coverage: totalCards > 0 ? Math.round((progress._count / totalCards) * 100) : 0,
  };
}

export async function getRecentActivity(userId: string, scope?: ProfileStatsScope) {
  const excludedRotations = [...(scope?.excludeRotations ?? [])];
  const pageViewRotationFilter = excludedRotations.length > 0
    ? {
        OR: [
          { rotation: null },
          { rotation: { notIn: excludedRotations } },
        ],
      }
    : {};
  const reviewSessionRotationFilter = excludedRotations.length > 0
    ? { rotation: { notIn: excludedRotations } }
    : {};

  const [recentViews, recentReviews] = await Promise.all([
    prisma.pageView.findMany({
      where: { userId, ...pageViewRotationFilter },
      orderBy: { viewedAt: 'desc' },
      take: 10,
      select: {
        path: true,
        rotation: true,
        week: true,
        duration: true,
        viewedAt: true,
      },
    }),
    prisma.reviewSession.findMany({
      where: {
        userId,
        completedAt: { not: null },
        ...reviewSessionRotationFilter,
      },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        rotation: true,
        startedAt: true,
        completedAt: true,
        cardsReviewed: true,
      },
    }),
  ]);

  return {
    recentViews,
    recentReviews: recentReviews.map((r) => ({
      ...r,
      cardsCount: Array.isArray(r.cardsReviewed)
        ? (r.cardsReviewed as unknown[]).length
        : 0,
    })),
  };
}

export async function getWeeklyStats(userId: string) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const stats = await prisma.dailyStats.findMany({
    where: {
      userId,
      date: { gte: sevenDaysAgo },
    },
    orderBy: { date: 'asc' },
  });

  const result: Array<{
    date: string;
    cardsReviewed: number;
    studyTimeMin: number;
  }> = [];

  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    date.setHours(0, 0, 0, 0);
    const dateStr = date.toISOString().split('T')[0];

    const dayStats = stats.find(
      (s) => s.date.toISOString().split('T')[0] === dateStr
    );

    result.push({
      date: dateStr,
      cardsReviewed: dayStats?.cardsReviewed || 0,
      studyTimeMin: dayStats?.studyTimeMin || 0,
    });
  }

  return result;
}

/**
 * Get rotation stats in a single consolidated query.
 * Returns a Map of rotation -> { totalCards, studiedCards, avgMastery, dueCards }
 */
export async function getRotationStatsOptimized(userId: string): Promise<Map<string, {
  totalCards: number;
  studiedCards: number;
  avgMastery: number;
  dueCards: number;
}>> {
  const cardTotals = await prisma.card.groupBy({
    by: ['rotation'],
    where: {
      deletedAt: null,
      shelvedAt: null,
    },
    _count: true,
  });

  const progressStats = await prisma.$queryRaw<Array<{
    rotation: string;
    studied_count: bigint;
    avg_mastery: number | null;
    due_count: bigint;
  }>>`
    SELECT
      c.rotation,
      COUNT(cp.id) as studied_count,
      AVG(cp."retrievalStrength") as avg_mastery,
      SUM(CASE WHEN cp."nextDueAt" <= NOW() THEN 1 ELSE 0 END) as due_count
    FROM "Card" c
    LEFT JOIN "CardProgress" cp ON c.id = cp."cardId" AND cp."userId" = ${userId}
    WHERE c."deletedAt" IS NULL
      AND c."shelvedAt" IS NULL
      AND cp.id IS NOT NULL
    GROUP BY c.rotation
  `;

  const result = new Map<string, {
    totalCards: number;
    studiedCards: number;
    avgMastery: number;
    dueCards: number;
  }>();

  for (const ct of cardTotals) {
    result.set(ct.rotation, {
      totalCards: ct._count,
      studiedCards: 0,
      avgMastery: 0,
      dueCards: 0,
    });
  }

  for (const ps of progressStats) {
    const existing = result.get(ps.rotation);
    if (existing) {
      existing.studiedCards = Number(ps.studied_count);
      existing.avgMastery = ps.avg_mastery || 0;
      existing.dueCards = Number(ps.due_count);
    }
  }

  return result;
}

/**
 * Get concept-level mastery for knowledge gap analysis.
 */
export async function getConceptMastery(
  userId: string,
  rotation: string | null,
  scope?: ProfileStatsScope,
): Promise<{
  strong: Array<{ concept: string; mastery: number; cardCount: number }>;
  weak: Array<{ concept: string; mastery: number; cardCount: number }>;
  unseen: Array<{ concept: string; cardCount: number }>;
}> {
  const excludedRotations = broadRotationExclusions(rotation, scope);
  const rotationClause = rawRotationClause(rotation, excludedRotations);

  const topicMastery = await prisma.$queryRaw<Array<{
    topic: string;
    avg_mastery: number;
    card_count: bigint;
  }>>(Prisma.sql`
    SELECT
      unnest(c.topics) as topic,
      AVG(cp."retrievalStrength") as avg_mastery,
      COUNT(DISTINCT c.id) as card_count
    FROM "Card" c
    JOIN "CardProgress" cp ON c.id = cp."cardId"
    WHERE cp."userId" = ${userId}
    AND c."deletedAt" IS NULL
    AND c."shelvedAt" IS NULL
    ${rotationClause}
    GROUP BY topic
    HAVING COUNT(DISTINCT c.id) >= 2
    ORDER BY avg_mastery DESC
  `);

  const unseenTopics = await prisma.$queryRaw<Array<{
    topic: string;
    card_count: bigint;
  }>>(Prisma.sql`
    SELECT
      unnest(c.topics) as topic,
      COUNT(DISTINCT c.id) as card_count
    FROM "Card" c
    WHERE NOT EXISTS (
      SELECT 1 FROM "CardProgress" cp
      WHERE cp."cardId" = c.id AND cp."userId" = ${userId}
    )
    AND c."deletedAt" IS NULL
    AND c."shelvedAt" IS NULL
    ${rotationClause}
    GROUP BY topic
    HAVING COUNT(DISTINCT c.id) >= 3
    ORDER BY card_count DESC
    LIMIT 10
  `);

  const strong = topicMastery
    .filter(t => t.avg_mastery >= 0.7)
    .map(t => ({
      concept: stripJsxFromTopic(t.topic),
      mastery: Math.round(t.avg_mastery * 100),
      cardCount: Number(t.card_count),
    }))
    .filter(t => !TOPIC_BLOCKLIST.has(t.concept) && t.concept.length >= 2)
    .slice(0, 10);

  const weak = topicMastery
    .filter(t => t.avg_mastery < 0.5)
    .map(t => ({
      concept: stripJsxFromTopic(t.topic),
      mastery: Math.round(t.avg_mastery * 100),
      cardCount: Number(t.card_count),
    }))
    .filter(t => !TOPIC_BLOCKLIST.has(t.concept) && t.concept.length >= 2)
    .slice(0, 10);

  const unseen = unseenTopics
    .map(t => ({
      concept: stripJsxFromTopic(t.topic),
      cardCount: Number(t.card_count),
    }))
    .filter(t => !TOPIC_BLOCKLIST.has(t.concept) && t.concept.length >= 2);

  return { strong, weak, unseen };
}

/**
 * Get per-week progress for the current rotation.
 */
export async function getWeeklyProgress(userId: string, rotation: string | null): Promise<Array<{
  week: number | null;
  totalCards: number;
  studiedCards: number;
  coverage: number;
}>> {
  if (!rotation) return [];

  const [cardsByWeek, progressByWeek] = await Promise.all([
    prisma.card.groupBy({
      by: ['week'],
      where: { rotation, deletedAt: null, shelvedAt: null },
      _count: true,
    }),
    prisma.$queryRaw<Array<{ week: number | null; studied_count: bigint }>>`
      SELECT c.week, COUNT(cp.id) as studied_count
      FROM "Card" c
      JOIN "CardProgress" cp ON c.id = cp."cardId"
      WHERE c.rotation = ${rotation}
        AND c."deletedAt" IS NULL
        AND c."shelvedAt" IS NULL
        AND cp."userId" = ${userId}
      GROUP BY c.week
      ORDER BY c.week
    `,
  ]);

  const progressMap = new Map(progressByWeek.map(p => [p.week, Number(p.studied_count)]));

  return cardsByWeek
    .map(cw => {
      const total = cw._count;
      const studied = progressMap.get(cw.week) || 0;
      return {
        week: cw.week,
        totalCards: total,
        studiedCards: studied,
        coverage: total > 0 ? Math.round((studied / total) * 100) : 0,
      };
    })
    .sort((a, b) => (a.week ?? 0) - (b.week ?? 0));
}
