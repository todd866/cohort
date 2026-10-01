import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { loadCurrentSessionContent } from './current-session-content';
import { hydrateScheduledItems, type ScheduledItemHydrationData } from './unified-session-hydration';
import { buildServableQuestionWhere } from './servable-pool';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import { logger } from '@/lib/logger';

const PENDING_QUESTION_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_PENDING_QUESTIONS = 60;

type PendingQuestionDecision = {
  id: string;
  sessionId: string;
  batchId: string | null;
  itemId: string;
  conceptId: string | null;
  rotation: string | null;
  decidedAt: Date;
  servedOptionCount: number | null;
  servedCorrectPosition: number | null;
};

function restoreRecordedCorrectPosition(
  item: UnifiedItem,
  decision: PendingQuestionDecision,
): UnifiedItem | null {
  const options = item.type === 'question' ? item.options : null;
  if (!options || options.length !== decision.servedOptionCount
    || decision.servedCorrectPosition == null
    || decision.servedCorrectPosition < 0
    || decision.servedCorrectPosition >= options.length) return null;
  const correctPositions = options.flatMap((option, index) => option.isCorrect ? [index] : []);
  if (correctPositions.length !== 1) return null;
  const restored = [...options];
  const [correct] = restored.splice(correctPositions[0], 1);
  restored.splice(decision.servedCorrectPosition, 0, correct);
  return {
    ...item,
    options: restored.map((option, index) => ({
      ...option,
      label: String.fromCharCode(65 + index),
    })),
  };
}

function isUnnarrowedMcqRequest(ctx: SessionContext): boolean {
  return !ctx.isGuest
    && ctx.typeFilter === 'question'
    && !ctx.reviewFilter
    && !ctx.feedMode
    && !ctx.mode
    && !ctx.requestedMode
    && !ctx.examTarget
    && !ctx.examTargetAttempt
    && ctx.weekFilter === null
    && !ctx.difficultyFilter
    && !ctx.topicsFilter
    && !ctx.clusterFilter
    && !ctx.modulesFilter
    && (!ctx.crossSourceRotations?.length || (ctx.maxCrossSourceItems ?? 0) > 0);
}

/**
 * Re-adopt already-delivered, unanswered MCQs when a learner changes to the
 * MCQ-only view. This path never creates a new delivery or exposure. Anything
 * stale, answered, no longer servable, or not reproducible from its durable
 * receipt is left for the normal scheduler to handle.
 */
