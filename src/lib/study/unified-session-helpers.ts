import { after } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { shuffle } from '@/lib/utils/shuffle';
import { isUsableQuestion } from '@/lib/question-validation';
import type { UnifiedItem, InstantQuestionCandidate } from './unified-session-types';
import { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE } from './unified-session-types';
import { tierFromComplexity } from '@/lib/audit/walk-metadata';

export function parseBatchSize(sizeParam: string | null): number {
  if (!sizeParam) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(sizeParam, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

export function compactMetadata(metadata: Record<string, unknown>): Prisma.InputJsonValue {
  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  ) as Prisma.InputJsonValue;
}

export function interleaveGroups(items: UnifiedItem[], groups: UnifiedItem[], gap: number = 5): UnifiedItem[] {
  if (groups.length === 0) return items;
  const result: UnifiedItem[] = [];
  const groupQueue = [...groups];
  let idx = 0;

  while (idx < items.length || groupQueue.length > 0) {
    // Insert one group at the start if we have none yet
    if (result.length === 0 && groupQueue.length > 0) {
      result.push(groupQueue.shift()!);
    }

    // Add up to gap items
    for (let i = 0; i < gap && idx < items.length; i++) {
      result.push(items[idx++]);
    }

    // Insert a group between chunks
    if (groupQueue.length > 0) {
      result.push(groupQueue.shift()!);
    }

    if (idx >= items.length && groupQueue.length > 0 && result.length > 0) {
      // Append any leftover groups at the end
      result.push(...groupQueue.splice(0));
    }
  }

  return result;
}

export function isPreferredInstantQuestion(questionId: string, rotation: string): boolean {
  // Critical care has a curated bank that should be preferred over legacy imports.
  if (rotation === 'critical-care') {
    return questionId.startsWith('bank:critical-care:');
  }
  return true;
}

export function selectInstantQuestionCandidates(
  questions: InstantQuestionCandidate[],
  options: {
    rotation: string;
    weekFilter: number | null;
    clientExcludeQuestionSet: Set<string>;
    globallyExcludedQuestionIds: Set<string>;
  }
): InstantQuestionCandidate[] {
  const usable = questions.filter((question) => {
    if (options.weekFilter !== null && question.week !== options.weekFilter) return false;
    if (options.clientExcludeQuestionSet.has(question.id)) return false;
    if (options.globallyExcludedQuestionIds.has(question.id)) return false;
    return isUsableQuestion(question);
  });

  const preferred = usable.filter((question) =>
    isPreferredInstantQuestion(question.id, options.rotation)
  );
  return preferred.length > 0 ? preferred : usable;
}

/** Log content_exposed events in the background for a batch of items. */
export function logExposures(
  items: UnifiedItem[],
  opts: { userId: string; rotation: string; queueType: string; batchId: string; sessionId: string; anonymousSessionId?: string; feedMode?: 'new-only' | 'mixed' },
) {
  if (items.length === 0) return;
  const events = items.map((item, index) => ({
    userId: opts.userId,
    eventType: 'content_exposed',
    sourceType: item.type,
    sourceId: item.id,
    conceptIds: [],
    rotation: opts.rotation,
    week: item.week ?? null,
    metadata: compactMetadata({
      queueReason: item.interventionReason ?? opts.queueType,
      queueType: opts.queueType,
      priority: item.priority,
      position: index,
      batchSize: items.length,
      batchId: opts.batchId,
      sessionId: opts.sessionId,
      itemType: item.type,
      conceptName: item.conceptName,
      anonymousSessionId: opts.anonymousSessionId,
      // Walk decision context (Phase 1 of scheduler-walk-audit)
      servedBy: item.servedBy,
      clusterId: item.clusterId,
      predictedRecall: item.predictedRecall,
      predictedRecallModel: item.predictedRecallModel,
      predictedRecallSource: item.predictedRecallSource,
      predictedRecallStatus: item.predictedRecallStatus,
      difficultyTier:
        item.servedBy === undefined
          ? undefined
          : item.difficultyTier ?? tierFromComplexity(item.complexity),
      poolSize: item.poolSize,
      positionInSession: item.servedBy !== undefined ? (item.positionInSession ?? index) : undefined,
      similarityToPrior: item.similarityToPrior,
      // Feed-mode tag lets walk-audit suppress pool-constrained pathologies
      // for new-only sessions. See @/lib/audit/walk-pathologies.
      feedMode: opts.feedMode ?? 'mixed',
      // Cloze-variant group id lets walk-audit detect `variant-sibling-repeat`
      // (a regression in scheduler suppression). See @/lib/audit/walk-pathologies.
      variantGroupId: item.variantGroupId,
    }),
  }));
  after(async () => {
    try {
      await prisma.learningEvent.createMany({ data: events });
    } catch (err) {
      logger.error('Failed to log exposures', { userId: opts.userId, rotation: opts.rotation, queueType: opts.queueType, error: String(err) });
    }
  });
}

const GROUP_SELECT = {
  id: true,
  type: true,
  contextImageUrl: true,
  contextText: true,
  steps: true,
  difficulty: true,
  topics: true,
  rotation: true,
  week: true,
  diagnosisSummary: true,
} as const;

/**
 * Fetch question group items in parallel. Extracted so the queries can
 * start before the scheduler completes.
 */
export async function fetchGroupItems(
  rotation: string,
  weekFilter: number | null,
  enabledGroupTypes: string[],
  excludedGroupIds: Set<string>,
): Promise<UnifiedItem[]> {
  if (enabledGroupTypes.length === 0) return [];

  const includesEcg = enabledGroupTypes.includes('ecg');
  const otherGroupTypes = enabledGroupTypes.filter((t) => t !== 'ecg');

  const [ecgGroups, otherGroups, universalGroups] = await Promise.all([
    includesEcg
      ? prisma.questionGroup.findMany({
          where: {
            rotation,
            type: 'ecg',
            ...(weekFilter !== null ? { week: weekFilter } : {}),
          },
          select: GROUP_SELECT,
          take: 5,
          orderBy: { totalAttempts: 'asc' },
        })
      : Promise.resolve([]),
    otherGroupTypes.length > 0
      ? prisma.questionGroup.findMany({
          where: {
            rotation,
            type: { in: otherGroupTypes },
            ...(weekFilter !== null ? { week: weekFilter } : {}),
          },
          select: GROUP_SELECT,
          take: 3,
          orderBy: { createdAt: 'desc' },
        })
      : Promise.resolve([]),
    // Only serve groups matching the requested rotation (or untagged).
    // Previously this pulled cross-rotation groups, but since all groups
    // are currently CC, it leaked CC content into PAAM/CAH/PWH sessions.
    prisma.questionGroup.findMany({
      where: {
        type: { in: enabledGroupTypes },
        rotation: null,
      },
      select: GROUP_SELECT,
      take: 5,
      orderBy: { totalAttempts: 'asc' },
    }),
  ]);

  const rotationGroups = [...ecgGroups, ...otherGroups].filter((g) => !excludedGroupIds.has(g.id));
  const universal = universalGroups.filter((g) => !excludedGroupIds.has(g.id));

  const shuffledGroups = shuffle([...rotationGroups, ...universal]).slice(0, 4);
  return shuffledGroups.map((group): UnifiedItem => ({
    type: 'group' as const,
    id: group.id,
    groupType: group.type,
    contextImageUrl: group.contextImageUrl ?? null,
    contextText: group.contextText ?? null,
    steps: (group.steps as unknown[] | null) ?? undefined,
    diagnosisSummary: group.diagnosisSummary ?? null,
    difficulty: group.difficulty,
    topics: group.topics,
    rotation: group.rotation || rotation,
    week: group.week ?? null,
    priority: 2,
  }));
}
