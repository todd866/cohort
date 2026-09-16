import { shuffle, shuffleWithSeed } from '@/lib/utils/shuffle';
import { itemMatchesModules } from '@/lib/modules/matching';
import type {
  UnifiedSessionSelectionDeterminism,
  UnifiedSessionResult,
} from '@/lib/knowledge/unified-scheduler';
import {
  compactMetadata,
  type CardDueExposureAudit,
} from './unified-session-helpers';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import {
  tierFromComplexity,
  tierFromQuestionDifficulty,
} from '@/lib/audit/walk-metadata';
import { filterServableRotationCardList } from './servable-pool';

export const ROTATION_TO_MODULES: Record<string, string[]> = {
  'critical-care': ['cc', 'cc/em', 'cc/icu', 'cc/anaes'],
  cah: ['cah'],
  paam: ['paam'],
  pwh: ['pwh'],
};

export function ensureNonEmptyManifoldSession(
  ctx: SessionContext,
  sessionResult: UnifiedSessionResult,
  excludedCardIds: Set<string>,
  selectionDeterminism?: UnifiedSessionSelectionDeterminism,
): UnifiedSessionResult | null {
  if (sessionResult.items.length > 0) return sessionResult;

  // The rescue pool is cards only, so it can never satisfy an MCQ-only
  // request. applyManifoldFilters would strip every rescued card later anyway;
  // declining here keeps the card-free mode card-free at the point of
  // construction rather than relying on a downstream filter staying put.
  if (ctx.typeFilter === 'question' || ctx.typeFilter === 'group') return null;

  // Rescue must share the servable-pool predicate or it can resurrect cards
  // the scheduler intentionally filtered out (open-issue, _needs-image, etc).
  // The caller should pre-union open-issue IDs into excludedCardIds; the
  // EXCLUDED_POOL_TOPICS gate is enforced by filterServableRotationCardList.
  const rotationCards = filterServableRotationCardList(ctx.rotationContent.cardList, {
    weekFilter: ctx.weekFilter,
    excludedCardIds,
  });
  if (rotationCards.length === 0) return null;

  const shuffled = (selectionDeterminism
    ? shuffleWithSeed(
        rotationCards,
        `${selectionDeterminism.seed}\0manifold-rescue`,
      )
    : shuffle(rotationCards)).slice(0, ctx.batchSize);
  return {
    ...sessionResult,
    items: shuffled.map((card) => ({
      type: 'card' as const,
      id: card.id,
      conceptId: '',
      conceptName: '',
      priority: 1,
      interventionReason: 'reinforcement' as const,
    })),
  };
}

export function collectAvailableFilters(items: UnifiedItem[]) {
  return {
    types: [...new Set(items.map((item) => item.type))].filter(Boolean) as string[],
    difficulties: [
      ...new Set(items.map((item) => item.difficulty).filter(Boolean)),
    ] as string[],
    topics: [...new Set(items.flatMap((item) => item.topics || []))].slice(0, 12),
  };
}

export function applyManifoldFilters(
  items: UnifiedItem[],
  ctx: Pick<SessionContext, 'rotation'> &
    Partial<Pick<
      SessionContext,
      'typeFilter' | 'difficultyFilter' | 'topicsFilter' | 'modulesFilter' | 'clusterFilter'
    >>,
): UnifiedItem[] {
  let filteredItems = items;

  if (ctx.typeFilter) {
    filteredItems = filteredItems.filter((item) => item.type === ctx.typeFilter);
  }

  if (ctx.difficultyFilter) {
    filteredItems = filteredItems.filter(
      (item) => item.difficulty === ctx.difficultyFilter,
    );
  }

  // A cluster-scoped session is a deliberate narrowing from the profile
  // heatmap: the square the learner clicked promises those cards and no
  // others. Applied here as well as in the pool query, so a lane that builds
  // its own candidate list can never leak an out-of-cluster item. An item with
  // no cluster is not in the requested one and is dropped.
  if (ctx.clusterFilter) {
    filteredItems = filteredItems.filter((item) => item.clusterId === ctx.clusterFilter);
  }

  if (ctx.topicsFilter) {
    const topicList = ctx.topicsFilter.split(',').map((topic) => topic.trim().toLowerCase());
    filteredItems = filteredItems.filter((item) =>
      item.topics?.some((topic) => topicList.includes(topic.toLowerCase())),
    );
  }

  if (ctx.modulesFilter) {
    const moduleList = ctx.modulesFilter.split(',').map((moduleName) => moduleName.trim());

    // Safety: if the active modules don't overlap with the requested rotation's
    // modules at all (e.g., user has CC modules but is viewing PAAM), skip the
    // filter. Stale module settings should never blank out an entire rotation
    // the user is explicitly requesting.
    const rotationModules = ctx.rotation ? ROTATION_TO_MODULES[ctx.rotation] || [] : [];
    const hasOverlap = rotationModules.length === 0 ||
      rotationModules.some(rm => itemMatchesModules([rm], moduleList));

    if (hasOverlap) {
      filteredItems = filteredItems.filter((item) => {
        const itemModules = item.rotation ? ROTATION_TO_MODULES[item.rotation] || [] : [];
        return itemMatchesModules(itemModules, moduleList);
      });
    }
  }

  return filteredItems;
}

