/**
 * Pre-computed Study Queue
 *
 * Architecture:
 * - TIER 1 (instant): API reads from UserStudyQueue table
 * - TIER 2 (background): Recompute after reviews
 * - TIER 3 (cron/agents): Smart manifold analysis, pulling lead
 *
 * This module handles queue storage and focused-session retrieval.
 * Queue computation (computeStudyQueue, refreshStudyQueue, etc.) was
 * removed — those code paths had no external callers.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logger } from './logger';
import { filterDeliverableReinforcementCardRows } from './usmle/reinforcement-card-delivery';

// Full item data stored in queue - no second fetch needed at read time
export interface QueueItem {
  type: 'card' | 'question' | 'group';
  id: string;
  priority: number;
  reason: 'due' | 'weak' | 'new' | 'question' | 'group' | 'remediation' | 'reinforcement';
  // Card fields
  front?: string;
  back?: string;
  backs?: string[] | null;
  context?: string | null;
  sourceComponent?: string;
  rotation?: string;
  week?: number | null;
  clusterId?: string | null;
  complexity?: number;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
  // Question fields
  stem?: string;
  options?: Array<{ label: string; text: string; isCorrect: boolean }>;
  imageUrl?: string | null;
  // Option pools for varying displayed options
  combinations?: number[][] | null;
  correctVariants?: string[] | null;
  // Group fields (linked question groups - ECG, ABG, etc.)
  groupType?: string; // 'ecg', 'abg', 'cxr'
  contextImageUrl?: string | null;
  contextText?: string | null;
  steps?: unknown[]; // QuestionGroupStep[]
  diagnosisSummary?: string | null;
  difficulty?: string;
  topics?: string[];
}

/** Parse Prisma JSON column as QueueItem[] */
function parseQueueItems(json: unknown): QueueItem[] {
  return Array.isArray(json) ? (json as QueueItem[]) : [];
}

// Remediation injection tuning
const REMEDIATION_INSERT_OFFSET = 5; // Insert after a few items to avoid immediate repetition
const REMEDIATION_MAX_ITEMS = 2; // Drip remediation rather than flood

type QueueInsertOptions = {
  reason?: 'remediation' | 'reinforcement';
  insertOffset?: number;
  maxItems?: number;
};

export async function prependCardsToQueue(
  userId: string,
  rotation: string,
  cardIds: string[],
  options: QueueInsertOptions = {}
): Promise<void> {
  if (cardIds.length === 0) return;
  const reason = options.reason ?? 'remediation';
  const insertOffset = options.insertOffset ?? REMEDIATION_INSERT_OFFSET;
  const maxItems = options.maxItems ?? REMEDIATION_MAX_ITEMS;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const progressRows = await prisma.cardProgress.findMany({
    where: {
      userId,
      cardId: { in: cardIds },
    },
    select: {
      cardId: true,
      suppressed: true,
      status: true,
      viewsToday: true,
      viewsTodayDate: true,
    },
  });

  const progressById = new Map(progressRows.map((row) => [row.cardId, row]));
  const allowed = cardIds.filter((cardId) => {
    const progress = progressById.get(cardId);
    if (progress?.suppressed) return false;
    if (progress?.status === 'retired') return false;
    if (progress?.viewsTodayDate && progress.viewsTodayDate >= todayStart) {
      return (progress.viewsToday ?? 0) < 2;
    }
    return true;
  });

  const limitedIds = allowed.slice(0, maxItems);
  if (limitedIds.length === 0) return;

  const cards = await prisma.card.findMany({
    where: { id: { in: limitedIds }, deletedAt: null, cardType: { not: 'mcq' } },
    select: {
      id: true,
      front: true,
      back: true,
      backs: true,
      context: true,
      sourceComponent: true,
      rotation: true,
      week: true,
      clusterId: true,
      complexity: true,
      crosslinks: true,
    },
  });

  const queue = await prisma.userStudyQueue.findUnique({
    where: {
      userId_rotation: {
        userId,
        rotation,
      },
    },
    select: { items: true, itemCount: true },
  });

  if (!queue) {
    // Queue doesn't exist yet - skip injection
    return;
  }

  const existingItems = parseQueueItems(queue.items);
  // The JSON queue can outlive both source fixes and ORM extensions. Resolve
  // every card ID again before writing it back so stale relationless
  // `qcard:<protectedQuestionId>:fact:*` rows cannot survive in this cache.
  const boundaryCandidates = [
    ...cards.map((card) => ({ id: card.id })),
    ...existingItems
      .filter((item) => item.type === 'card')
      .map((item) => ({ id: item.id })),
  ];
  const deliverableIds = new Set(
    (await filterDeliverableReinforcementCardRows(boundaryCandidates, {
      logContext: { transport: 'user-study-queue' },
    })).map((row) => row.id),
  );

  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const orderedCards = limitedIds
    .map((id) => cardsById.get(id))
    .filter((card): card is NonNullable<typeof card> => (
      !!card && deliverableIds.has(card.id)
    ));

  const remediationItems: QueueItem[] = orderedCards.map((card) => ({
    type: 'card',
    id: card.id,
    priority: 0,
    reason,
    front: card.front,
    back: card.back,
    backs: card.backs as string[] | null,
    context: card.context,
    sourceComponent: card.sourceComponent ?? undefined,
    rotation: card.rotation,
    week: card.week,
    clusterId: card.clusterId,
    complexity: card.complexity,
    crosslinks: card.crosslinks as QueueItem['crosslinks'],
  }));

  const remediationIds = new Set(remediationItems.map((item) => item.id));
  const filtered = existingItems.filter(
    (item) => item.type !== 'card'
      || (deliverableIds.has(item.id) && !remediationIds.has(item.id))
  );

  if (remediationItems.length === 0 && filtered.length === existingItems.length) {
    return;
  }

  const insertAt = Math.min(insertOffset, filtered.length);
  const merged = [
    ...filtered.slice(0, insertAt),
    ...remediationItems,
    ...filtered.slice(insertAt),
  ];

  const maxLength = existingItems.length > 0 ? existingItems.length : merged.length;
  const trimmed = merged.slice(0, maxLength);
  const sanitized = JSON.parse(JSON.stringify(trimmed)) as QueueItem[];

  await prisma.userStudyQueue.update({
    where: {
      userId_rotation: {
        userId,
        rotation,
      },
    },
    data: {
      items: sanitized as unknown as Prisma.InputJsonValue,
      itemCount: sanitized.length,
    },
  });

  logger.info('Prepended queue cards', {
    userId,
    rotation,
    inserted: remediationItems.length,
    reason,
    offset: insertOffset,
    maxItems,
    queueLengthBefore: existingItems.length,
    queueLengthAfter: sanitized.length,
  });
}

