import { DEFAULT_ENABLED_MODULES, getEnabledGroupTypes } from '@/lib/institution';
import { prisma } from '@/lib/prisma';
import {
  MASTERY_CORRECT_THRESHOLD,
  resolveRetirementPolicy,
  retiredQuestionIds as computeRetiredQuestionIds,
} from '@/lib/knowledge/question-retirement';
import type { SessionContext } from './unified-session-types';

type RecentExposureEvent = {
  sourceId: string;
  sourceType: string;
  timestamp: Date;
  metadata: unknown;
};

type RecentQuestionResponse = {
  questionId: string;
};

type RecentGroupAttempt = {
  groupId: string;
};

type RecentServeDecision = {
  itemId: string;
  itemType: string;
  decidedAt: Date;
};

export type TopicExposureMap = Map<string, { count: number; mostRecentMs: number }>;

export interface ManifoldExclusionState {
  excludedCardIds: Set<string>;
  excludedQuestionIds: Set<string>;
  excludedGroupIds: Set<string>;
  recentTopicExposures: TopicExposureMap;
  enabledGroupTypes: string[];
}

interface BuildManifoldExclusionStateOptions {
  recentExposureEvents: RecentExposureEvent[];
  recentQuestionResponses: RecentQuestionResponse[];
  recentGroupAttempts: RecentGroupAttempt[];
  recentServeDecisions?: RecentServeDecision[];
  clientExcludeCards: string[];
  clientExcludeQuestions: string[];
  userEnabledModules: string[] | null | undefined;
  /**
   * Questions excluded outright by retirement policy. Empty under the live policy —
   * mastery now SINKS a question in ranking rather than deleting it. See
   * knowledge/question-retirement.ts.
   */
  retiredQuestionIds: string[];
  cardRepeatCutoff: Date;
  questionRepeatCutoff: Date;
  groupRepeatCutoff: Date;
  /** When provided, all listed cardIds are added to excludedCardIds. */
  allTimeSeenCardIds?: string[];
  /** When provided, all listed questionIds are added to excludedQuestionIds. */
  allTimeSeenQuestionIds?: string[];
  /** When true, enabledGroupTypes is forced to []. Used by feedMode=new-only. */
  forceEmptyGroupTypes?: boolean;
}

export function buildTopicExposureMap(
  recentExposureEvents: RecentExposureEvent[],
  cardRepeatCutoff: Date,
): TopicExposureMap {
  const recentTopicExposures: TopicExposureMap = new Map();

  for (const event of recentExposureEvents) {
    if (event.sourceType !== 'card' || event.timestamp < cardRepeatCutoff) continue;
    const metadata = event.metadata as Record<string, unknown> | null;
    const topics = metadata?.topics;
    if (!Array.isArray(topics)) continue;

    const tsMs = event.timestamp.getTime();
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      const existing = recentTopicExposures.get(topic);
      if (existing) {
        existing.count += 1;
        if (tsMs > existing.mostRecentMs) existing.mostRecentMs = tsMs;
      } else {
        recentTopicExposures.set(topic, { count: 1, mostRecentMs: tsMs });
      }
    }
  }

  return recentTopicExposures;
}

export function buildManifoldExclusionState(
  options: BuildManifoldExclusionStateOptions,
): ManifoldExclusionState {
  const excludedCardIds = new Set<string>();
  const excludedQuestionIds = new Set<string>();
  const excludedGroupIds = new Set<string>();

  for (const event of options.recentExposureEvents) {
    if (event.sourceType === 'card' && event.timestamp >= options.cardRepeatCutoff) {
      excludedCardIds.add(event.sourceId);
    }
    if (event.sourceType === 'question' && event.timestamp >= options.questionRepeatCutoff) {
      excludedQuestionIds.add(event.sourceId);
    }
    if (event.sourceType === 'group' && event.timestamp >= options.groupRepeatCutoff) {
      excludedGroupIds.add(event.sourceId);
    }
  }

  for (const response of options.recentQuestionResponses) {
    excludedQuestionIds.add(response.questionId);
  }
  for (const attempt of options.recentGroupAttempts) {
    excludedGroupIds.add(attempt.groupId);
  }
  for (const decision of options.recentServeDecisions ?? []) {
    if (decision.itemType === 'card' && decision.decidedAt >= options.cardRepeatCutoff) {
      excludedCardIds.add(decision.itemId);
    }
    if (decision.itemType === 'question' && decision.decidedAt >= options.questionRepeatCutoff) {
      excludedQuestionIds.add(decision.itemId);
    }
    if (decision.itemType === 'group' && decision.decidedAt >= options.groupRepeatCutoff) {
      excludedGroupIds.add(decision.itemId);
    }
  }
  for (const id of options.clientExcludeCards) {
    excludedCardIds.add(id);
  }
  for (const id of options.clientExcludeQuestions) {
    excludedQuestionIds.add(id);
  }
  for (const id of options.retiredQuestionIds) {
    excludedQuestionIds.add(id);
  }
  for (const id of options.allTimeSeenCardIds ?? []) {
    excludedCardIds.add(id);
  }
  for (const id of options.allTimeSeenQuestionIds ?? []) {
    excludedQuestionIds.add(id);
  }

  const enabledModules = options.userEnabledModules ?? DEFAULT_ENABLED_MODULES;
  const enabledGroupTypes = options.forceEmptyGroupTypes ? [] : getEnabledGroupTypes(enabledModules);

  return {
    excludedCardIds,
    excludedQuestionIds,
    excludedGroupIds,
    recentTopicExposures: buildTopicExposureMap(
      options.recentExposureEvents,
      options.cardRepeatCutoff,
    ),
    enabledGroupTypes,
  };
}