export function buildManifoldExposureEvents(
  items: UnifiedItem[],
  ctx: Pick<
    SessionContext,
    'userId' | 'rotation' | 'batchId' | 'sessionId' | 'anonymousSessionId' | 'feedMode'
  >,
  cardDueAudit?: CardDueExposureAudit,
) {
  return items.map((item, index) => ({
    userId: ctx.userId,
    eventType: 'content_exposed',
    sourceType: item.type,
    sourceId: item.id,
    // The scheduler has already attributed this returned item to one concept.
    // Persist that stable id on the exposure event so later audits do not have
    // to infer historical identity from today's topics or embeddings.
    conceptIds: item.conceptId ? [item.conceptId] : [],
    rotation: ctx.rotation,
    week: item.week ?? null,
    metadata: compactMetadata({
      queueReason: item.interventionReason ?? 'manifold',
      queueType: 'manifold',
      priority: item.priority,
      position: index,
      batchSize: items.length,
      batchId: ctx.batchId,
      sessionId: ctx.sessionId,
      serveDecisionId: item.serveDecisionId,
      itemType: item.type,
      itemRotation: item.rotation ?? null,
      sourceComponent: item.sourceComponent,
      groupType: item.groupType,
      difficulty: item.difficulty,
      topics: item.topics,
      clusterId: item.clusterId,
      complexity: item.complexity,
      crosslinks: item.crosslinks ?? null,
      conceptName: item.conceptName,
      interventionReason: item.interventionReason,
      hasImage: !!item.imageUrl || !!item.contextImageUrl,
      optionCount: Array.isArray(item.options) ? item.options.length : undefined,
      anonymousSessionId: ctx.anonymousSessionId,
      // Walk decision context (Phase 1 of scheduler-walk-audit)
      servedBy: item.servedBy,
      predictedRecall: item.predictedRecall,
      conditioning: item.conditioning,
      predictedRecallModel: item.predictedRecallModel,
      predictedRecallSource: item.predictedRecallSource,
      predictedRecallStatus: item.predictedRecallStatus,
      difficultyTier:
        item.servedBy === undefined
          ? undefined
          : item.difficultyTier
            ?? (item.type === 'question'
              ? tierFromQuestionDifficulty(item.difficulty)
              : tierFromComplexity(item.complexity)),
      challengePolicyVersion:
        item.servedBy === undefined ? undefined : item.challengePolicyVersion,
      challengeTargetTier:
        item.servedBy === undefined ? undefined : item.challengeTargetTier,
      challengeDistance:
        item.servedBy === undefined ? undefined : item.challengeDistance,
      challengePolicyApplied:
        item.servedBy === undefined ? undefined : item.challengePolicyApplied,
      noveltyPolicyVersion:
        item.servedBy === undefined ? undefined : item.noveltyPolicyVersion,
      recentNeighborSimilarity:
        item.servedBy === undefined ? undefined : item.recentNeighborSimilarity,
      noveltyPenalty:
        item.servedBy === undefined ? undefined : item.noveltyPenalty,
      conceptThreadPolicyVersion:
        item.servedBy === undefined ? undefined : item.conceptThreadPolicyVersion,
      conceptThreadPolicyApplied:
        item.servedBy === undefined ? undefined : item.conceptThreadPolicyApplied,
      conceptThreadAnchorEventId:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorEventId,
      conceptThreadAnchorItemId:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorItemId,
      conceptThreadAnchorFacet:
        item.servedBy === undefined ? undefined : item.conceptThreadAnchorFacet,
      conceptThreadTargetFacet:
        item.servedBy === undefined ? undefined : item.conceptThreadTargetFacet,
      conceptThreadSharedTopic:
        item.servedBy === undefined ? undefined : item.conceptThreadSharedTopic,
      conceptThreadAgeMs:
        item.servedBy === undefined ? undefined : item.conceptThreadAgeMs,
      conceptThreadInterveningExposures:
        item.servedBy === undefined
          ? undefined
          : item.conceptThreadInterveningExposures,
      poolSize: item.poolSize,
      positionInSession: item.servedBy !== undefined ? (item.positionInSession ?? index) : undefined,
      similarityToPrior: item.similarityToPrior,
      // Feed-mode tag lets walk-audit suppress pool-constrained pathologies
      // (modality-monotony, stuck-in-cluster, calibration drift) for new-only
      // sessions without false-positive flagging.
      feedMode: ctx.feedMode ?? 'mixed',
      // Cloze-variant group id lets walk-audit detect `variant-sibling-repeat`
      // (a regression in scheduler suppression). See @/lib/audit/walk-pathologies.
      variantGroupId: item.variantGroupId,
      srsDueGateVersion:
        item.type === 'card' ? cardDueAudit?.version : undefined,
      srsDueGateBypassReason:
        item.type === 'card'
          ? cardDueAudit?.policyBypassReasonByCardId.get(item.id)
          : undefined,
      srsDueGateLookupFailed:
        item.type === 'card' ? cardDueAudit?.lookupFailed : undefined,
      srsEligibilityCheckedAt:
        item.type === 'card' ? cardDueAudit?.checkedAt.toISOString() : undefined,
      srsProgressFound:
        item.type === 'card' && cardDueAudit && !cardDueAudit.lookupFailed
          ? cardDueAudit.nextDueAtByCardId.has(item.id)
          : undefined,
      srsNextDueAtAtOffer:
        item.type === 'card' && cardDueAudit && !cardDueAudit.lookupFailed
          ? cardDueAudit.nextDueAtByCardId.get(item.id)?.toISOString() ?? null
          : undefined,
    }),
  }));
}

