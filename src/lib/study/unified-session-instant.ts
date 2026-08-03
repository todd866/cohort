import { NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { shuffle } from '@/lib/utils/shuffle';
import { getExcludedQuestionIds, getQuestionOptions, type DisplayOption } from '@/lib/question-bank';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import {
  admitMasteredWithinBudget,
  freshnessTier,
  resolveRetirementPolicy,
  retiredQuestionIds as computeRetiredQuestionIds,
  type QuestionFamiliarity,
} from '@/lib/knowledge/question-retirement';
import { loadQuestionFamiliarity } from '@/lib/knowledge/bulk-candidates';
import {
  prioritizeLeastRecentlyServedContrastSiblings,
  questionSuppressionKey,
} from '@/lib/knowledge/variant-suppression';
import type { OptionCombination } from '@/lib/question-bank/types';
import type { UnifiedItem, SessionContext } from './unified-session-types';
import { selectInstantQuestionCandidates, logExposures } from './unified-session-helpers';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import { runSessionCacheRefresh } from './unified-session-cache-refresh';
import { enrichItemsWithWalkMetadata, tierFromComplexity } from '@/lib/audit/walk-metadata';
import { breakModalityRuns } from '@/lib/knowledge/modality-guard';
import { planPreemptiveScaffoldInsertions } from '@/lib/knowledge/preemptive-scaffold';
import {
  scoreOrderedPairwiseDistances,
  type EmbeddingItemTable,
  type EmbeddingItemIdColumn,
} from '@/lib/manifold/scoring';
import { imageKeyIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { writeLiveServeDecisions } from './serve-decision-write';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

/**
 * Fast path: no cache → return static cards instantly, compute manifold in background.
 * Next request will hit the freshly-populated cache (~50ms).
 * Guests also use this path — no point running the full manifold for cookie-tracked users.
 * Returns null if scheduler-only filters are active or not enough static content
 * (falls through to manifold). Difficulty-only filters are safe on static content.
 */
export async function tryInstantSession(ctx: SessionContext): Promise<NextResponse | null> {
  const hasInstantUnsafeFilters = !!(
    ctx.typeFilter ||
    ctx.topicsFilter ||
    ctx.modulesFilter ||
    ctx.mode ||
    ctx.feedMode
  );
  if (ctx.noCache || hasInstantUnsafeFilters) return null;

  // Lightweight exclusion: recently reviewed/exposed cards + answered questions (24h/48h).
  // Prevents serving the same cards after a page reload. Runs one indexed query — fast.
  const recentExcludedCardIds = new Set(ctx.clientExcludeCardSet);
  const recentExcludedQuestionIds = new Set(ctx.clientExcludeQuestionSet);

  // Flagged (open-issue) content must never be served — even on the fast path,
  // even to guests. The manifold/cache paths exclude it; the instant path used
  // to leak it, so flagging didn't actually stop serving the broken item.
  // Mirrors servable-pool's resilient fetch (empty sets on failure).
  const openIssue = await getOpenIssueExclusions().catch(() => ({
    cardIds: new Set<string>(),
    questionIds: new Set<string>(),
  }));
  for (const id of openIssue.questionIds) recentExcludedQuestionIds.add(id);

  // Hoisted: the question selection below needs this, and it is loaded inside the
  // non-guest block. Guests have no history, so an empty map is correct for them.
  let questionFamiliarity = new Map<string, QuestionFamiliarity>();

  if (!ctx.isGuest) {
    const cardCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const questionCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const rotationQuestionIds = ctx.rotationContent.questionList.map((q) => q.id);
    const [recentEvents, recentResponses, familiarity] = await Promise.all([
      prisma.learningEvent.findMany({
        where: {
          userId: ctx.userId,
          sourceType: { in: ['card', 'question'] },
          eventType: { in: ['card_reviewed', 'mcq_attempted', 'content_exposed'] },
          timestamp: { gte: questionCutoff },
        },
        select: { sourceId: true, sourceType: true, timestamp: true },
      }),
      prisma.questionResponse.findMany({
        where: { userId: ctx.userId, createdAt: { gte: questionCutoff } },
        select: { questionId: true },
        distinct: ['questionId'],
      }),
      // Per-question exposure for this rotation, scoped to the rotation's ids so this
      // fast path stays fast. Replaces a mastered-only groupBy: mastery no longer
      // excludes (question-retirement.ts), but this lane has NO ranking stage — it
      // shuffles — so it needs the familiarity map to sink mastered questions and
      // enforce the session cap itself.
      rotationQuestionIds.length > 0
        ? loadQuestionFamiliarity(
            prisma as unknown as Parameters<typeof loadQuestionFamiliarity>[0],
            ctx.userId,
            rotationQuestionIds,
          )
        : Promise.resolve(new Map()),
    ]);
    for (const event of recentEvents) {
      if (event.sourceType === 'card' && event.timestamp >= cardCutoff) {
        recentExcludedCardIds.add(event.sourceId);
      }
      if (event.sourceType === 'question') {
        recentExcludedQuestionIds.add(event.sourceId);
      }
    }
    for (const r of recentResponses) {
      recentExcludedQuestionIds.add(r.questionId);
    }
    questionFamiliarity = familiarity;
    // Empty under the live policy; restores the legacy kill-switch under the env var.
    for (const questionId of computeRetiredQuestionIds(
      [...familiarity].filter(([, f]) => freshnessTier(f) === 2).map(([id]) => id),
      resolveRetirementPolicy()
    )) {
      recentExcludedQuestionIds.add(questionId);
    }
  }

  const globallyExcludedQuestionIds = await getExcludedQuestionIds();
  const staticCards = ctx.rotationContent.cardList.filter(
    (card) => (ctx.weekFilter === null || card.week === ctx.weekFilter)
      && !recentExcludedCardIds.has(card.id)
      && !openIssue.cardIds.has(card.id)
      && (!ctx.difficultyFilter || card.difficulty === ctx.difficultyFilter)
      // Image-as-prompt cards are copyright-tier only (useless without the image).
      && (ctx.imageTier === 'copyright' || card.imageRole !== 'prompt')
  );
  const staticQuestions = selectInstantQuestionCandidates(
    ctx.rotationContent.questionList,
    {
      rotation: ctx.rotation,
      weekFilter: ctx.weekFilter,
      clientExcludeQuestionSet: recentExcludedQuestionIds,
      globallyExcludedQuestionIds,
    },
  ).filter((question) => !ctx.difficultyFilter || question.difficulty === ctx.difficultyFilter);

  if (staticCards.length === 0 && staticQuestions.length === 0) return null;

  // Mix cards and questions roughly 60/40
  const cardCount = Math.min(Math.ceil(ctx.batchSize * 0.6), staticCards.length);
  const questionCount = Math.min(ctx.batchSize - cardCount, staticQuestions.length);
  // Sibling suppression applied AFTER shuffle so a different cloze variant wins
  // across sessions. Filter-time suppression would deterministically pick the
  // first sibling in content-map order, killing rotation. Mirrors the live
  // scheduler (pickCardCandidate in unified-scheduler.ts).
  const shuffledCards = shuffle(staticCards);
  const selectedCards: typeof shuffledCards = [];
  const seenVariantGroups = new Set<string>();
  for (const card of shuffledCards) {
    if (selectedCards.length >= cardCount) break;
    if (card.variantGroupId != null) {
      if (seenVariantGroups.has(card.variantGroupId)) continue;
      seenVariantGroups.add(card.variantGroupId);
    }
    selectedCards.push(card);
  }
  // Shuffle for variety FIRST, then gate: admitMasteredWithinBudget preserves order
  // within each tier, so mastered questions sink while the fresh pool stays random.
  //
  // This lane has no ranking stage — it is a raw shuffle — so without this gate a
  // user with 885 mastered questions would get them back at the same rate as
  // never-seen ones the moment mastery stopped excluding. It runs on EVERY cache
  // miss and the cache is invalidated on EVERY grade (api/study/record/route.ts:81),
  // so it is a hot path during active study, not a guest-only path. Leaving it
  // ungated re-opened 15988863 ("instant fast-path was serving flagged + mastered
  // content"); caught by adversarial review before it shipped.
  // Question sibling suppression. This lane had NONE — seenVariantGroups above is
  // CARDS ONLY — so two members of a contrast family could be served in the same
  // session, on the hottest lane there is. Cards had it; questions were simply missed.
  // Scoped via questionSuppressionKey so it suppresses real families (contrast-set,
  // near-duplicate) without collapsing topic buckets. See variant-suppression.ts.
  const randomizedQuestions = shuffle(staticQuestions);
  const unmasteredQuestions = randomizedQuestions.filter(
    (question) => freshnessTier(questionFamiliarity.get(question.id)) !== 2,
  );
  const masteredQuestions = randomizedQuestions.filter(
    (question) => freshnessTier(questionFamiliarity.get(question.id)) === 2,
  );
  const seenQuestionGroups = new Set<string>();
  const suppressSiblings = (questions: typeof randomizedQuestions) =>
    prioritizeLeastRecentlyServedContrastSiblings(
      questions,
      (question) => question.id,
      questionFamiliarity,
    ).filter((question) => {
      const key = questionSuppressionKey(question);
      if (!key) return true;
      if (seenQuestionGroups.has(key)) return false;
      seenQuestionGroups.add(key);
      return true;
    });

  // This no-ranking lane's existing mastery contract is stronger than recency:
  // mastered questions are eligible only after distinct unmastered siblings cannot
  // fill the request. Suppress within the unmastered tier first, then add all-mastered
  // families behind it. That makes "least recent" explicit without letting an old
  // mastered sibling displace a usable unmastered one from the same family.
  const siblingSafeQuestions = [
    ...suppressSiblings(unmasteredQuestions),
    ...suppressSiblings(masteredQuestions),
  ];

  const selectedQuestions = admitMasteredWithinBudget(
    siblingSafeQuestions,
    (q) => q.id,
    questionFamiliarity,
    questionCount,
    resolveRetirementPolicy(),
    { masteredServed: 0 },
  ).slice(0, questionCount);

  // Query attempt counts so the shuffle varies per re-encounter
  const instantAttemptCounts: Record<string, number> = {};
  const instantLastCorrectDisplayPositions: Record<string, number> = {};
  if (selectedQuestions.length > 0 && !ctx.isGuest) {
    const qIds = selectedQuestions.map((q) => q.id);
    const [responses, recentPositions] = await Promise.all([
      prisma.questionResponse.groupBy({
        by: ['questionId'],
        where: { userId: ctx.userId, questionId: { in: qIds } },
        _count: { id: true },
      }),
      prisma.questionResponse.findMany({
        where: {
          userId: ctx.userId,
          questionId: { in: qIds },
          correctDisplayPosition: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          questionId: true,
          correctDisplayPosition: true,
        },
      }),
    ]);
    for (const r of responses) {
      instantAttemptCounts[r.questionId] = r._count.id;
    }
    for (const r of recentPositions) {
      if (instantLastCorrectDisplayPositions[r.questionId] != null) continue;
      if (r.correctDisplayPosition == null) continue;
      instantLastCorrectDisplayPositions[r.questionId] = r.correctDisplayPosition;
    }
  }

  // Resolve signed image URLs at egress — imageUrl from static content is the
  // stable /figures/... key; resolveImage mints a fresh signed R2 URL and gates
  // on the viewer's trust tier.
  const session = ctx.isGuest ? null : await auth();

  async function hydrateInstantCard(
    c: (typeof ctx.rotationContent.cardList)[number],
    interventionReason?: UnifiedItem['interventionReason'],
  ): Promise<UnifiedItem | null> {
    // Mirror the hydration lane's resilience: one bad sidecar or signing
    // failure must degrade that card to imageless, not 500 the session.
    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(c.imageUrl ?? null, session);
    } catch (err) {
      logger.warn('instant: card image resolve failed', { cardId: c.id, err });
    }
    // An image-as-prompt card without its figure is unanswerable ("the
    // appearance shown: [___]"). The pre-filter gates on ctx.imageTier while
    // resolveImage gates on the auth() session; if those diverge, drop the
    // card rather than serve a broken one.
    if (c.imageRole === 'prompt' && !resolved) return null;
    return {
      type: 'card',
      id: c.id,
      front: c.front,
      back: c.back,
      backs: (c.backs as string[] | null) ?? null,
      context: c.context ?? null,
      sourceComponent: c.sourceComponent,
      rotation: c.rotation || ctx.rotation,
      week: c.week ?? null,
      complexity: c.complexity,
      difficulty: c.difficulty,
      topics: c.topics,
      crosslinks: (c.crosslinks as UnifiedItem['crosslinks']) ?? null,
      clusterId: c.clusterId ?? null,
      variantGroupId: c.variantGroupId ?? null,
      variantIndex: c.variantIndex ?? null,
      variantType: c.variantType ?? null,
      imageUrl: resolved?.imageUrl ?? null,
      imageKey: resolved?.imageKey ?? null,
      imageCaption: c.imageCaption ?? null,
      imageMeta: resolved?.imageMeta,
      interventionReason,
      priority: 1,
      liked: false,
      flagged: false,
    };
  }

  const instantItems: UnifiedItem[] = [
    // Cards in the static content list DO carry imageUrl (913 of them, 26 with
    // `imageRole: 'prompt'`). Resolve them exactly like questions below: without
    // this an image-as-prompt card ships with no figure and its front — "the
    // appearance shown: [___]" — is unanswerable. The `imageRole !== 'prompt'`
    // filter above exists precisely because these cards are useless without the
    // image, so dropping it here defeated that guard.
    ...(await Promise.all(selectedCards.map((card) => hydrateInstantCard(card))))
      .filter((item): item is UnifiedItem => item !== null),
    ...(await Promise.all(selectedQuestions.map(async (q): Promise<UnifiedItem | null> => {
      const displayOptions = getQuestionOptions(
        {
          id: q.id,
          options: (q.options as Array<{ text: string; isCorrect: boolean }>) ?? [],
          combinations: (q.combinations as OptionCombination[]) ?? null,
          correctVariants: (q.correctVariants as string[]) ?? null,
        },
        instantAttemptCounts[q.id] ?? 0,
        {
          avoidCorrectDisplayPosition: instantLastCorrectDisplayPositions[q.id] ?? null,
        },
      );
      let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
      try {
        resolved = await resolveImage(q.imageUrl ?? null, session);
      } catch (err) {
        logger.warn('instant: question image resolve failed', { questionId: q.id, err });
      }
      if (imageKeyIsPrompt(q.imageUrl) && !resolved) return null;
      return {
        type: 'question',
        id: q.id,
        stem: q.stem,
        options: displayOptions as DisplayOption[],
        context: q.context ?? null,
        imageUrl: resolved?.imageUrl ?? null,
        imageKey: resolved?.imageKey ?? null,
        imageMeta: resolved?.imageMeta,
        rotation: q.rotation || ctx.rotation,
        week: q.week ?? null,
        topics: q.topics,
        difficulty: q.difficulty,
        priority: 1,
        liked: false,
        flagged: false,
      };
    }))).filter((item): item is UnifiedItem => item !== null),
  ];
  // Interleave cards and questions, then enforce modality-run cap so the
  // shuffle doesn't accidentally trip the audit's modality-monotony pathology
  // when one type happens to land in a long contiguous block.
  const modalityBoundInstant = breakModalityRuns(shuffle(instantItems));

  // The instant lane used to bypass the manifold scheduler's pre-emptive
  // scaffold pass entirely. Reuse the same bounded planner, then hydrate each
  // chosen static C1 through this lane's signed-image boundary.
  const scaffoldInsertions = planPreemptiveScaffoldInsertions(modalityBoundInstant, {
    rotation: ctx.rotation,
    candidateCards: staticCards,
  });
  const insertionByIndex = new Map(
    scaffoldInsertions.map((insertion) => [insertion.afterIndex, insertion]),
  );
  const scaffoldPairedInstant: UnifiedItem[] = [];
  for (let i = 0; i < modalityBoundInstant.length; i++) {
    scaffoldPairedInstant.push(modalityBoundInstant[i]);
    const insertion = insertionByIndex.get(i);
    if (!insertion) continue;
    const source = ctx.rotationContent.cards[insertion.card.id];
    if (!source) continue;
    const scaffold = await hydrateInstantCard(source, 'preemptive_scaffold');
    if (scaffold) scaffoldPairedInstant.push(scaffold);
  }
  // Pair insertion can lengthen an existing card run; retain the same final
  // modality guard used by the manifold lane.
  const shuffledInstant = breakModalityRuns(scaffoldPairedInstant);

  const tInstantEnd = performance.now();
  const instantTiming = [
    `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
    `instant;dur=${(tInstantEnd - ctx.tAuthEnd).toFixed(1)}`,
    `total;dur=${(tInstantEnd - ctx.t0).toFixed(1)}`,
  ].join(', ');

  logger.info('unified-session instant response (cache miss)', {
    userId: ctx.userId, rotation: ctx.rotation, items: shuffledInstant.length,
    totalMs: +(tInstantEnd - ctx.t0).toFixed(1),
  });

  logSessionDiagnostic(ctx, {
    path: 'instant',
    itemCount: shuffledInstant.length,
    totalMs: +(tInstantEnd - ctx.t0).toFixed(1),
    cacheState: 'miss',
    exclusionCounts: {
      recentCards: recentExcludedCardIds.size,
      recentQuestions: recentExcludedQuestionIds.size,
      clientCards: ctx.clientExcludeCardSet.size,
      clientQuestions: ctx.clientExcludeQuestionSet.size,
    },
  });

  // Compute manifold session in background for next request (skip for guests — no cache)
  if (!ctx.isGuest) {
    after(async () => {
      await runSessionCacheRefresh(ctx, { recordOutcome: true, source: 'instant' });
    });
  }

  // SQL-side similarityToPrior — no embedding bytes leave Postgres.
  const orderedForPairwise = shuffledInstant.map((it) => {
    const table: EmbeddingItemTable = it.type === 'question' ? 'question_embeddings' : 'card_embeddings';
    const column: EmbeddingItemIdColumn = it.type === 'question' ? 'question_id' : 'card_id';
    return { id: it.id, table, column };
  });
  const similarityToPriorMap = await scoreOrderedPairwiseDistances(orderedForPairwise);

  const taggedInstantRaw = shuffledInstant.map((item) => ({
    ...item,
    // Top-level walk fields (Phase 1 of scheduler-walk-audit)
    servedBy: 'instant' as const,
    clusterId: item.clusterId ?? null,
    poolSize: shuffledInstant.length,
    predictedRecall: null as number | null,
    difficultyTier: tierFromComplexity(item.complexity),
    // Existing decisionContext preserved for backward compat
    decisionContext: {
      servedBy: 'cached' as const,
      sessionType: 'review' as const,
      sessionId: ctx.sessionId,
      embeddingType: 'none' as const,
    },
  }));
  const taggedInstant = enrichItemsWithWalkMetadata(taggedInstantRaw, similarityToPriorMap);

  // The static content map may predate a cross-list membership change. Perform
  // a final current-row check after local option hydration and before any
  // ServeDecision, exposure, or response serialization. Fail closed for
  // questions if the lookup itself is unavailable; cards may still be served.
  const taggedQuestionIds = taggedInstant
    .filter((item) => item.type === 'question')
    .map((item) => item.id);
  let eligibleQuestionIds = new Set<string>();
  if (taggedQuestionIds.length > 0) {
    try {
      const eligibleRows = await prisma.question.findMany({
        where: withoutRawPublicUsmleQuestions({ id: { in: taggedQuestionIds } }),
        select: { id: true },
      });
      eligibleQuestionIds = new Set(eligibleRows.map((question) => question.id));
    } catch (error) {
      logger.error('instant: question eligibility lookup failed; dropping questions', {
        userId: ctx.userId,
        rotation: ctx.rotation,
        error: String(error),
      });
    }
  }
  const eligibleInstantCards = await filterDeliverableReinforcementCardRows(
    taggedInstant.filter((item) => item.type === 'card'),
    { logContext: { path: 'instant', userId: ctx.userId, rotation: ctx.rotation } },
  );
  const eligibleInstantCardIds = new Set(eligibleInstantCards.map((card) => card.id));
  const egressSafeTaggedInstant = taggedInstant.filter((item) => {
    if (item.type === 'question') return eligibleQuestionIds.has(item.id);
    if (item.type === 'card') return eligibleInstantCardIds.has(item.id);
    return true;
  });
  if (egressSafeTaggedInstant.length === 0) return null;

  const taggedInstantWithDecisions = await writeLiveServeDecisions(egressSafeTaggedInstant, {
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
    rotation: ctx.rotation,
    decisionPath: 'instant',
    queueReason: 'instant',
  });

  logExposures(taggedInstantWithDecisions, {
    userId: ctx.userId, rotation: ctx.rotation, queueType: 'instant',
    batchId: ctx.batchId, sessionId: ctx.sessionId, anonymousSessionId: ctx.anonymousSessionId,
    feedMode: ctx.feedMode,
  });

  const itemsForResponse = taggedInstantWithDecisions;

  return NextResponse.json({
    items: itemsForResponse,
    stats: {
      totalItems: taggedInstantWithDecisions.length,
      version: 'instant',
      composition: {
        cards: taggedInstantWithDecisions.filter(i => i.type === 'card').length,
        questions: taggedInstantWithDecisions.filter(i => i.type === 'question').length,
        groups: 0,
        snippets: 0,
      },
    },
    availableFilters: { types: [], difficulties: [], topics: [] },
    sessionId: ctx.sessionId,
    batchId: ctx.batchId,
  }, { headers: { 'Server-Timing': instantTiming } });
}