export async function loadManifoldExclusionState(
  ctx: SessionContext,
): Promise<ManifoldExclusionState> {
  const now = new Date();
  const cardRepeatCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const questionRepeatCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const groupRepeatCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [
    recentExposureEvents,
    recentQuestionResponses,
    recentGroupAttempts,
    recentServeDecisions,
    userSettings,
    masteredQuestions,
    allTimeSeenCards,
    allTimeSeenQuestions,
  ] = await Promise.all([
    prisma.learningEvent.findMany({
      where: {
        userId: ctx.userId,
        sourceType: { in: ['card', 'question', 'group'] },
        eventType: {
          in: ['card_reviewed', 'mcq_attempted', 'group_attempted', 'content_exposed'],
        },
        timestamp: { gte: questionRepeatCutoff },
      },
      select: { sourceId: true, sourceType: true, timestamp: true, metadata: true },
    }),
    prisma.questionResponse.findMany({
      where: {
        userId: ctx.userId,
        createdAt: { gte: questionRepeatCutoff },
      },
      select: { questionId: true },
      distinct: ['questionId'],
    }),
    prisma.assessmentAttempt.findMany({
      where: {
        userId: ctx.userId,
        attemptType: 'question-group',
        completedAt: { gte: groupRepeatCutoff },
      },
      select: { targetId: true },
    }).then(attempts => attempts.map(a => ({ groupId: a.targetId }))),
    prisma.serveDecision.findMany({
      where: {
        userId: ctx.userId,
        itemType: { in: ['card', 'question', 'group'] },
        deliveryPath: { not: null },
        decidedAt: { gte: questionRepeatCutoff },
      },
      select: { itemId: true, itemType: true, decidedAt: true },
    }),
    prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { enabledModules: true },
    }),
    prisma.questionResponse.groupBy({
      by: ['questionId'],
      where: {
        userId: ctx.userId,
        isCorrect: true,
      },
      _count: { questionId: true },
      having: {
        questionId: { _count: { gte: MASTERY_CORRECT_THRESHOLD } },
      },
    }),
    ctx.feedMode === 'new-only'
      ? prisma.cardProgress.findMany({
          where: { userId: ctx.userId },
          select: { cardId: true },
        })
      : Promise.resolve([] as Array<{ cardId: string }>),
    ctx.feedMode === 'new-only'
      ? prisma.questionResponse.findMany({
          where: { userId: ctx.userId },
          select: { questionId: true },
          distinct: ['questionId'],
        })
      : Promise.resolve([] as Array<{ questionId: string }>),
  ]);

  return buildManifoldExclusionState({
    recentExposureEvents,
    recentQuestionResponses,
    recentGroupAttempts,
    recentServeDecisions,
    clientExcludeCards: ctx.clientExcludeCards,
    clientExcludeQuestions: ctx.clientExcludeQuestions,
    userEnabledModules: userSettings?.enabledModules,
    retiredQuestionIds: [
      ...computeRetiredQuestionIds(
        masteredQuestions.map(r => r.questionId),
        resolveRetirementPolicy()
      ),
    ],
    cardRepeatCutoff,
    questionRepeatCutoff,
    groupRepeatCutoff,
    allTimeSeenCardIds: allTimeSeenCards.map(r => r.cardId),
    allTimeSeenQuestionIds: allTimeSeenQuestions.map(r => r.questionId),
    forceEmptyGroupTypes: ctx.feedMode === 'new-only',
  });
}