export function collectItemComposition(items: UnifiedItem[]) {
  return {
    cards: items.filter((item) => item.type === 'card').length,
    questions: items.filter((item) => item.type === 'question').length,
    groups: items.filter((item) => item.type === 'group').length,
  };
}

export function buildErrorFallbackItems(
  ctx: SessionContext,
  excludedCardIds: ReadonlySet<string> = new Set(),
  selectionDeterminism?: UnifiedSessionSelectionDeterminism,
): UnifiedItem[] {
  // Share the servable-pool predicate so the error path can't resurrect cards
  // the scheduler intentionally filtered out (EXCLUDED_POOL_TOPICS like
  // _needs-image/_incomplete-data, plus open-issue ContentIssue ids) — the same
  // guarantee the sibling rescue path (ensureNonEmptyManifoldSession) provides.
  const candidates = filterServableRotationCardList(ctx.rotationContent.cardList, {
    weekFilter: ctx.weekFilter,
    excludedCardIds,
  });
  return (selectionDeterminism
    ? shuffleWithSeed(
        candidates,
        `${selectionDeterminism.seed}\0manifold-error-fallback`,
      )
    : shuffle(candidates))
    .slice(0, ctx.batchSize)
    .map((card) => ({
      type: 'card' as const,
      id: card.id,
      front: card.front,
      back: card.back,
      backs: (card.backs as string[] | null) ?? null,
      context: card.context ?? null,
      sourceComponent: card.sourceComponent,
      rotation: card.rotation || ctx.rotation,
      week: card.week ?? null,
      complexity: card.complexity,
      crosslinks: (card.crosslinks as UnifiedItem['crosslinks']) ?? null,
      priority: 1,
      liked: false,
      flagged: false,
    }));
}