/**
 * Get focused queue for specific group type (ECG-only, CXR-only, etc.)
 * This bypasses the normal queue system for dedicated practice sessions.
 */
export async function getFocusedQueue(
  userId: string,
  groupType: 'ecg' | 'cxr' | 'abg',
  options: { rotation?: string; limit?: number } = {}
): Promise<{ items: QueueItem[]; total: number }> {
  const { rotation, limit = 50 } = options;

  // Get all groups of this type, prioritizing least-seen
  const groups = await prisma.questionGroup.findMany({
    where: {
      type: groupType,
      ...(rotation ? { rotation } : {}),
    },
    select: {
      id: true,
      slug: true,
      type: true,
      contextImageUrl: true,
      contextText: true,
      steps: true,
      difficulty: true,
      topics: true,
      rotation: true,
      week: true,
      diagnosisSummary: true,
      totalAttempts: true,
    },
    orderBy: { totalAttempts: 'asc' }, // Least-seen first
    take: limit,
  });

  // Get user's recent attempts to deprioritize recently-seen
  const recentAttempts = await prisma.assessmentAttempt.findMany({
    where: {
      userId,
      attemptType: 'question-group',
      completedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24h
    },
    select: { targetId: true },
  });
  // Filter to only groups of the requested type
  const groupIds = groups.map(g => g.id);
  const recentIds = new Set(
    recentAttempts
      .filter(a => groupIds.includes(a.targetId))
      .map(a => a.targetId)
  );

  // Sort: unseen first, then by totalAttempts
  const sortedGroups = [...groups].sort((a, b) => {
    const aRecent = recentIds.has(a.id) ? 1 : 0;
    const bRecent = recentIds.has(b.id) ? 1 : 0;
    if (aRecent !== bRecent) return aRecent - bRecent;
    return (a.totalAttempts || 0) - (b.totalAttempts || 0);
  });

  // Convert to queue items
  const items: QueueItem[] = sortedGroups.map(group => ({
    type: 'group' as const,
    id: group.id,
    priority: 1,
    reason: 'group' as const,
    groupType: group.type,
    contextImageUrl: group.contextImageUrl,
    contextText: group.contextText,
    steps: group.steps as unknown[],
    diagnosisSummary: group.diagnosisSummary,
    difficulty: group.difficulty,
    topics: group.topics,
    rotation: group.rotation ?? undefined,
    week: group.week,
  }));

  // Get total count for this type
  const total = await prisma.questionGroup.count({
    where: {
      type: groupType,
      ...(rotation ? { rotation } : {}),
    },
  });

  return { items, total };
}
