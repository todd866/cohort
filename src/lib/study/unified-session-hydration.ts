import { prisma } from '@/lib/prisma';
import { loadCurrentSessionContent, type CurrentContentContext } from './current-session-content';
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
import { questionImageIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { userTrust } from '@/lib/figures/trust';
import { resolveClipsForSession } from '@/lib/video/clip-access';
import { resolveImageAlternatives } from '@/lib/figures/resolve-alternatives';
import type { AccessTier } from '@/lib/images/types';
import { logger } from '@/lib/logger';
import {
  isRawPublicUsmleQuestionIdentity,
} from '@/lib/usmle/raw-question-boundary';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import {
  ownerPrivateOrSharedCardScope,
} from '@/lib/cards/read-repository.server';

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
  clipId?: string | null;
  /** 'prompt' = the operative clip IS the question; unanswerable without it. */
  clipRole?: string | null;
  clipCaption?: string | null;
  sourceComponent?: string | null;
  rotation?: string | null;
  week?: number | null;
  clusterId?: string | null;
  complexity?: number | null;
  topics?: string[];
  difficulty?: string;
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
  imageRole?: string | null;
  clipId?: string | null;
  clipRole?: string | null;
  clipCaption?: string | null;
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
  deliveryContext: CurrentContentContext;
}): Promise<ScheduledItemHydrationData> {
  const sources = await loadCurrentSessionContent(
    { ...options.deliveryContext, userId: options.userId },
    options.scheduledItems,
  );
  const questions = [...sources.values()].flatMap(source => {
    if (source.type !== 'question') return [];
    return [source];
  });
  const cards = await filterDeliverableReinforcementCardRows(
    [...sources.values()].flatMap(source => {
      if (source.type !== 'card') return [];
      return [source];
    }),
    {
      cardReadScope: ownerPrivateOrSharedCardScope(options.userId),
      logContext: { path: 'scheduled-item-hydration', userId: options.userId },
    },
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
  // Clips resolve up front, in one query for the whole session. Doing it inside
  // the per-item map would be a round trip per card on the path a learner is
  // waiting on; the lookup is by primary key, so it is cheap, but sixty of them
  // are not. A clip absent from the map failed the rights/tier gate, and the
  // prompt-card arms below drop the card rather than serve a stem-less cloze.
  const clipIds: string[] = [];
  for (const item of scheduledItems) {
    const source = item.type === 'card'
      ? hydrationData.cardMap.get(item.id)
      : item.type === 'question' ? hydrationData.questionMap.get(item.id) : null;
    if (source?.clipId) clipIds.push(source.clipId);
  }
  const effectiveTrust = trustOverride ?? userTrust(session);
  const clipMap = await resolveClipsForSession(clipIds, {
    isCopyrightTier: effectiveTrust === 'copyright-required',
  }).catch((error) => {
    // A clip lookup failure must degrade to "no clips", never to a failed
    // session. The prompt-card arms then drop clip cards, which is the same
    // outcome as a standard-tier user and costs nobody their review.
    logger.warn('[hydration] clip resolution failed; serving without clips', { error });
    return new Map<string, import('@/components/review/clip-role').ClipPromptData>();
  });

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
        if (questionImageIsPrompt(card.imageRole, card.imageUrl) && !resolved) return null;
        // Same contract for the operative clip: a clip-as-prompt card's front
        // is "the step shown: [___]". Without the clip it is unanswerable, so
        // drop it rather than serve a cloze with an empty media pane.
        const cardClip = card.clipId ? clipMap.get(card.clipId) ?? null : null;
        if (card.clipRole === 'prompt' && !cardClip) return null;
        const imageAlternatives = await resolveImageAlternatives(
          { ...card, type: 'card' }, card.imageUrl ?? null, session, trustOverride,
        );
        return {
          type: 'card',
          id: card.id,
          front: card.front,
          back: card.back,
          backs: (card.backs as string[] | null) ?? null,
          context: card.context ?? null,
          imageUrl: resolved?.imageUrl ?? null,
          imageCaption: card.imageCaption ?? null,
          imageRole: card.imageRole ?? null,
          clip: cardClip,
          clipRole: card.clipRole === 'prompt' ? 'prompt' : null,
          clipCaption: card.clipCaption ?? null,
          imageKey: resolved?.imageKey ?? null,
          imageMeta: resolved?.imageMeta,
          ...(imageAlternatives.length > 0 ? { imageAlternatives } : {}),
          sourceComponent: card.sourceComponent ?? undefined,
          rotation: card.rotation || options.rotation,
          week: card.week ?? null,
          clusterId: card.clusterId ?? null,
          priority: item.priority,
          complexity: card.complexity ?? undefined,
          topics: card.topics,
          difficulty: card.difficulty,
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
          conditioning: item.conditioning ?? null,
          predictedRecallModel: item.predictedRecallModel ?? null,
          predictedRecallSource: item.predictedRecallSource ?? null,
          predictedRecallStatus: item.predictedRecallStatus ?? null,
          difficultyTier: item.difficultyTier ?? null,
          challengePolicyVersion: item.challengePolicyVersion ?? null,
          challengeTargetTier: item.challengeTargetTier ?? null,
          challengeDistance: item.challengeDistance ?? null,
          challengePolicyApplied: item.challengePolicyApplied ?? null,
          noveltyPolicyVersion: item.noveltyPolicyVersion ?? null,
          recentNeighborSimilarity: item.recentNeighborSimilarity ?? null,
          noveltyPenalty: item.noveltyPenalty ?? null,
          conceptThreadPolicyVersion: item.conceptThreadPolicyVersion ?? null,
          conceptThreadPolicyApplied: item.conceptThreadPolicyApplied ?? null,
          conceptThreadAnchorEventId: item.conceptThreadAnchorEventId ?? null,
          conceptThreadAnchorItemId: item.conceptThreadAnchorItemId ?? null,
          conceptThreadAnchorFacet: item.conceptThreadAnchorFacet ?? null,
          conceptThreadTargetFacet: item.conceptThreadTargetFacet ?? null,
          conceptThreadSharedTopic: item.conceptThreadSharedTopic ?? null,
          conceptThreadAgeMs: item.conceptThreadAgeMs ?? null,
          conceptThreadInterveningExposures:
            item.conceptThreadInterveningExposures ?? null,
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
      if (questionImageIsPrompt(question.imageRole, question.imageUrl) && !resolved) return null;
      const questionClip = question.clipId ? clipMap.get(question.clipId) ?? null : null;
      if (question.clipRole === 'prompt' && !questionClip) return null;
      const imageAlternatives = await resolveImageAlternatives(
        { ...question, type: 'question' }, question.imageUrl ?? null, session, trustOverride,
      );
      return {
        type: 'question',
        id: question.id,
        stem: question.stem,
        options: displayOptions as DisplayOption[],
        context: question.context ?? null,
        imageUrl: resolved?.imageUrl ?? null,
        imageCaption: question.imageCaption ?? null,
        imageRole: question.imageRole ?? null,
        clip: questionClip,
        clipRole: question.clipRole === 'prompt' ? 'prompt' : null,
        clipCaption: question.clipCaption ?? null,
        imageKey: resolved?.imageKey ?? null,
        imageMeta: resolved?.imageMeta,
        ...(imageAlternatives.length > 0 ? { imageAlternatives } : {}),
        rotation: question.rotation || options.rotation,
        week: question.week ?? null,
        priority: item.priority,
        topics: question.topics,
        difficulty: question.difficulty,
        // Preserve the scheduler's event-time concept attribution. The
        // database question row can belong to several concepts; replacing or
        // dropping this id during hydration makes ordered concept-followup
        // telemetry impossible to reconstruct honestly.
        conceptId: item.conceptId,
        conceptName: item.conceptName,
        interventionReason: item.interventionReason,
        signalId: item.signalId,
        predictedRecall: item.predictedRecall ?? null,
        conditioning: item.conditioning ?? null,
        predictedRecallModel: item.predictedRecallModel ?? null,
        predictedRecallSource: item.predictedRecallSource ?? null,
        predictedRecallStatus: item.predictedRecallStatus ?? null,
        difficultyTier: item.difficultyTier ?? null,
        challengePolicyVersion: item.challengePolicyVersion ?? null,
        challengeTargetTier: item.challengeTargetTier ?? null,
        challengeDistance: item.challengeDistance ?? null,
        challengePolicyApplied: item.challengePolicyApplied ?? null,
        noveltyPolicyVersion: item.noveltyPolicyVersion ?? null,
        recentNeighborSimilarity: item.recentNeighborSimilarity ?? null,
        noveltyPenalty: item.noveltyPenalty ?? null,
        conceptThreadPolicyVersion: item.conceptThreadPolicyVersion ?? null,
        conceptThreadPolicyApplied: item.conceptThreadPolicyApplied ?? null,
        conceptThreadAnchorEventId: item.conceptThreadAnchorEventId ?? null,
        conceptThreadAnchorItemId: item.conceptThreadAnchorItemId ?? null,
        conceptThreadAnchorFacet: item.conceptThreadAnchorFacet ?? null,
        conceptThreadTargetFacet: item.conceptThreadTargetFacet ?? null,
        conceptThreadSharedTopic: item.conceptThreadSharedTopic ?? null,
        conceptThreadAgeMs: item.conceptThreadAgeMs ?? null,
        conceptThreadInterveningExposures:
          item.conceptThreadInterveningExposures ?? null,
        variantGroupId: question.variantGroupId ?? null,
        variantType: question.variantType ?? null,
      };
     } catch (err) {
       // One malformed item (bad image key, unparseable options) must not sink
       // the whole session — skip+log it. Hardens the live feed and the sandbox.
       logger.error('hydrateScheduledItems: skipped item', { itemId: item.id, type: item.type, error: String(err) });
       return null;
     }
    }),
  );
  const hydrated = results.filter((item): item is UnifiedItem => !!item);

  // Final cloze-sibling boundary. Most scheduler lanes carry variantGroupId
  // early enough to suppress siblings while selecting, but late fallback and
  // intervention items may not gain the authoritative card metadata until
  // hydration. Without this guard a cached batch can contain two adjacent
  // blanks from the same source sentence. Questions deliberately do not use a
  // blanket group gate because their variantGroupId column also represents
  // topic buckets; this contract is card-only.
  const seenCardVariantGroups = new Set<string>();
  return hydrated.filter((item) => {
    if (item.type !== 'card' || !item.variantGroupId) return true;
    if (seenCardVariantGroups.has(item.variantGroupId)) return false;
    seenCardVariantGroups.add(item.variantGroupId);
    return true;
  });
}
