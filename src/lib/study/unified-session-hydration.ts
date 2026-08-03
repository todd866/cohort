import { prisma } from '@/lib/prisma';
import {
  getQuestionOptions,
  type DisplayOption,
} from '@/lib/question-bank';
import type { OptionCombination } from '@/lib/question-bank/types';
import { isUsableQuestion } from '@/lib/question-validation';
import type {
  UnifiedSessionItem as ScheduledSessionItem,
} from '@/lib/knowledge/unified-scheduler';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import type { Session } from 'next-auth';
import { imageKeyIsPrompt, resolveImage } from '@/lib/figures/resolve';
import type { AccessTier } from '@/lib/images/types';
import { logger } from '@/lib/logger';
import {
  isRawPublicUsmleQuestionIdentity,
  withoutRawPublicUsmleQuestions,
} from '@/lib/usmle/raw-question-boundary';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

type HydratableCard = {
  id: string;
  front: string;
  back: string;
  backs?: unknown;
  context?: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  /** 'prompt' = the figure IS the question; unanswerable without it. Card-only. */
  imageRole?: string | null;
  sourceComponent?: string | null;
  rotation?: string | null;
  week?: number | null;
  clusterId?: string | null;
  complexity?: number | null;
  crosslinks?: unknown;
  // Cloze variant fields (2026-05-08): may be absent on stale cache entries
  // (StaticCard hasn't been regenerated yet — Task 13).
  variantGroupId?: string | null;
  variantIndex?: number | null;
  variantType?: string | null;
};

type HydratableQuestion = {
  id: string;
  stem: string;
  options: unknown;
  context: string | null;
  imageUrl?: string | null;
  imageCaption?: string | null;
  rotation?: string | null;
  moduleNodes?: string[] | null;
  week?: number | null;
  topics: string[];
  difficulty?: string;
  combinations?: unknown;
  correctVariants?: unknown;
  variantGroupId?: string | null;
  variantType?: string | null;
};

export interface ScheduledItemHydrationData {
  cardMap: Map<string, HydratableCard>;
  questionMap: Map<string, HydratableQuestion>;
  attemptCounts: Record<string, number>;
  lastCorrectDisplayPositions: Record<string, number>;
}