export async function tryPendingQuestionSession(
  ctx: SessionContext,
): Promise<NextResponse | null> {
  if (!isUnnarrowedMcqRequest(ctx)) return null;

  try {
    const cutoff = new Date(Date.now() - PENDING_QUESTION_WINDOW_MS);
    const rawDecisions = await prisma.serveDecision.findMany({
      where: {
        userId: ctx.userId,
        rotation: ctx.rotation,
        itemType: 'question',
        deliveryPath: { not: null },
        answeredAt: null,
        decidedAt: { gte: cutoff },
        ...(ctx.clientExcludeQuestionSet.size > 0
          ? { itemId: { notIn: [...ctx.clientExcludeQuestionSet] } }
          : {}),
      },
      orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
      take: MAX_PENDING_QUESTIONS,
      select: {
        id: true,
        sessionId: true,
        batchId: true,
        itemId: true,
        conceptId: true,
        rotation: true,
        decidedAt: true,
        servedOptionCount: true,
        servedCorrectPosition: true,
      },
    }) as PendingQuestionDecision[];

    const seenIds = new Set<string>();
    const decisions = rawDecisions.filter((decision) => {
      if (!decision.id || !decision.sessionId || !decision.itemId
        || decision.rotation !== ctx.rotation
        || ctx.clientExcludeQuestionSet.has(decision.itemId)
        || seenIds.has(decision.itemId)) return false;
      seenIds.add(decision.itemId);
      return true;
    });
    if (decisions.length === 0) return null;

    const [openIssues, globallyExcludedQuestionIds, allowPrivateSources] = await Promise.all([
      getOpenIssueExclusions(),
      getExcludedQuestionIds(),
      userIdCanAccessPrivateSources(ctx.userId),
    ]);
    const ids = decisions.map((decision) => decision.itemId);
    const authorizedSourceRotations = [ctx.rotation, ...(ctx.crossSourceRotations ?? [])];
    const currentPolicies = authorizedSourceRotations.map((rotation) =>
      buildServableQuestionWhere({
        rotation,
        week: null,
        openIssueQuestionIds: openIssues.questionIds,
        globallyExcludedQuestionIds,
        allowPrivateSources,
        practiceLocale: ctx.practiceLocale,
      }),
    );
    const currentRows = await prisma.question.findMany({
      where: { AND: [{ OR: currentPolicies }, { id: { in: ids } }] },
      select: {
        id: true,
        rotation: true,
        updatedAt: true,
        moduleNodes: true,
        variantGroupId: true,
      },
    }) as Array<{
      id: string;
      rotation: string;
      updatedAt: Date;
      moduleNodes: string[];
      variantGroupId: string | null;
    }>;
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const policyEligible = decisions.filter((decision) => {
      const current = currentById.get(decision.itemId);
      if (!current || current.updatedAt >= decision.decidedAt) return false;
      if (current.rotation !== ctx.rotation
        && (!(ctx.crossSourceRotations ?? []).includes(current.rotation)
          || (ctx.maxCrossSourceItems ?? 0) < 1
          || !current.moduleNodes?.includes(ctx.rotation))) return false;
      return true;
    });
    if (policyEligible.length === 0) return null;

    const scheduledItems = policyEligible.map((decision) => ({
      type: 'question' as const,
      id: decision.itemId,
      priority: 1,
      conceptId: '',
      conceptName: '',
      interventionReason: 'reinforcement' as const,
    }));
    const deliveryContext = {
      userId: ctx.userId,
      rotation: ctx.rotation,
      practiceLocale: ctx.practiceLocale,
      weekFilter: null,
      crossSourceRotations: ctx.crossSourceRotations ?? [],
      crossSourceMappingMode: ctx.crossSourceMappingMode ?? 'adjacent',
    };
    const sourceSnapshot = await loadCurrentSessionContent(deliveryContext, scheduledItems);
    const questionMap: ScheduledItemHydrationData['questionMap'] = new Map(
      [...sourceSnapshot.values()].flatMap((source) =>
        source.type === 'question' ? [[source.id, source] as const] : []),
    );
    // Pending retrieval is intentionally point-read only. Do not run the
    // normal hydration helper's response-history aggregates on this path.
    const hydrationData: ScheduledItemHydrationData = {
      cardMap: new Map(),
      questionMap,
      attemptCounts: {},
      lastCorrectDisplayPositions: {},
    };
    const hydrated = await hydrateScheduledItems(
      scheduledItems,
      hydrationData,
      { rotation: ctx.rotation },
      null,
      ctx.imageTier === 'copyright' ? 'copyright-required' : 'auth-required',
    );
    const hydratedById = new Map(hydrated.map((item) => [item.id, item]));
    const sourceById = new Map([...sourceSnapshot.values()].map((source) => [source.id, source]));
    const postHydrationVersions = await prisma.question.findMany({
      where: { id: { in: policyEligible.map((decision) => decision.itemId) } },
      select: { id: true, updatedAt: true },
    }) as Array<{ id: string; updatedAt: Date }>;
    const postVersionById = new Map(postHydrationVersions.map((row) => [row.id, row.updatedAt]));

    const oldestDecisionAt = policyEligible.reduce(
      (oldest, decision) => decision.decidedAt < oldest ? decision.decidedAt : oldest,
      policyEligible[0].decidedAt,
    );
    const recentResponses = await prisma.questionResponse.findMany({
      where: {
        userId: ctx.userId,
        questionId: { in: policyEligible.map((decision) => decision.itemId) },
        createdAt: { gte: oldestDecisionAt },
      },
      distinct: ['questionId'],
      orderBy: [{ questionId: 'asc' }, { createdAt: 'desc' }],
      select: { questionId: true, createdAt: true },
    }) as Array<{ questionId: string; createdAt: Date }>;
    const answeredSinceDelivery = new Set<string>();
    for (const response of recentResponses) {
      const decision = policyEligible.find((candidate) => candidate.itemId === response.questionId);
      if (decision && response.createdAt >= decision.decidedAt) {
        answeredSinceDelivery.add(response.questionId);
      }
    }

    const usedVariantGroups = new Set<string>();
    const resumed: Array<UnifiedItem & { sessionId: string }> = [];
    let resumedCrossSourceCount = 0;
    for (const decision of policyEligible) {
      if (resumed.length >= ctx.batchSize) break;
      if (answeredSinceDelivery.has(decision.itemId)) continue;
      const source = sourceById.get(decision.itemId);
      const item = hydratedById.get(decision.itemId);
      if (!source || !item || item.type !== 'question') continue;
      const current = currentById.get(decision.itemId);
      if (!current || postVersionById.get(decision.itemId)?.getTime() !== current.updatedAt.getTime()
        || source.rotation !== current.rotation) continue;
      const isCrossSource = current.rotation !== ctx.rotation;
      if (isCrossSource && resumedCrossSourceCount >= (ctx.maxCrossSourceItems ?? 0)) continue;
      const combinations = source.type === 'question' ? source.combinations : null;
      const correctVariants = source.type === 'question' ? source.correctVariants : null;
      if ((Array.isArray(combinations) && combinations.length > 0)
        || (Array.isArray(correctVariants) && correctVariants.length > 0)) continue;
      const variantGroupId = current.variantGroupId;
      if (variantGroupId && usedVariantGroups.has(variantGroupId)) continue;
      const restoredItem = restoreRecordedCorrectPosition(item, decision);
      if (!restoredItem) continue;
      if (variantGroupId) usedVariantGroups.add(variantGroupId);

      resumed.push({
        ...restoredItem,
        conceptId: decision.conceptId ?? undefined,
        serveDecisionId: decision.id,
        sessionId: decision.sessionId,
        batchId: decision.batchId,
        decisionContext: {
          servedBy: 'pending-resume',
          sessionType: 'review',
          sessionId: decision.sessionId,
          embeddingType: 'none',
        },
      } as UnifiedItem & { sessionId: string; batchId: string | null });
      if (isCrossSource) resumedCrossSourceCount += 1;
    }

    if (resumed.length === 0) return null;
    return NextResponse.json({ items: resumed, sessionId: ctx.sessionId, batchId: ctx.batchId });
  } catch (error) {
    logger.warn('Pending question resume eligibility failed; continuing to scheduler', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      error: String(error),
    });
    return null;
  }
}
