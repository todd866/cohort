import { shuffle } from '@/lib/utils/shuffle';
import { itemMatchesModules } from '@/lib/modules/matching';
import type {
  UnifiedSessionResult,
} from '@/lib/knowledge/unified-scheduler';
import { compactMetadata } from './unified-session-helpers';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { tierFromComplexity } from '@/lib/audit/walk-metadata';
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
): UnifiedSessionResult | null {
  if (sessionResult.items.length > 0) return sessionResult;

  // Rescue must share the servable-pool predicate or it can resurrect cards
  // the scheduler intentionally filtered out (open-issue, _needs-image, etc).
  // The caller should pre-union open-issue IDs into excludedCardIds; the
  // EXCLUDED_POOL_TOPICS gate is enforced by filterServableRotationCardList.
  const rotationCards = filterServableRotationCardList(ctx.rotationContent.cardList, {
    weekFilter: ctx.weekFilter,
    excludedCardIds,
  });
  if (rotationCards.length === 0) return null;

  const shuffled = shuffle(rotationCards).slice(0, ctx.batchSize);
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
  ctx: Pick<
    SessionContext,
    'typeFilter' | 'difficultyFilter' | 'topicsFilter' | 'modulesFilter' | 'rotation'
  >,
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
) {
  return items.map((item, index) => ({
    userId: ctx.userId,
    eventType: 'content_exposed',
    sourceType: item.type,
    sourceId: item.id,
    conceptIds: [],
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
      // (modality-monotony, stuck-in-cluster, calibration drift) for new-only
      // sessions without false-positive flagging.
      feedMode: ctx.feedMode ?? 'mixed',
      // Cloze-variant group id lets walk-audit detect `variant-sibling-repeat`
      // (a regression in scheduler suppression). See @/lib/audit/walk-pathologies.
      variantGroupId: item.variantGroupId,
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
): UnifiedItem[] {
  // Share the servable-pool predicate so the error path can't resurrect cards
  // the scheduler intentionally filtered out (EXCLUDED_POOL_TOPICS like
  // _needs-image/_incomplete-data, plus open-issue ContentIssue ids) — the same
  // guarantee the sibling rescue path (ensureNonEmptyManifoldSession) provides.
  return shuffle(
    filterServableRotationCardList(ctx.rotationContent.cardList, {
      weekFilter: ctx.weekFilter,
      excludedCardIds,
    }),
  )
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