export async function loadScheduledItemHydrationData(options: {
  userId: string;
  rotationContent: SessionContext['rotationContent'];
  scheduledItems: ScheduledSessionItem[];
}): Promise<ScheduledItemHydrationData> {
  const cardIds = options.scheduledItems
    .filter((item) => item.type === 'card')
    .map((item) => item.id);
  const questionIds = options.scheduledItems
    .filter((item) => item.type === 'question')
    .map((item) => item.id);

  const staticCards = cardIds
    .map((id) => options.rotationContent.cards[id] as HydratableCard | undefined)
    .filter((card): card is HydratableCard => !!card);
  const staticQuestions = questionIds
    .map((id) => options.rotationContent.questions[id] as HydratableQuestion | undefined)
    .filter((question): question is HydratableQuestion => !!question);
  const staticQuestionIds = staticQuestions.map((question) => question.id);

  const missingCardIds = cardIds.filter((id) => !options.rotationContent.cards[id]);
  const missingQuestionIds = questionIds.filter((id) => !options.rotationContent.questions[id]);

  const [fallbackCards, fallbackQuestions, eligibleStaticQuestionRows] = await Promise.all([
    missingCardIds.length > 0
      ? prisma.card.findMany({
          where: { id: { in: missingCardIds } },
          select: {
            id: true,
            front: true,
            back: true,
            backs: true,
            context: true,
            imageUrl: true,
            imageCaption: true,
            imageRole: true,
            sourceComponent: true,
            rotation: true,
            week: true,
            clusterId: true,
            complexity: true,
            crosslinks: true,
            variantGroupId: true,
            variantIndex: true,
            variantType: true,
          },
        })
      : Promise.resolve([]),
    missingQuestionIds.length > 0
      ? prisma.question.findMany({
          where: withoutRawPublicUsmleQuestions({ id: { in: missingQuestionIds } }),
          select: {
            id: true,
            stem: true,
            options: true,
            context: true,
            imageUrl: true,
            imageCaption: true,
            rotation: true,
            moduleNodes: true,
            week: true,
            topics: true,
            difficulty: true,
            combinations: true,
            correctVariants: true,
            variantGroupId: true,
            variantType: true,
          },
        })
      : Promise.resolve([]),
    staticQuestionIds.length > 0
      ? prisma.question.findMany({
          where: withoutRawPublicUsmleQuestions({ id: { in: staticQuestionIds } }),
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const eligibleStaticQuestionIds = new Set(
    eligibleStaticQuestionRows.map((question) => question.id),
  );
  const questions = [
    ...staticQuestions.filter((question) => eligibleStaticQuestionIds.has(question.id)),
    ...fallbackQuestions,
  ];
  const cards = await filterDeliverableReinforcementCardRows(
    [...staticCards, ...fallbackCards],
    { logContext: { path: 'scheduled-item-hydration', userId: options.userId } },
  );

  const attemptCounts: Record<string, number> = {};
  const lastCorrectDisplayPositions: Record<string, number> = {};
  if (questions.length > 0) {
    const questionIdsForResponses = questions.map((question) => question.id);
    const [responses, recentPositions] = await Promise.all([
      prisma.questionResponse.groupBy({
        by: ['questionId'],
        where: {
          userId: options.userId,
          questionId: { in: questionIdsForResponses },
        },
        _count: { id: true },
      }),
      prisma.questionResponse.findMany({
        where: {
          userId: options.userId,
          questionId: { in: questionIdsForResponses },
          correctDisplayPosition: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          questionId: true,
          correctDisplayPosition: true,
        },
      }),
    ]);
    for (const response of responses) {
      attemptCounts[response.questionId] = response._count.id;
    }
    for (const response of recentPositions) {
      if (lastCorrectDisplayPositions[response.questionId] != null) continue;
      if (response.correctDisplayPosition == null) continue;
      lastCorrectDisplayPositions[response.questionId] = response.correctDisplayPosition;
    }
  }

  return {
    cardMap: new Map(cards.map((card) => [card.id, card])),
    questionMap: new Map(questions.map((question) => [question.id, question])),
    attemptCounts,
    lastCorrectDisplayPositions,
  };
}

export async function hydrateScheduledItems(
  scheduledItems: ScheduledSessionItem[],
  hydrationData: ScheduledItemHydrationData,
  options: {
    rotation: string;
    includeVideos?: boolean;
  },
  session: Session | null = null,
  /** Explicit tier for server paths with a userId but no Session — see resolveImage. */
  trustOverride?: AccessTier,
): Promise<UnifiedItem[]> {
  const results = await Promise.all(
    scheduledItems.map(async (item): Promise<UnifiedItem | null> => {
     try {
      if (item.type === 'video') {
        if (!options.includeVideos) return null;
        return {
          type: 'video',
          id: item.id,
          videoTitle: item.videoTitle,
          videoThumbnailUrl: item.videoThumbnailUrl,
          videoDuration: item.videoDuration,
          videoR2Key: item.videoR2Key,
          creatorName: item.creatorName,
          rotation: options.rotation,
          week: null,
          priority: item.priority,
          conceptId: item.conceptId,
          conceptName: item.conceptName,
          interventionReason: item.interventionReason,
        };
      }

      if (item.type === 'card') {
        const card = hydrationData.cardMap.get(item.id);
        if (!card) return null;
        const resolved = await resolveImage(card.imageUrl ?? null, session, trustOverride);
        // An image-as-prompt card's front IS the question ("...the appearance
        // shown: [___]"). Served without its figure it is unanswerable, so drop
        // it rather than show a broken card. The `instant` lane already does
        // this; hydration serves the manifold, cache, rereview and
        // error-fallback lanes, which did not.
        if (card.imageRole === 'prompt' && !resolved) return null;
        return {
          type: 'card',
          id: card.id,
          front: card.front,
          back: card.back,
          backs: (card.backs as string[] | null) ?? null,
          context: card.context ?? null,
          imageUrl: resolved?.imageUrl ?? null,
          imageCaption: card.imageCaption ?? null,
          imageKey: resolved?.imageKey ?? null,
          imageMeta: resolved?.imageMeta,
          sourceComponent: card.sourceComponent ?? undefined,
          rotation: card.rotation || options.rotation,
          week: card.week ?? null,
          clusterId: card.clusterId ?? null,
          priority: item.priority,
          complexity: card.complexity ?? undefined,
          crosslinks: (card.crosslinks as UnifiedItem['crosslinks']) ?? null,
          // Cloze variant fields (2026-05-08): defensive ?? null for stale
          // cache entries where StaticCard predates Task 13.
          variantGroupId: card.variantGroupId ?? null,
          variantIndex: card.variantIndex ?? null,
          variantType: card.variantType ?? null,
          conceptId: item.conceptId,
          conceptName: item.conceptName,
          interventionReason: item.interventionReason,
          signalId: item.signalId,
          predictedRecall: item.predictedRecall ?? null,
          predictedRecallModel: item.predictedRecallModel ?? null,
          predictedRecallSource: item.predictedRecallSource ?? null,
          predictedRecallStatus: item.predictedRecallStatus ?? null,
        };
      }

      if (item.type !== 'question') {
        return null;
      }

      const question = hydrationData.questionMap.get(item.id);
      if (
        !question
        || isRawPublicUsmleQuestionIdentity(question)
        || !isUsableQuestion(question)
      ) return null;

      const attemptCount = hydrationData.attemptCounts[question.id] ?? 0;
      const displayOptions = getQuestionOptions(
        {
          id: question.id,
          options: (question.options as Array<{ text: string; isCorrect: boolean }>) ?? [],
          combinations: (question.combinations as OptionCombination[]) ?? null,
          correctVariants: (question.correctVariants as string[]) ?? null,
        },
        attemptCount,
        {
          avoidCorrectDisplayPosition: hydrationData.lastCorrectDisplayPositions[question.id] ?? null,
        },
      );

      const resolved = await resolveImage(question.imageUrl ?? null, session, trustOverride);
      if (imageKeyIsPrompt(question.imageUrl) && !resolved) return null;
      return {
        type: 'question',
        id: question.id,
        stem: question.stem,
        options: displayOptions as DisplayOption[],
        context: question.context ?? null,
        imageUrl: resolved?.imageUrl ?? null,
        imageCaption: question.imageCaption ?? null,
        imageKey: resolved?.imageKey ?? null,
        imageMeta: resolved?.imageMeta,
        rotation: question.rotation || options.rotation,
        week: question.week ?? null,
        priority: item.priority,
        topics: question.topics,
        difficulty: question.difficulty,
        conceptName: item.conceptName,
        interventionReason: item.interventionReason,
        signalId: item.signalId,
        predictedRecall: item.predictedRecall ?? null,
        predictedRecallModel: item.predictedRecallModel ?? null,
        predictedRecallSource: item.predictedRecallSource ?? null,
        predictedRecallStatus: item.predictedRecallStatus ?? null,
        variantGroupId: question.variantGroupId ?? item.variantGroupId ?? null,
        variantType: question.variantType ?? item.variantType ?? null,
      };
     } catch (err) {
       // One malformed item (bad image key, unparseable options) must not sink
       // the whole session — skip+log it. Hardens the live feed and the sandbox.
       logger.error('hydrateScheduledItems: skipped item', { itemId: item.id, type: item.type, error: String(err) });
       return null;
     }
    }),
  );
  return results.filter((item): item is UnifiedItem => !!item);
}
