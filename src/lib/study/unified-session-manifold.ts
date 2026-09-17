import { createHash } from 'node:crypto';
import { NextResponse, after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { constructUnifiedSession } from '@/lib/knowledge/unified-scheduler';
import type {
  UnifiedSessionItem,
  UnifiedSessionSelectionDeterminism,
} from '@/lib/knowledge/unified-scheduler';
import { createUnifiedSchedulerSharedReadContext } from '@/lib/knowledge/unified-scheduler-shared-reads';
import { ensureCardProgressExists } from '@/lib/stats';
import type { SessionContext, UnifiedItem } from './unified-session-types';
import {
  fetchGroupItems,
  filterCardsAtDueEgress,
  interleaveGroups,
  logExposures,
} from './unified-session-helpers';
import { breakModalityRuns } from '@/lib/knowledge/modality-guard';
import { readSessionCacheEpoch, upsertSessionCache } from './unified-session-cache-store';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import { loadManifoldExclusionState } from './unified-session-manifold-exclusions';
import {
  applyManifoldFilters,
  buildErrorFallbackItems,
  buildManifoldExposureEvents,
  collectAvailableFilters,
  collectItemComposition,
  ensureNonEmptyManifoldSession,
} from './unified-session-manifold-items';
import {
  hydrateScheduledItems,
  loadScheduledItemHydrationData,
} from './unified-session-hydration';
import { enrichItemsWithWalkMetadata } from '@/lib/audit/walk-metadata';
import {
  scoreOrderedPairwiseDistances,
  type EmbeddingItemTable,
  type EmbeddingItemIdColumn,
} from '@/lib/manifold/scoring';
import {
  buildServableCardWhere,
  buildServableQuestionWhere,
  loadServablePoolFilters,
  type ServablePoolFilters,
} from './servable-pool';
import {
  writeLiveExamTargetServeDecisions,
  writeLiveServeDecisions,
  type AtomicServeDecisionWriterClient,
} from './serve-decision-write';
import { fetchDueBacklogCards } from './due-backlog';
import {
  capRelearnCardsByDelivery,
  fetchRelearnCards,
  selectRelearnReserve,
} from './relearn';
import { relearnProfileFor } from './relearn-profile';
import { getStudyDayStart } from '@/lib/study-day';
import {
  countCards,
  ownerPrivateOrSharedCardScope,
} from '@/lib/cards/read-repository.server';
import {
  MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
  capCrossSourceSessionItems,
} from '@/lib/knowledge/cross-source-cap';
import {
  buildRuntimeExamTargetDecision,
  type RuntimeExamTargetFinalItemScalar,
} from '@/lib/exam-target/runtime-decision';
import { loadExamTargetDecisionTokenizer } from '@/lib/exam-target/decision-hmac.server';
import {
  persistExamTargetDecisionSet,
  type ExamTargetDecisionPersistenceClient,
  type ExamTargetDecisionTransaction,
} from '@/lib/exam-target/decision-set-persistence.server';
import {
  terminalizeExamTargetDecisionAttempt,
  type ExamTargetAttemptFailureClass,
  type ExamTargetAttemptLedgerClient,
  type TerminalizeExamTargetAttemptInput,
} from '@/lib/exam-target/attempt-ledger.server';

type ManifoldExamTargetTransaction = ExamTargetDecisionTransaction
  & AtomicServeDecisionWriterClient;

/**
 * Count cards/questions in the user's primary rotation that they have never
 * seen, using the same filters the scheduler applies when serving items.
 * Used by feedMode='new-only' to power the "X new remaining" UI counter.
 *
 * Both where-clauses come from the shared servable-pool predicate so the
 * counter cannot drift from the scheduler — when the scheduler filters out
 * a card via getOpenIssueExclusions, this counter must filter it too.
 */
async function computeNewRemaining(
  ctx: SessionContext,
  poolFilters: ServablePoolFilters,
): Promise<{ cards: number; questions: number }> {
  const cardWhere = buildServableCardWhere({
    cluster: ctx.clusterFilter,
    rotation: ctx.rotation,
    week: ctx.weekFilter,
    newOnlyForUserId: ctx.userId,
    openIssueCardIds: poolFilters.openIssueCardIds,
    practiceLocale: ctx.practiceLocale,
  });
  const questionWhere = buildServableQuestionWhere({
    rotation: ctx.rotation,
    week: ctx.weekFilter,
    newOnlyForUserId: ctx.userId,
    openIssueQuestionIds: poolFilters.openIssueQuestionIds,
    globallyExcludedQuestionIds: poolFilters.globallyExcludedQuestionIds,
    allowPrivateSources: poolFilters.allowPrivateSources,
    practiceLocale: ctx.practiceLocale,
  });

  const [cards, questions] = await Promise.all([
    countCards(ownerPrivateOrSharedCardScope(ctx.userId), { where: cardWhere }),
    prisma.question.count({ where: questionWhere }),
  ]);
  return { cards, questions };
}

function scheduledItemKey(item: Pick<UnifiedSessionItem, 'type' | 'id'>): string {
  return `${item.type}:${item.id}`;
}

function isSchedulerProtectedItem(item: UnifiedSessionItem): boolean {
  return item.interventionReason === 'failure_escalation'
    || item.interventionReason === 'preemptive_scaffold'
    || item.struggleIntervention?.isScaffold === true;
}

/**
 * The control scheduler owns failure/scaffold membership. Exam targeting may
 * replace only the remaining discretionary seats; it cannot invent or remove
 * a protected teaching intervention. Scaffold anchors travel with their
 * scaffold so the paired teaching unit remains intact.
 */
function reconcilePairedSchedulerProtectedItems(
  controlItems: readonly UnifiedSessionItem[],
  targetItems: readonly UnifiedSessionItem[],
  batchSize: number,
): { control: UnifiedSessionItem[]; target: UnifiedSessionItem[] } {
  const fixedKeys = new Set(
    controlItems
      .filter(isSchedulerProtectedItem)
      .flatMap(item => [
        scheduledItemKey(item),
        ...(item.struggleIntervention?.targetCardId
          ? [`card:${item.struggleIntervention.targetCardId}`, `question:${item.struggleIntervention.targetCardId}`]
          : []),
      ]),
  );
  const fixedItems = controlItems.filter(item => fixedKeys.has(scheduledItemKey(item)));
  const fixedItemKeys = new Set(fixedItems.map(scheduledItemKey));
  const merge = (items: readonly UnifiedSessionItem[]) => [
    ...fixedItems,
    ...items.filter(item => (
      !fixedItemKeys.has(scheduledItemKey(item))
      && !isSchedulerProtectedItem(item)
    )),
  ].slice(0, batchSize);
  return {
    control: merge(controlItems),
    target: merge(targetItems),
  };
}

function toRuntimeTargetScalars(
  items: readonly UnifiedItem[],
  schedulerCandidateKeys: ReadonlySet<string>,
): RuntimeExamTargetFinalItemScalar[] {
  return items.map(item => {
    const itemKey = `${item.type}:${item.id}`;
    return {
      itemKey,
      sourceRotation: item.rotation,
      // The scheduler itself also uses needs_retest. Only a card added after
      // the paired scheduler is a protected due-backlog item.
      due: item.type === 'card'
        && item.interventionReason === 'needs_retest'
        && !schedulerCandidateKeys.has(itemKey),
      scaffold: item.interventionReason === 'preemptive_scaffold',
      failure: item.interventionReason === 'failure_escalation',
    };
  });
}

function examTargetDecisionKey(input: {
  sessionId: string;
  batchId: string;
  targetVersion: string;
  mode: 'shadow' | 'active';
  assignment: 'control' | 'treatment';
}): string {
  return createHash('sha256')
    .update('exam-target-decision-set/v1')
    .update('\0')
    .update(input.sessionId)
    .update('\0')
    .update(input.batchId)
    .update('\0')
    .update(input.targetVersion)
    .update('\0')
    .update(input.mode)
    .update('\0')
    .update(input.assignment)
    .digest('hex');
}

function isRunnableExamTargetLifecycle(
  lifecycle: unknown,
): lifecycle is 'validated' | 'active' {
  return lifecycle === 'validated' || lifecycle === 'active';
}

/**
 * Repository activation normally removes unusable snapshots before this path.
 * Keep the manifold boundary fail-closed as well: a stale or forged context
 * must not be promoted into a validated paired decision merely because it
 * still carries a snapshot object.
 */
function failClosedExamTargetLifecycle(
  examTarget: SessionContext['examTarget'],
): SessionContext['examTarget'] {
  if (
    !examTarget?.snapshot
    || isRunnableExamTargetLifecycle(examTarget.snapshot.lifecycle)
  ) {
    return examTarget;
  }

  const lifecycle = examTarget.snapshot.lifecycle as unknown;
  const resolved = examTarget.resolved.effectiveMode === 'off'
    ? examTarget.resolved
    : {
        effectiveMode: 'off' as const,
        assignment: 'control' as const,
        targetVersion: null,
        bypassReason: lifecycle === 'retired'
          ? 'snapshot-retired' as const
          : 'snapshot-unvalidated' as const,
      };
  return {
    ...examTarget,
    resolved,
    snapshot: null,
    loadFailureReason: lifecycle === 'built' || lifecycle === 'retired'
      ? examTarget.loadFailureReason
      : 'snapshot-metadata-mismatch',
  };
}

/**
 * Full manifold/scheduler path. Queries recent exposures, runs the concept scheduler,
 * hydrates content, interleaves groups, applies filters, and returns the session.
 * This is the most complete (and slowest) path — used when cache misses and filters are active.
 */
export async function buildManifoldSession(ctx: SessionContext): Promise<NextResponse> {
  let newRemaining: { cards: number; questions: number } | undefined;
  let poolFilters: ServablePoolFilters | undefined;
  let cacheEpoch: number | null = null;
  let fallbackSelectionDeterminism: UnifiedSessionSelectionDeterminism | undefined;
  const admittedAttempt = ctx.examTargetAttempt?.decisionPath === 'manifold-walk'
    ? ctx.examTargetAttempt
    : null;
  let attemptFinalized = false;
  let attemptFailureClass: ExamTargetAttemptFailureClass = 'precompute_failed';
  const settleAttempt = async (
    terminal: Omit<TerminalizeExamTargetAttemptInput, 'attemptId' | 'userId'>,
  ): Promise<void> => {
    if (!admittedAttempt || attemptFinalized) return;
    attemptFinalized = true;
    try {
      await terminalizeExamTargetDecisionAttempt(
        prisma as unknown as ExamTargetAttemptLedgerClient,
        {
          attemptId: admittedAttempt.id,
          userId: ctx.userId,
          ...terminal,
        },
      );
    } catch {
      logger.warn('exam-target-attempt-terminalization-failed', {
        code: 'terminalization-failed',
        rotation: ctx.rotation,
        decisionPath: admittedAttempt.decisionPath,
        outcome: terminal.outcome,
      });
    }
  };
  try {
    if (!ctx.hasFilters && !ctx.noCache && !ctx.isGuest) {
      try {
        cacheEpoch = await readSessionCacheEpoch(ctx.userId);
      } catch (error) {
        // Cache coordination must never demote an otherwise healthy scheduler
        // request into the emergency fallback path. Skip this cache write.
        logger.warn('Failed to read session cache epoch; serving without cache write', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(error),
        });
      }
    }
    const tExposureStart = performance.now();
    const [exclusionState, loadedPoolFilters] = await Promise.all([
      loadManifoldExclusionState(ctx),
      loadServablePoolFilters(ctx.userId),
    ]);
    poolFilters = loadedPoolFilters;
    const tExposureEnd = performance.now();

    // Open-issue card IDs must be visible to both the scheduler (which
    // already unions them via its own getOpenIssueExclusions call) and the
    // rescue path (which only sees exclusionState.excludedCardIds). Union
    // them in once here so the rescue path matches the scheduler's pool.
    for (const id of poolFilters.openIssueCardIds) exclusionState.excludedCardIds.add(id);
    for (const id of poolFilters.openIssueQuestionIds) exclusionState.excludedQuestionIds.add(id);

    const protectedLaneNow = new Date();
    // A cluster in the request means the learner chose a subject, and choosing a
    // subject is what licenses the drill: repeating what you just missed IS a
    // topic session, where in the daily feed it would crowd out a rotation's
    // worth of work. Everything else about the lane, including its anti-loop
    // guards, is unchanged.
    const relearnProfile = relearnProfileFor({ topicScoped: Boolean(ctx.clusterFilter) });
    let prefetchedRelearnCardIds: string[] = [];
    if (ctx.feedMode !== 'new-only') {
      try {
        prefetchedRelearnCardIds = await fetchRelearnCards(prisma, {
          userId: ctx.userId,
          rotation: ctx.rotation,
          allowedCrossSourceRotations: ctx.crossSourceRotations ?? [],
          weekFilter: ctx.weekFilter,
          limit: ctx.batchSize,
          now: protectedLaneNow,
          profile: relearnProfile,
        });
        // The lane's own cooldown/view cap advance only on a GRADE, so a
        // delivered-then-skipped card would otherwise lead every batch until
        // it was finally answered. Re-uses the ServeDecision rows the
        // exclusion state already loaded — no extra request-path query.
        prefetchedRelearnCardIds = capRelearnCardsByDelivery(
          prefetchedRelearnCardIds,
          exclusionState.recentCardDeliveries,
          {
            now: protectedLaneNow,
            studyDayStart: getStudyDayStart(protectedLaneNow),
            profile: relearnProfile,
          },
        );
      } catch (error) {
        logger.warn('relearn prefetch failed; continuing without reserved seats', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(error),
        });
      }
    }
    const protectedRelearnSeats = prefetchedRelearnCardIds.length > 0
      ? Math.min(
          prefetchedRelearnCardIds.length,
          ctx.batchSize,
          Math.max(1, Math.floor(ctx.batchSize * relearnProfile.reserveRatio)),
        )
      : 0;
    const commonRelearnIds = prefetchedRelearnCardIds.slice(0, protectedRelearnSeats);
    let prefetchedDueCards: Awaited<ReturnType<typeof fetchDueBacklogCards>> = [];
    if (ctx.feedMode !== 'new-only' && protectedRelearnSeats < ctx.batchSize) {
      const dueExcludedIds = new Set(exclusionState.excludedCardIds);
      // A failed card belongs to the more urgent relearn lane. Excluding every
      // prefetched lapse here keeps the two protected populations disjoint,
      // including candidates beyond this batch's bounded relearn reserve.
      for (const id of prefetchedRelearnCardIds) dueExcludedIds.add(id);
      try {
        const fetchedDueCards = await fetchDueBacklogCards(prisma, {
          userId: ctx.userId,
          rotation: ctx.rotation,
          allowedCrossSourceRotations: ctx.crossSourceRotations ?? [],
          weekFilter: ctx.weekFilter,
          excludeIds: dueExcludedIds,
          limit: ctx.batchSize - protectedRelearnSeats,
          now: protectedLaneNow,
        });
        const relearnIdSet = new Set(prefetchedRelearnCardIds);
        const seenDueIds = new Set<string>();
        prefetchedDueCards = fetchedDueCards.filter(card => {
          if (relearnIdSet.has(card.id) || seenDueIds.has(card.id)) return false;
          seenDueIds.add(card.id);
          return true;
        });
      } catch (error) {
        logger.warn('due-backlog prefetch failed; continuing without reserved seats', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(error),
        });
      }
    }
    // Reserve one ordinary due obligation whenever capacity remains after the
    // more urgent relearn prefix. Additional prefetched due cards can still
    // fill genuine scheduler underflow below, without issuing a second query.
    const protectedDueSeats = prefetchedDueCards.length > 0
      && protectedRelearnSeats < ctx.batchSize
      ? 1
      : 0;
    const protectedSeatCount = protectedRelearnSeats + protectedDueSeats;
    const discretionarySchedulerSize = Math.max(
      0,
      ctx.batchSize - protectedSeatCount,
    );

    if (ctx.feedMode === 'new-only') {
      // Counter is best-effort. If counts fail we still serve items; we just
      // omit newRemaining from the response rather than lying with 0/0.
      try {
        newRemaining = await computeNewRemaining(ctx, poolFilters);
      } catch (counterError) {
        logger.warn('computeNewRemaining failed; continuing without newRemaining', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          error: String(counterError),
        });
      }
    }

    // Start group queries early — they only need rotation, weekFilter,
    // enabledGroupTypes, and excludedGroupIds (all available now).
    // Runs in parallel with the scheduler below.
    const groupQueryPromise = fetchGroupItems(
      ctx.rotation,
      ctx.weekFilter,
      exclusionState.enabledGroupTypes,
      exclusionState.excludedGroupIds,
    );

    const tSchedulerStart = performance.now();
    const schedulerExamTarget = admittedAttempt
      ? failClosedExamTargetLifecycle(ctx.examTarget)
      : undefined;
    const pairExamTarget = schedulerExamTarget?.snapshot
      && schedulerExamTarget.resolved.effectiveMode !== 'off'
      ? schedulerExamTarget
      : null;
    const tieBreakSeed = pairExamTarget
      ? createHash('sha256')
          .update(ctx.sessionId)
          .update('\0')
          .update(pairExamTarget.resolved.targetVersion ?? '')
          .digest('hex')
      : undefined;
    const baseSchedulerOptions = {
      rotation: ctx.rotation,
      week: ctx.weekFilter ?? undefined,
      size: discretionarySchedulerSize,
      requestedBatchSize: ctx.batchSize,
      protectedSeatCount,
      // Target credit is intentionally conservative until protected cards are
      // classified against the same immutable mastery snapshot.
      protectedTargetSeatCount: 0,
      ...(tieBreakSeed ? { examTargetTieBreakSeed: tieBreakSeed } : {}),
      ...(ctx.mode ? { mode: ctx.mode } : {}),
      excludeCardIds: [...new Set([
        ...exclusionState.excludedCardIds,
        ...commonRelearnIds,
        ...prefetchedDueCards.map(card => card.id),
      ])],
      excludeQuestionIds: [...exclusionState.excludedQuestionIds],
      recentTopicExposures: exclusionState.recentTopicExposures,
      recentCardIds: exclusionState.recentCardIds,
      commitmentLevel: ctx.commitmentLevel,
      imageTier: ctx.imageTier,
      practiceLocale: ctx.practiceLocale,
      currentTeachingWeek: ctx.currentTeachingWeek,
      topicTeachingWeeks: ctx.topicTeachingWeeks,
      recentFigureExposures: ctx.recentFigureExposures,
      crossSourceRotations: ctx.crossSourceRotations,
      maxCrossSourceItems: ctx.maxCrossSourceItems
        ?? MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
      crossSourceMappingMode: ctx.crossSourceMappingMode ?? 'adjacent',
      clusterFilter: ctx.clusterFilter,
    };
    const pairedSelectionDeterminism = pairExamTarget && tieBreakSeed
      ? { nowMs: protectedLaneNow.getTime(), seed: tieBreakSeed }
      : undefined;
    fallbackSelectionDeterminism = pairedSelectionDeterminism;
    let controlSessionResult: Awaited<ReturnType<typeof constructUnifiedSession>> | null = null;
    let targetSessionResult: Awaited<ReturnType<typeof constructUnifiedSession>> | null = null;
    let sessionResult: Awaited<ReturnType<typeof constructUnifiedSession>>;
    attemptFailureClass = 'scheduler_compute_failed';
    if (pairExamTarget && pairedSelectionDeterminism) {
      const sharedReadContext = createUnifiedSchedulerSharedReadContext();
      const controlTarget = {
        ...pairExamTarget,
        resolved: {
          ...pairExamTarget.resolved,
          effectiveMode: 'shadow' as const,
          assignment: 'control' as const,
          bypassReason: null,
        },
      };
      const treatmentTarget = {
        ...pairExamTarget,
        resolved: {
          ...pairExamTarget.resolved,
          effectiveMode: 'active' as const,
          assignment: 'treatment' as const,
          bypassReason: null,
        },
      };
      [controlSessionResult, targetSessionResult] = await Promise.all([
        constructUnifiedSession(ctx.userId, {
          ...baseSchedulerOptions,
          examTarget: controlTarget,
          selectionDeterminism: pairedSelectionDeterminism,
          suppressSchedulerSideEffects: true,
          sharedReadContext,
        }),
        constructUnifiedSession(ctx.userId, {
          ...baseSchedulerOptions,
          examTarget: treatmentTarget,
          selectionDeterminism: pairedSelectionDeterminism,
          examTargetEvaluationOnly: true,
          suppressSchedulerSideEffects: true,
          sharedReadContext,
        }),
      ]);
      const reconciled = reconcilePairedSchedulerProtectedItems(
        controlSessionResult.items,
        targetSessionResult.items,
        ctx.batchSize,
      );
      controlSessionResult = { ...controlSessionResult, items: reconciled.control };
      targetSessionResult = { ...targetSessionResult, items: reconciled.target };
      sessionResult = pairExamTarget.resolved.effectiveMode === 'active'
        && pairExamTarget.resolved.assignment === 'treatment'
        ? targetSessionResult
        : controlSessionResult;
    } else {
      sessionResult = await constructUnifiedSession(ctx.userId, {
        ...baseSchedulerOptions,
        examTarget: schedulerExamTarget,
      });
    }
    const tSchedulerEnd = performance.now();
    attemptFailureClass = 'postprocess_failed';

    // Both paired arms receive the exact same protected prefix from the one
    // frozen relearn/due prefetch. Remove any mocked/upstream overlap first so
    // protected cards cannot appear twice, then trim only the discretionary
    // tail to preserve the batch cap.
    const allPrefetchedDueIds = new Set(prefetchedDueCards.map(card => card.id));
    const commonRelearnIdSet = new Set(commonRelearnIds);
    const countUnpinnedItems = (
      result: Awaited<ReturnType<typeof constructUnifiedSession>>,
    ) => result.items.filter(item => (
      item.type !== 'card'
      || (
        !commonRelearnIdSet.has(item.id)
        && !allPrefetchedDueIds.has(item.id)
      )
    )).length;
    const pinProtectedReviewPrefix = (
      result: Awaited<ReturnType<typeof constructUnifiedSession>>,
      dueSeatCount: number,
    ): Awaited<ReturnType<typeof constructUnifiedSession>> => {
      const dueCards = prefetchedDueCards.slice(0, dueSeatCount);
      const unpinnedItems = result.items.filter(item => (
        item.type !== 'card'
        || (
          !commonRelearnIdSet.has(item.id)
          && !allPrefetchedDueIds.has(item.id)
        )
      ));
      const withRelearn = selectRelearnReserve({
        conceptItems: unpinnedItems,
        relearnCardIds: commonRelearnIds,
        batchSize: ctx.batchSize,
      });
      const relearnPrefix = withRelearn.slice(0, commonRelearnIds.length);
      const schedulerTail = withRelearn.slice(commonRelearnIds.length);
      const duePrefix: UnifiedSessionItem[] = dueCards.map(card => ({
        type: 'card',
        id: card.id,
        conceptId: '',
        conceptName: '',
        priority: 0.5,
        interventionReason: 'needs_retest',
      }));
      return {
        ...result,
        items: [
          ...relearnPrefix,
          ...duePrefix,
          ...schedulerTail,
        ].slice(0, ctx.batchSize),
      };
    };
    const dueSeatsForUnpinnedCount = (unpinnedCount: number) => Math.min(
      prefetchedDueCards.length,
      Math.max(
        protectedDueSeats,
        ctx.batchSize - protectedRelearnSeats - unpinnedCount,
      ),
      Math.max(0, ctx.batchSize - protectedRelearnSeats),
    );

    if (controlSessionResult && targetSessionResult && pairExamTarget) {
      const commonDueSeats = ctx.feedMode === 'new-only'
        ? 0
        : dueSeatsForUnpinnedCount(Math.min(
            countUnpinnedItems(controlSessionResult),
            countUnpinnedItems(targetSessionResult),
          ));
      controlSessionResult = pinProtectedReviewPrefix(
        controlSessionResult,
        commonDueSeats,
      );
      targetSessionResult = pinProtectedReviewPrefix(
        targetSessionResult,
        commonDueSeats,
      );
      if (
        ctx.feedMode !== 'new-only'
        && (
          controlSessionResult.items.length === 0
          || targetSessionResult.items.length === 0
        )
      ) {
        const safeControl = controlSessionResult.items.length > 0
          ? controlSessionResult
          : ensureNonEmptyManifoldSession(
              ctx,
              controlSessionResult,
              exclusionState.excludedCardIds,
              pairedSelectionDeterminism,
            ) ?? controlSessionResult;
        controlSessionResult = safeControl;
        targetSessionResult = { ...targetSessionResult, items: safeControl.items };
      }
      sessionResult = pairExamTarget.resolved.effectiveMode === 'active'
        && pairExamTarget.resolved.assignment === 'treatment'
        ? targetSessionResult
        : controlSessionResult;
    } else {
      if (ctx.feedMode !== 'new-only') {
        sessionResult = pinProtectedReviewPrefix(
          sessionResult,
          dueSeatsForUnpinnedCount(countUnpinnedItems(sessionResult)),
        );
        sessionResult = ensureNonEmptyManifoldSession(
          ctx,
          sessionResult,
          exclusionState.excludedCardIds,
        ) ?? sessionResult;
      }
    }
    if (sessionResult.items.length === 0) {
      logger.info('unified-session-empty-pool', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        sessionId: ctx.sessionId,
        feedMode: ctx.feedMode ?? 'mixed',
        ...(newRemaining
          ? { newRemainingCards: newRemaining.cards, newRemainingQuestions: newRemaining.questions }
          : {}),
      });
      await settleAttempt({
        outcome: 'no_items',
        failureClass: null,
        servedDisposition: 'none',
        servedItemCount: 0,
        fallbackTracePersisted: null,
      });
      return NextResponse.json({
        items: [],
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
        ...(newRemaining ? { newRemaining } : {}),
      });
    }

    const tHydrationStart = performance.now();
    const scheduledUnion = [
      ...sessionResult.items,
      ...(controlSessionResult?.items ?? []),
      ...(targetSessionResult?.items ?? []),
    ].filter((item, index, items) => (
      items.findIndex(candidate => (
        candidate.type === item.type && candidate.id === item.id
      )) === index
    ));
    const hydrationData = await loadScheduledItemHydrationData({
      userId: ctx.userId,
      rotationContent: ctx.rotationContent,
      scheduledItems: scheduledUnion,
      deliveryContext: ctx,
    });
    const hydrateTrustOverride = ctx.imageTier === 'copyright'
      ? 'copyright-required' as const
      : ctx.isGuest ? 'public' as const : 'auth-required' as const;
    const hydrateVariant = (items: typeof sessionResult.items) => hydrateScheduledItems(
      items,
      hydrationData,
      { rotation: ctx.rotation },
      null,
      hydrateTrustOverride,
    );
    const [baseItems, controlBaseItems, targetBaseItems] = await Promise.all([
      hydrateVariant(sessionResult.items),
      controlSessionResult ? hydrateVariant(controlSessionResult.items) : Promise.resolve(null),
      targetSessionResult ? hydrateVariant(targetSessionResult.items) : Promise.resolve(null),
    ]);
    const tHydrationEnd = performance.now();

    // Await group queries (started before the scheduler for parallelism)
    const tGroupsStart = performance.now();
    const groupItems = await groupQueryPromise;
    const tGroupsEnd = performance.now();

    // Run the same post-scheduler safety pipeline over both halves of a paired
    // decision. Otherwise hydration, filters, source caps, or dedup could make
    // the recorded comparison differ from the batch that was actually eligible
    // for delivery. Warnings are emitted only for the branch we intend to serve.
    const prepareVariant = (
      variantBaseItems: typeof baseItems,
      reportWarnings: boolean,
    ) => {
      // interleaveGroups inserts a group item every `gap` positions in baseItems.
      // Re-apply the modality guard because an inserted item can extend a run.
      const merged = breakModalityRuns(interleaveGroups(variantBaseItems, groupItems));
      const filteredByRequest = applyManifoldFilters(merged, ctx);
      const capped = capCrossSourceSessionItems(filteredByRequest, {
        sessionRotation: ctx.rotation,
        allowedCrossSourceRotations: ctx.crossSourceRotations ?? [],
        maxCrossSourceItems: ctx.maxCrossSourceItems
          ?? MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
        getRotation: (item) => item.rotation,
      });
      if (reportWarnings && capped.length < filteredByRequest.length) {
        logger.warn('unified-session cross-source egress guard dropped items', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          sessionId: ctx.sessionId,
          dropped: filteredByRequest.length - capped.length,
        });
      }

      const filtered: typeof capped = [];
      const seenKeys = new Set<string>();
      let duplicates = 0;
      for (const item of capped) {
        const key = `${item.type}:${item.id}`;
        if (seenKeys.has(key)) {
          duplicates += 1;
          continue;
        }
        seenKeys.add(key);
        filtered.push(item);
      }
      // Group interleaving can expand an already-full scheduler batch. Apply
      // the request cap only after request filters, source egress checks, and
      // dedup so all three paired variants persist and serve the same bounded
      // final-order contract. This also keeps attempt servedItemCount within
      // the database's requestedSize constraint.
      const finalItems = filtered.slice(0, ctx.batchSize);
      if (reportWarnings && duplicates > 0) {
        logger.warn('unified-session in-session dedup dropped duplicates', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          sessionId: ctx.sessionId,
          feedMode: ctx.feedMode ?? 'mixed',
          duplicatesDropped: duplicates,
          served: finalItems.length,
        });
      }
      return { merged, filtered: finalItems };
    };

    const servingTreatment = Boolean(
      pairExamTarget
      && pairExamTarget.resolved.effectiveMode === 'active'
      && pairExamTarget.resolved.assignment === 'treatment',
    );
    const chosenPreparedBeforeDue = prepareVariant(baseItems, true);
    const controlPreparedBeforeDue = controlBaseItems
      ? prepareVariant(controlBaseItems, !servingTreatment)
      : null;
    const targetPreparedBeforeDue = targetBaseItems
      ? prepareVariant(targetBaseItems, servingTreatment)
      : null;
    const preparedDueCandidates = [
      ...chosenPreparedBeforeDue.filtered,
      ...(controlPreparedBeforeDue?.filtered ?? []),
      ...(targetPreparedBeforeDue?.filtered ?? []),
    ].filter((item, index, items) => (
      items.findIndex(candidate => (
        candidate.type === item.type && candidate.id === item.id
      )) === index
    ));
    const manifoldCardDue = await filterCardsAtDueEgress(preparedDueCandidates, {
      userId: ctx.userId,
      rotation: ctx.rotation,
      path: 'manifold',
      isGuest: ctx.isGuest,
    });
    const filterPreparedByCurrentDue = (
      prepared: typeof chosenPreparedBeforeDue,
    ) => ({
      merged: prepared.merged.filter(
        (item) => item.type !== 'card' || manifoldCardDue.eligibleCardIds.has(item.id),
      ),
      filtered: prepared.filtered.filter(
        (item) => item.type !== 'card' || manifoldCardDue.eligibleCardIds.has(item.id),
      ),
    });
    const chosenPrepared = filterPreparedByCurrentDue(chosenPreparedBeforeDue);
    const controlPrepared = controlPreparedBeforeDue
      ? filterPreparedByCurrentDue(controlPreparedBeforeDue)
      : null;
    const targetPrepared = targetPreparedBeforeDue
      ? filterPreparedByCurrentDue(targetPreparedBeforeDue)
      : null;
    const dueGateInvalidatedPair = Boolean(
      controlPreparedBeforeDue
      && targetPreparedBeforeDue
      && controlPrepared
      && targetPrepared
      && (
        controlPrepared.filtered.length !== controlPreparedBeforeDue.filtered.length
        || targetPrepared.filtered.length !== targetPreparedBeforeDue.filtered.length
      ),
    );
    if (manifoldCardDue.droppedCardCount > 0) {
      logger.info('Dropped not-due cards before manifold-session delivery', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        droppedCardCount: manifoldCardDue.droppedCardCount,
        lookupFailed: manifoldCardDue.lookupFailed,
        dueGateInvalidatedPair,
      });
    }

    const enrichVariant = async (prepared: typeof chosenPrepared) => {
      // SQL-side similarityToPrior keeps 3072-dim embeddings inside Postgres.
      const orderedForPairwise = prepared.filtered.map((it) => {
        const table: EmbeddingItemTable =
          it.type === 'question' ? 'question_embeddings'
          : it.type === 'card' ? 'card_embeddings'
          : 'video_embeddings';
        const column: EmbeddingItemIdColumn =
          it.type === 'question' ? 'question_id'
          : it.type === 'card' ? 'card_id'
          : 'video_id';
        return { id: it.id, table, column };
      });
      const similarityToPriorMap = await scoreOrderedPairwiseDistances(orderedForPairwise);
      const walkTagged = prepared.filtered.map((item) => ({
        ...item,
        servedBy: 'manifold-walk' as const,
        clusterId: item.clusterId ?? null,
        poolSize: prepared.merged.length,
        predictedRecall: item.predictedRecall ?? null,
        difficultyTier: item.difficultyTier ?? null,
      }));
      return enrichItemsWithWalkMetadata(walkTagged, similarityToPriorMap);
    };
    const [enrichedItems, controlEnrichedItems, targetEnrichedItems] = await Promise.all([
      enrichVariant(chosenPrepared),
      controlPrepared ? enrichVariant(controlPrepared) : Promise.resolve(null),
      targetPrepared ? enrichVariant(targetPrepared) : Promise.resolve(null),
    ]);
    const decorateVariant = (items: typeof enrichedItems) => items.map(item => ({
      ...item,
      decisionContext: {
        servedBy: 'manifold-walk' as const,
        sessionType: 'review' as const,
        sessionId: ctx.sessionId,
        embeddingType: 'concept-embedding' as const,
      },
    }));
    const chosenItemsForResponse = decorateVariant(enrichedItems);
    const controlItemsForResponse = decorateVariant(controlEnrichedItems ?? enrichedItems);
    const targetItemsForResponse = decorateVariant(targetEnrichedItems ?? enrichedItems);
    const liveWriteContext = {
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      batchId: ctx.batchId,
      rotation: ctx.rotation,
      decisionPath: 'manifold-walk',
      queueReason: 'manifold-walk',
    } as const;

    let finalSessionResult = sessionResult;
    let finalPrepared = chosenPrepared;
    let itemsWithDecisions: UnifiedItem[];

    if (
      dueGateInvalidatedPair
      && pairExamTarget
      && controlSessionResult
      && controlPrepared
    ) {
      // A point-in-time due change after paired scheduling can thin only one
      // arm. Persisting that as an experiment would compare unequal batch
      // shapes. Serve the independently safe control arm and terminalize the
      // attempt as a post-processing fallback instead.
      finalSessionResult = controlSessionResult;
      finalPrepared = controlPrepared;
      itemsWithDecisions = await writeLiveServeDecisions(
        controlItemsForResponse,
        liveWriteContext,
      );
      await settleAttempt(itemsWithDecisions.length > 0
        ? {
            outcome: 'control_fallback',
            failureClass: 'postprocess_failed',
            servedDisposition: 'control',
            servedItemCount: itemsWithDecisions.length,
            fallbackTracePersisted: false,
          }
        : {
            outcome: 'no_items',
            failureClass: 'postprocess_failed',
            servedDisposition: 'none',
            servedItemCount: 0,
            fallbackTracePersisted: null,
          });
    } else if (
      pairExamTarget
      && controlSessionResult
      && targetSessionResult
      && controlPrepared
      && targetPrepared
      && tieBreakSeed
      && admittedAttempt
    ) {
      const targetSnapshot = pairExamTarget.snapshot;
      if (!targetSnapshot) throw new Error('target-snapshot-unavailable');
      if (!isRunnableExamTargetLifecycle(targetSnapshot.lifecycle)) {
        throw new Error('target-snapshot-lifecycle-unavailable');
      }
      const effectiveMode = pairExamTarget.resolved.effectiveMode === 'active'
        ? 'active'
        : 'shadow';
      const assignment = pairExamTarget.resolved.assignment;
      const serveControl = async () => {
        finalSessionResult = controlSessionResult;
        finalPrepared = controlPrepared;
        return writeLiveServeDecisions(controlItemsForResponse, liveWriteContext);
      };
      attemptFailureClass = 'decision_build_failed';
      try {
        const schedulerDecision = targetSessionResult.examTargetDecision;
        if (!schedulerDecision) throw new Error('target-decision-unavailable');
        const tokenizer = loadExamTargetDecisionTokenizer();
        const schedulerCandidateKeys = new Set(
          schedulerDecision.candidatePool.map(candidate => candidate.itemKey),
        );
        const fallbackReason = pairExamTarget.resolved.bypassReason
          ?? (effectiveMode === 'shadow'
            ? 'shadow-serves-control'
            : assignment === 'control'
              ? 'control-assignment'
              : null);
        const sourcePolicy = {
          allowed: [...new Set(ctx.crossSourceRotations ?? [])]
            .filter(rotation => rotation !== targetSnapshot.rotation)
            .sort(),
          max: ctx.maxCrossSourceItems ?? MAX_CROSS_SOURCE_ITEMS_PER_SESSION,
        };
        const preparedDecision = buildRuntimeExamTargetDecision({
          identity: {
            decisionKey: examTargetDecisionKey({
              sessionId: ctx.sessionId,
              batchId: ctx.batchId,
              targetVersion: targetSnapshot.targetVersion,
              mode: effectiveMode,
              assignment,
            }),
            attemptId: admittedAttempt.id,
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            batchId: ctx.batchId,
            rotation: targetSnapshot.rotation,
            decisionPath: 'manifold-walk',
          },
          controlItems: toRuntimeTargetScalars(
            controlItemsForResponse,
            schedulerCandidateKeys,
          ),
          targetItems: toRuntimeTargetScalars(
            targetItemsForResponse,
            schedulerCandidateKeys,
          ),
          schedulerDecision,
          controlPlane: {
            mode: effectiveMode,
            assignment,
            fallbackReason,
          },
          activationSnapshot: {
            id: targetSnapshot.id,
            targetId: targetSnapshot.targetId,
            revision: targetSnapshot.revision,
            targetVersion: targetSnapshot.targetVersion,
            rotation: targetSnapshot.rotation,
            lifecycle: targetSnapshot.lifecycle,
            privacyValidated: targetSnapshot.privacyValidated,
            targetBasis: targetSnapshot.targetBasis,
            scorerVersion: targetSnapshot.scorerVersion,
            targetPolicyVersion: 'exam-target-policy-v2',
            artifactHash: targetSnapshot.artifactHash,
          },
          protectedRelearnCardIds: prefetchedRelearnCardIds.slice(0, protectedRelearnSeats),
          requestedSize: ctx.batchSize,
          targetComputeMs: Math.max(0, Math.ceil(tSchedulerEnd - tSchedulerStart)),
          tieBreakSeed,
          sourcePolicy,
          tokenizeItemKey: tokenizer,
          now: pairedSelectionDeterminism
            ? new Date(pairedSelectionDeterminism.nowMs)
            : new Date(),
        });
        const initiallySelectedItems = assignment === 'treatment'
          ? targetItemsForResponse
          : controlItemsForResponse;
        let atomicItems: UnifiedItem[] | null = null;
        const persistence = await persistExamTargetDecisionSet(preparedDecision, {
          client: prisma as unknown as ExamTargetDecisionPersistenceClient<
            ManifoldExamTargetTransaction
          >,
          tokenizeItemKey: tokenizer,
          writeServeDecisionTargets: async ({ transaction, receipt }) => {
            atomicItems = await writeLiveExamTargetServeDecisions(
              transaction,
              initiallySelectedItems,
              liveWriteContext,
              receipt,
            );
          },
          reportPersistenceFailure: report => {
            attemptFailureClass = report.failureReason === 'transaction_failed'
              ? 'persistence_transaction_failed'
              : 'telemetry_validation_failed';
            logger.warn('exam-target decision persistence failed', {
              rotation: ctx.rotation,
              sessionId: ctx.sessionId,
              mode: report.mode,
              assignment: report.assignment,
              reason: report.failureReason,
              failClosed: report.failClosed,
            });
          },
        });
        if (persistence.status === 'persisted') attemptFinalized = true;
        if (persistence.status !== 'persisted' || !atomicItems) {
          itemsWithDecisions = await serveControl();
          if (persistence.status !== 'persisted') {
            attemptFailureClass = persistence.failureReason === 'transaction_failed'
              ? 'persistence_transaction_failed'
              : 'telemetry_validation_failed';
            await settleAttempt(itemsWithDecisions.length > 0
              ? {
                  outcome: 'control_fallback',
                  failureClass: attemptFailureClass,
                  servedDisposition: 'control',
                  servedItemCount: itemsWithDecisions.length,
                  fallbackTracePersisted: false,
                }
              : {
                  outcome: 'no_items',
                  failureClass: attemptFailureClass,
                  servedDisposition: 'none',
                  servedItemCount: 0,
                  fallbackTracePersisted: null,
                });
          }
        } else if (persistence.servingDisposition === 'serve-treatment') {
          finalSessionResult = targetSessionResult;
          finalPrepared = targetPrepared;
          itemsWithDecisions = atomicItems;
        } else {
          finalSessionResult = controlSessionResult;
          finalPrepared = controlPrepared;
          itemsWithDecisions = atomicItems;
        }
      } catch (error) {
        const failureCode = error && typeof error === 'object'
          && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'runtime-failure';
        logger.warn('exam-target runtime fell back to control', {
          rotation: ctx.rotation,
          sessionId: ctx.sessionId,
          failureCode,
        });
        itemsWithDecisions = await serveControl();
        await settleAttempt(itemsWithDecisions.length > 0
          ? {
              outcome: 'control_fallback',
              failureClass: attemptFailureClass,
              servedDisposition: 'control',
              servedItemCount: itemsWithDecisions.length,
              fallbackTracePersisted: false,
            }
          : {
              outcome: 'no_items',
              failureClass: attemptFailureClass,
              servedDisposition: 'none',
              servedItemCount: 0,
              fallbackTracePersisted: null,
            });
      }
    } else {
      itemsWithDecisions = await writeLiveServeDecisions(
        chosenItemsForResponse,
        liveWriteContext,
      );
      if (admittedAttempt) {
        await settleAttempt(itemsWithDecisions.length > 0
          ? {
              outcome: 'control_fallback',
              failureClass: 'precompute_failed',
              servedDisposition: 'control',
              servedItemCount: itemsWithDecisions.length,
              fallbackTracePersisted: false,
            }
          : {
              outcome: 'no_items',
              failureClass: 'precompute_failed',
              servedDisposition: 'none',
              servedItemCount: 0,
              fallbackTracePersisted: null,
            });
      }
    }

    // Delivery-grounded side effects must follow the final control/treatment
    // disposition. A failed target transaction must never log target exposure.
    if (itemsWithDecisions.length > 0) {
      const returnedCardIds = itemsWithDecisions
        .filter(item => item.type === 'card')
        .map(item => item.id);
      if (returnedCardIds.length > 0) {
        after(async () => {
          try {
            await ensureCardProgressExists(ctx.userId, returnedCardIds);
          } catch (err) {
            logger.error('Failed to ensure card progress (manifold)', {
              userId: ctx.userId,
              cardCount: returnedCardIds.length,
              error: String(err),
            });
          }
        });
      }
      const exposureEvents = buildManifoldExposureEvents(
        itemsWithDecisions,
        ctx,
        manifoldCardDue.audit,
      );
      after(async () => {
        try {
          await prisma.learningEvent.createMany({ data: exposureEvents });
        } catch (err) {
          logger.error('Failed to log manifold queue exposures', {
            userId: ctx.userId,
            rotation: ctx.rotation,
            error: String(err),
          });
        }
      });
    }

    const availableFilters = collectAvailableFilters(finalPrepared.merged);
    const tTotal = performance.now();
    const timing = [
      `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
      `contentmap;dur=${ctx.tContentMapMs.toFixed(1)}`,
      `exposure;dur=${(tExposureEnd - tExposureStart).toFixed(1)}`,
      `scheduler;dur=${(tSchedulerEnd - tSchedulerStart).toFixed(1)}`,
      `hydration;dur=${(tHydrationEnd - tHydrationStart).toFixed(1)}`,
      `groups;dur=${(tGroupsEnd - tGroupsStart).toFixed(1)}`,
      `total;dur=${(tTotal - ctx.t0).toFixed(1)}`,
    ].join(', ');

    logger.info('unified-session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      sessionId: ctx.sessionId,
      version: 'manifold',
      items: itemsWithDecisions.length,
      feedMode: ctx.feedMode ?? 'mixed',
      ...(newRemaining
        ? { newRemainingCards: newRemaining.cards, newRemainingQuestions: newRemaining.questions }
        : {}),
      authMs: +(ctx.tAuthEnd - ctx.t0).toFixed(1),
      exposureMs: +(tExposureEnd - tExposureStart).toFixed(1),
      schedulerMs: +(tSchedulerEnd - tSchedulerStart).toFixed(1),
      hydrationMs: +(tHydrationEnd - tHydrationStart).toFixed(1),
      groupsMs: +(tGroupsEnd - tGroupsStart).toFixed(1),
      totalMs: +(tTotal - ctx.t0).toFixed(1),
    });

    logSessionDiagnostic(ctx, {
      path: 'manifold',
      itemCount: itemsWithDecisions.length,
      totalMs: +(tTotal - ctx.t0).toFixed(1),
      exclusionCounts: {
        recentCards: exclusionState.excludedCardIds.size,
        recentQuestions: exclusionState.excludedQuestionIds.size,
        clientCards: ctx.clientExcludeCardSet.size,
        clientQuestions: ctx.clientExcludeQuestionSet.size,
      },
    });

    // Write session cache for next request (background, non-blocking).
    // Embeddings are no longer attached to items (similarityToPrior now comes
    // from SQL via scoreOrderedPairwiseDistances), so no stripping is needed.
    // Cache the items *with* serveDecisionIds so cache-served items can attribute
    // back to the original decision row.
    const cacheItems = itemsWithDecisions;
    if (!ctx.hasFilters && !ctx.noCache && !ctx.isGuest && cacheItems.length > 0 && cacheEpoch != null) {
      const expectedCacheEpoch = cacheEpoch;
      after(async () => {
        try {
          const written = await upsertSessionCache(
            ctx.userId,
            ctx.rotation,
            cacheItems,
            expectedCacheEpoch,
          );
          if (!written) {
            logger.info('Skipped stale manifold cache write after invalidation', {
              userId: ctx.userId,
              rotation: ctx.rotation,
            });
          }
        } catch (err) {
          logger.error('Failed to write session cache', {
            userId: ctx.userId,
            rotation: ctx.rotation,
            error: String(err),
          });
        }
      });
    }

    return NextResponse.json(
      {
        items: itemsWithDecisions,
        stats: {
          totalItems: itemsWithDecisions.length,
          version: 'manifold',
          composition: collectItemComposition(itemsWithDecisions),
          conceptStats: finalSessionResult.stats,
        },
        availableFilters,
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
        ...(newRemaining ? { newRemaining } : {}),
      },
      { headers: { 'Server-Timing': timing } },
    );
  } catch (error) {
    const totalMs = +(performance.now() - ctx.t0).toFixed(1);
    const errorDetail = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.error('Error getting study session', {
      userId: ctx.userId,
      rotation: ctx.rotation,
      totalMs,
      error: errorDetail,
      stack: errorStack,
    });

    const unavailableResponse = () => NextResponse.json(
      {
        error: 'Failed to get session',
        code: 'session_unavailable',
        retryable: true,
        sessionId: ctx.sessionId,
        batchId: ctx.batchId,
      },
      { status: 503, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' } },
    );

    // Narrowed requests must fail closed. The emergency fallback is a static
    // card reserve and cannot prove type/difficulty/topic/module/review-mode
    // membership; serving it would silently widen the learner's chosen scope.
    // New-only additionally requires all-time exclusions the fallback lacks.
    const hasNarrowingRequestFilter = Boolean(
      ctx.typeFilter
      || ctx.difficultyFilter
      || ctx.topicsFilter
      || ctx.clusterFilter
      || ctx.modulesFilter
      || ctx.mode
      || ctx.reviewFilter,
    );
    if (ctx.feedMode === 'new-only' || hasNarrowingRequestFilter) {
      await settleAttempt({
        outcome: 'request_failed',
        failureClass: attemptFailureClass,
        servedDisposition: 'none',
        servedItemCount: 0,
        fallbackTracePersisted: null,
      });
      return unavailableResponse();
    }

    // Pass the open-issue card IDs (loaded before the exception, if we got that
    // far) so the error-fallback pool also drops flagged cards — matching the
    // EXCLUDED_POOL_TOPICS filter buildErrorFallbackItems now applies.
    try {
      const fallbackItems = buildErrorFallbackItems(
        ctx,
        new Set(poolFilters?.openIssueCardIds ?? []),
        fallbackSelectionDeterminism,
      );
      if (fallbackItems.length > 0) {
        // Static fallback content selects identities only. Even on an error
        // path, an unverifiable or replaced clinical answer must not escape.
        const fallbackScheduled: UnifiedSessionItem[] = fallbackItems.map(item => ({
          type: 'card', id: item.id, priority: item.priority ?? 1,
          conceptId: '', conceptName: '', interventionReason: 'reinforcement',
        }));
        const [fallbackHydration, fallbackCardDue] = await Promise.all([
          loadScheduledItemHydrationData({
            userId: ctx.userId, rotationContent: ctx.rotationContent,
            scheduledItems: fallbackScheduled, deliveryContext: ctx,
          }),
          filterCardsAtDueEgress(fallbackItems, {
            userId: ctx.userId, rotation: ctx.rotation,
            path: 'fallback-error', isGuest: ctx.isGuest,
          }),
        ]);
        const currentFallbackItems = await hydrateScheduledItems(
          fallbackScheduled, fallbackHydration, { rotation: ctx.rotation }, null,
          ctx.imageTier === 'copyright' ? 'copyright-required' : ctx.isGuest ? 'public' : 'auth-required',
        );
        const dueSafeFallbackItems = currentFallbackItems.filter(item => fallbackCardDue.eligibleCardIds.has(item.id));
        if (dueSafeFallbackItems.length === 0) {
          await settleAttempt({
            outcome: 'request_failed',
            failureClass: attemptFailureClass,
            servedDisposition: 'none',
            servedItemCount: 0,
            fallbackTracePersisted: null,
          });
          return unavailableResponse();
        }
        logger.warn('Serving fallback cards after manifold error', {
          userId: ctx.userId,
          rotation: ctx.rotation,
          totalMs,
          items: dueSafeFallbackItems.length,
          error: errorDetail,
        });
        logSessionDiagnostic(ctx, {
          path: 'fallback-error',
          itemCount: dueSafeFallbackItems.length,
          totalMs,
          extra: { error: errorDetail.slice(0, 200) },
        });
        const taggedFallbackItems = dueSafeFallbackItems.map((item) => ({
          ...item,
          decisionContext: {
            servedBy: 'manifold-walk' as const,
            sessionType: 'review' as const,
            sessionId: ctx.sessionId,
            embeddingType: 'concept-embedding' as const,
          },
        }));

        // Stamp serveDecisionId on fallback items too so /record can attribute.
        const taggedFallbackItemsWithDecisions = await writeLiveServeDecisions(
          taggedFallbackItems,
          {
            userId: ctx.userId,
            sessionId: ctx.sessionId,
            batchId: ctx.batchId,
            rotation: ctx.rotation,
            decisionPath: 'manifold-walk',
            queueReason: 'fallback-error',
          },
        );
        logExposures(taggedFallbackItemsWithDecisions, {
          userId: ctx.userId,
          rotation: ctx.rotation,
          queueType: 'fallback-error',
          batchId: ctx.batchId,
          sessionId: ctx.sessionId,
          anonymousSessionId: ctx.anonymousSessionId,
          feedMode: ctx.feedMode,
          cardDueAudit: fallbackCardDue.audit,
        });

        await settleAttempt(taggedFallbackItemsWithDecisions.length > 0
          ? {
              outcome: 'control_fallback',
              failureClass: attemptFailureClass,
              servedDisposition: 'control',
              servedItemCount: taggedFallbackItemsWithDecisions.length,
              fallbackTracePersisted: false,
            }
          : {
              outcome: 'no_items',
              failureClass: attemptFailureClass,
              servedDisposition: 'none',
              servedItemCount: 0,
              fallbackTracePersisted: null,
            });

        return NextResponse.json(
          {
            items: taggedFallbackItemsWithDecisions,
            stats: {
              totalItems: taggedFallbackItemsWithDecisions.length,
              version: 'fallback-error',
              composition: collectItemComposition(taggedFallbackItemsWithDecisions),
            },
            availableFilters: { types: [], difficulties: [], topics: [] },
            sessionId: ctx.sessionId,
            batchId: ctx.batchId,
          },
          {
            headers: {
              'Server-Timing': `total;dur=${(performance.now() - ctx.t0).toFixed(1)},fallback;desc="scheduler_error"`,
            },
          },
        );
      }
    } catch {
      await settleAttempt({
        outcome: 'request_failed',
        failureClass: attemptFailureClass,
        servedDisposition: 'none',
        servedItemCount: 0,
        fallbackTracePersisted: null,
      });
      return unavailableResponse();
    }

    await settleAttempt({
      outcome: 'request_failed',
      failureClass: attemptFailureClass,
      servedDisposition: 'none',
      servedItemCount: 0,
      fallbackTracePersisted: null,
    });
    return unavailableResponse();
  }
}
