import { NextResponse, after } from 'next/server';
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
import {
  filterCardsAtDueEgress,
  selectInstantQuestionCandidates,
  logExposures,
  orderEaseIn,
  selectRotatingVariants,
} from './unified-session-helpers';
import { logSessionDiagnostic } from './unified-session-diagnostics';
import { viewerMayServeImportedRung } from './imported-rung-access';
import { runSessionCacheRefresh } from './unified-session-cache-refresh';
import { enrichItemsWithWalkMetadata, tierFromComplexity, tierFromQuestionDifficulty } from '@/lib/audit/walk-metadata';
import { breakModalityRuns } from '@/lib/knowledge/modality-guard';
import { planPreemptiveScaffoldInsertions } from '@/lib/knowledge/preemptive-scaffold';
import {
  scoreOrderedPairwiseDistances,
  type EmbeddingItemTable,
  type EmbeddingItemIdColumn,
} from '@/lib/manifold/scoring';
import { questionImageIsPrompt, resolveImage } from '@/lib/figures/resolve';
import { resolveImageAlternatives } from '@/lib/figures/resolve-alternatives';
import { writeLiveServeDecisions } from './serve-decision-write';
import { loadCurrentSessionContent, sessionSourceKey, withCurrentSessionBody } from './current-session-content';
import { filterDuplicateCardVariantGroups } from './unified-session-cache-helpers';
import { isUsableQuestion } from '@/lib/question-validation';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';
import { ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import { buildClinicalThreadAnchors } from '@/lib/knowledge/concept-thread-history';
import {
  CONCEPT_THREAD_MAX_AGE_MS,
  CONCEPT_THREAD_POLICY_VERSION,
  prepareConceptThreadMatcher,
  type ClinicalThreadAnchor,
  type ConceptThreadMatch,
} from '@/lib/knowledge/concept-thread-policy';

/** Bound on the variant-sibling point lookup so it cannot grow into a scan. */
const INSTANT_VARIANT_LOOKUP_CAP = 1500;

const INSTANT_CONCEPT_THREAD_EVENT_LIMIT = 800;
const INSTANT_CONCEPT_THREAD_ANCHOR_LIMIT = 24;

/**
 * Fast path: no cache → return static cards instantly, compute manifold in background.
 * Next request will hit the freshly-populated cache (~50ms).
 * Guests also use this path — no point running the full manifold for cookie-tracked users.
 * Returns null if scheduler-only filters are active or not enough static content
 * (falls through to manifold). Difficulty and topic filters are safe on static
 * content because both are carried by the checked-in content map.
 * `feedMode=new-only` is also safe here: the 24h window is replaced with the
 * all-time CardProgress / QuestionResponse exclusion the manifold already uses,
 * so a new-only learner is not sent through a 20–30s live build just for having New-only on.
 *
 * CROSS-SOURCE REQUESTS ARE SERVED NATIVE-ONLY, NOT REFUSED. This lane used to
 * decline outright whenever another source (AnKing, Malleus) was blended in,
 * which meant the users who had configured the product most were the only ones
 * who never got the fast path: a cache miss sent them straight into the full
 * manifold build, which takes longer than the function limit allows and is
 * therefore killed. Serving this rotation's own cards immediately is strictly
 * better than serving nothing — a CAH user gets CAH — and the background
 * refresh below produces the properly blended queue for the next request.
 */
export function instantDeclineReason(ctx: SessionContext): string | null {
  if (ctx.noCache) return 'noCache';
  // `type=question` (MCQ-only review) is served here, not declined. Declining
  // it sent the request into the full manifold build that the function limit
  // kills, so the mode was unusable for exactly the rotations it is asked for.
  // The lane already builds its card and question pools separately, so honouring
  // it is a narrowing — no extra query, no extra work. `card`/`group` keep the
  // decline: neither has a question-free selection contract here yet.
  if (ctx.typeFilter && ctx.typeFilter !== 'question') return `type:${ctx.typeFilter}`;
  if (ctx.modulesFilter) return `modules:${ctx.modulesFilter}`;
  // A cluster scope is a hard promise ("these cards, none others"), not a
  // preference like topics. This lane builds its pools from the cached queue
  // rather than the scoped query, so it declines rather than risk serving
  // outside the square the learner clicked.
  if (ctx.clusterFilter) return `cluster:${ctx.clusterFilter}`;
  if (ctx.mode) return `mode:${ctx.mode}`;
  return null;
}

function requestedTopicSet(topicsFilter: string | null): Set<string> {
  return new Set(
    (topicsFilter ?? '')
      .split(',')
      .map((topic) => topic.trim().toLowerCase())
      .filter(Boolean),
  );
}

function matchesRequestedTopics(
  topics: readonly string[] | null | undefined,
  requestedTopics: ReadonlySet<string>,
): boolean {
  if (requestedTopics.size === 0) return true;
  return topics?.some((topic) => requestedTopics.has(topic.toLowerCase())) ?? false;
}

export async function tryInstantSession(ctx: SessionContext): Promise<NextResponse | null> {

  const declineReason = instantDeclineReason(ctx);
  if (declineReason) {
    logSessionDiagnostic(ctx, {
      path: 'instant',
      itemCount: 0,
      totalMs: +(performance.now() - ctx.t0).toFixed(1),
      cacheState: 'skipped',
      extra: { declineReason },
    });
    return null;
  }

  const requestedTopics = requestedTopicSet(ctx.topicsFilter);
  // MCQ-only review. Every card lane below is skipped rather than filtered out
  // afterwards — including the pre-emptive scaffold pass, which injects cards
  // AFTER the pool is built and would otherwise put cards in a card-free mode
  // (see .claude/rules/repetition-guards.md: every post-pool injector is its
  // own hole). Skipping the lanes also drops their queries, so this mode is
  // strictly cheaper than mixed, never slower.
  const questionsOnly = ctx.typeFilter === 'question';

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

  // PHASE MARKS. `tInstantEnd - tAuthEnd` was one opaque block, and on
  // 2026-09-14 a learner spent 23s inside it with 22.5s unattributed — the
  // event said "the instant lane was slow" and nothing more. The same lane ran
  // in 2.6s four minutes later with a LARGER exclusion set, so the exclusions
  // were not the cause and there was no way to ask what was. These four marks
  // split the block at its three real awaits, which is the minimum needed to
  // name a phase rather than a lane.
  const tOpenIssue = performance.now();

  // Hoisted: the question selection below needs this, and it is loaded inside the
  // non-guest block. Guests have no history, so an empty map is correct for them.
  let questionFamiliarity = new Map<string, QuestionFamiliarity>();
  let conceptThreadAnchors: ClinicalThreadAnchor[] = [];
  const instantNowMs = Date.now();
  // Scaffold candidates are the rotation's complexity-1 cards. Computed before
  // the query block so their due clocks can be fetched in the same round trip.
  const scaffoldCandidateIds = questionsOnly ? [] : ctx.rotationContent.cardList
    .filter((card) => (
      card.complexity === 1
      && matchesRequestedTopics(card.topics, requestedTopics)
    ))
    .map((card) => card.id);
  // Variant siblings, computed here for the same reason: one bounded point
  // lookup in the same round trip tells us which siblings the learner has
  // already been served, so rotation can prefer a fresh one instead of drawing
  // at random. Capped so the lookup stays a point read as the corpus grows.
  const variantSiblingIds = questionsOnly ? [] : ctx.rotationContent.cardList
    .filter((card) => card.variantGroupId != null && matchesRequestedTopics(card.topics, requestedTopics))
    .map((card) => card.id)
    .slice(0, INSTANT_VARIANT_LOOKUP_CAP);
  // Empty for guests: no progress rows, so every scaffold reads as never-seen
  // and stays eligible — which is correct for a first-time visitor.
  let scaffoldDueAt = new Map<string, Date | null>();
  // Same for variants: a guest has seen nothing, so rotation degrades to the
  // previous random-sibling behaviour rather than failing.
  let seenVariantCardIds: Set<string> = new Set();

  if (!ctx.isGuest) {
    const cardCutoff = new Date(instantNowMs - 24 * 60 * 60 * 1000);
    const questionCutoff = new Date(instantNowMs - 48 * 60 * 60 * 1000);
    const conceptThreadCutoff = new Date(instantNowMs - CONCEPT_THREAD_MAX_AGE_MS);
    const rotationQuestionIds = ctx.rotationContent.questionList.map((q) => q.id);
    const [
      recentEvents,
      recentResponses,
      familiarity,
      allTimeSeenCards,
      allTimeSeenQuestions,
      scaffoldProgressRows,
      variantSeenRows,
      conceptThreadEvents,
    ] = await Promise.all([
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
      // Due clocks for this rotation's complexity-1 cards ONLY — the candidate
      // pool for the pre-emptive scaffold pass below. That pass runs after every
      // selection gate and draws from the raw static pool, so it bypasses the
      // SRS due-gate `bulk-candidates` applies at pool construction; a card the
      // learner already knows was therefore re-inserted as *teaching* material
      // every day (measured 18 serves in ten weeks on one CAH C1 card).
      //
      // Bounded point lookup on the (cardId, userId) unique index, not a serve
      // history aggregation: 374 ids → 67ms server-side, measured against
      // production 2026-08-19. It joins this existing Promise.all, so it costs
      // no additional wall-clock. See .claude/rules/hot-path-latency.md.
      scaffoldCandidateIds.length > 0
        ? prisma.cardProgress.findMany({
            where: { userId: ctx.userId, cardId: { in: scaffoldCandidateIds } },
            select: { cardId: true, nextDueAt: true },
          })
        : Promise.resolve([] as Array<{ cardId: string; nextDueAt: Date | null }>),
      // Which variant siblings has this learner already been served? A bounded
      // point lookup on the (cardId, userId) unique index over ids we already
      // hold — not a serve-history aggregation — joining this Promise.all so it
      // adds no wall-clock. See .claude/rules/hot-path-latency.md.
      variantSiblingIds.length > 0
        ? prisma.cardProgress.findMany({
            where: { userId: ctx.userId, cardId: { in: variantSiblingIds } },
            select: { cardId: true },
          })
        : Promise.resolve([] as Array<{ cardId: string }>),
      prisma.learningEvent.findMany({
        where: {
          userId: ctx.userId,
          rotation: ctx.rotation,
          sourceType: { in: ['card', 'question'] },
          eventType: { in: ['card_reviewed', 'mcq_attempted'] },
          origin: { in: ['cohort_web', 'cohort_offline'] },
          timestamp: { gte: conceptThreadCutoff, lte: new Date(instantNowMs) },
        },
        select: {
          id: true,
          sourceId: true,
          sourceType: true,
          eventType: true,
          timestamp: true,
          quality: true,
          isCorrect: true,
          conceptIds: true,
        },
        orderBy: [{ timestamp: 'desc' }, { id: 'asc' }],
        // This is the latency-sensitive static lane. Eight hundred recent
        // graded events are ample to prove the five-item cadence while keeping
        // history egress bounded; older/high-volume tails naturally defer to
        // the background unified scheduler on the next cached request.
        take: INSTANT_CONCEPT_THREAD_EVENT_LIMIT,
      }).catch(() => [] as Array<{
        id: string;
        sourceId: string;
        sourceType: string;
        eventType: string;
        timestamp: Date;
        quality: number | null;
        isCorrect: boolean | null;
        conceptIds: string[];
      }>),
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
    for (const row of allTimeSeenCards) {
      recentExcludedCardIds.add(row.cardId);
    }
    for (const row of allTimeSeenQuestions) {
      recentExcludedQuestionIds.add(row.questionId);
    }
    questionFamiliarity = familiarity;
    // `?? []` mirrors this lane's existing resilience contract (see the
    // openIssue catch above): a missing progress read degrades the scaffold
    // due-gate to "no gate", it never fails the session.
    scaffoldDueAt = new Map((scaffoldProgressRows ?? []).map((row) => [row.cardId, row.nextDueAt]));
    seenVariantCardIds = new Set((variantSeenRows ?? []).map((row) => row.cardId));
    conceptThreadAnchors = buildClinicalThreadAnchors({
      successfulEvents: conceptThreadEvents
        .filter(event => (
          (event.eventType === 'mcq_attempted' && event.sourceType === 'question' && event.isCorrect === true)
          || (event.eventType === 'card_reviewed' && event.sourceType === 'card' && (event.quality ?? -1) >= 3)
        ))
        .map(event => ({
          id: event.id,
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          timestamp: event.timestamp,
          conceptIds: event.conceptIds,
        })),
      // Every graded item after the anchor is real intervening material. Do
      // not count `content_exposed` rows: they describe a returned batch, not
      // verified traversal through each item.
      exposures: conceptThreadEvents.map(event => ({
          sourceType: event.sourceType,
          sourceId: event.sourceId,
          timestamp: event.timestamp,
        })),
      questions: ctx.rotationContent.questionList.map(question => ({
        id: question.id,
        stem: question.stem,
        topics: question.topics,
        questionType: question.questionType,
        format: question.format,
        variantGroupId: question.variantGroupId,
      })),
      cards: ctx.rotationContent.cardList.map(card => ({
        id: card.id,
        front: card.front,
        topics: card.topics,
        variantGroupId: card.variantGroupId,
      })),
      nowMs: instantNowMs,
      maxAnchors: INSTANT_CONCEPT_THREAD_ANCHOR_LIMIT,
    });
    // Empty under the live policy; restores the legacy kill-switch under the env var.
    for (const questionId of computeRetiredQuestionIds(
      [...familiarity].filter(([, f]) => freshnessTier(f) === 2).map(([id]) => id),
      resolveRetirementPolicy()
    )) {
      recentExcludedQuestionIds.add(questionId);
    }
  }

  const globallyExcludedQuestionIds = await getExcludedQuestionIds();
  const tExclusions = performance.now();
  const staticCards = questionsOnly ? [] : ctx.rotationContent.cardList.filter(
    (card) => (ctx.weekFilter === null || card.week === ctx.weekFilter)
      && !recentExcludedCardIds.has(card.id)
      && !openIssue.cardIds.has(card.id)
      && (!ctx.difficultyFilter || card.difficulty === ctx.difficultyFilter)
      && matchesRequestedTopics(card.topics, requestedTopics)
      // Image-as-prompt cards are copyright-tier only (useless without the image).
      && (ctx.imageTier === 'copyright' || !questionImageIsPrompt(card.imageRole, card.imageUrl))
      // Promoted AnKing/Malleus rungs are licensed material: copyright tier only.
      // Sits beside the image gate rather than inside it because the two
      // restrict for different reasons — one is unusable without a picture, the
      // other we are not entitled to show. A future change to either must not
      // silently relax the other.
      && viewerMayServeImportedRung(card, ctx.rotation, ctx.imageTier)
  );
  const staticQuestions = selectInstantQuestionCandidates(
    ctx.rotationContent.questionList,
    {
      rotation: ctx.rotation,
      weekFilter: ctx.weekFilter,
      clientExcludeQuestionSet: recentExcludedQuestionIds,
      globallyExcludedQuestionIds,
    },
  ).filter((question) => (
    (!ctx.difficultyFilter || question.difficulty === ctx.difficultyFilter)
    && matchesRequestedTopics(question.topics, requestedTopics)
  ));

  // A silent null here costs the learner the full manifold build and leaves no
  // record of why. Seven days to 2026-09-14: 28 manifold serves of 10s+ and
  // ZERO logged decline reasons, because the only instrumented bail-out is
  // `instantDeclineReason` at the top and both of this lane's late exits
  // returned bare null. Log the pool sizes that produced the decision, not just
  // the fact of it — "empty after exclusions" and "empty corpus" need
  // different fixes and look identical from the manifold side.
  if (staticCards.length === 0 && staticQuestions.length === 0) {
    logSessionDiagnostic(ctx, {
      path: 'instant',
      itemCount: 0,
      totalMs: +(performance.now() - ctx.t0).toFixed(1),
      cacheState: 'miss',
      extra: {
        declineReason: 'empty-static-pool',
        rotationCardCount: ctx.rotationContent.cardList.length,
        excludedRecentCards: recentExcludedCardIds.size,
        excludedRecentQuestions: recentExcludedQuestionIds.size,
      },
    });
    return null;
  }

  // Mix cards and questions roughly 60/40 — or give the whole batch to
  // questions when the learner asked for MCQs only.
  const cardCount = questionsOnly
    ? 0
    : Math.min(Math.ceil(ctx.batchSize * 0.6), staticCards.length);
  const questionCount = Math.min(ctx.batchSize - cardCount, staticQuestions.length);
  // Sibling suppression applied AFTER shuffle so a different cloze variant wins
  // across sessions. Filter-time suppression would deterministically pick the
  // first sibling in content-map order, killing rotation. Mirrors the live
  // scheduler (pickCardCandidate in unified-scheduler.ts).
  const shuffledCards = shuffle(staticCards);
  // One card per variant group, preferring a sibling this learner has never been
  // served. The previous loop took the first sibling in shuffle order, which
  // rotates by chance: with three siblings an already-seen one came back about a
  // third of the time.
  const selectedCards = selectRotatingVariants(shuffledCards, seenVariantCardIds, cardCount);
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

  // On a cache miss, reserve at most one question for a mature clinical
  // thread. A winner may replace only a baseline-selected question in the
  // SAME authored-difficulty and freshness stratum. This preserves the fast
  // path's existing mastery/difficulty mix rather than letting a hard clinical
  // thread displace the easier item an ease-in batch would otherwise contain.
  let instantConceptThreadMatch: ConceptThreadMatch | null = null;
  let instantConceptThreadQuestionId: string | null = null;
  const questionStratum = (question: (typeof siblingSafeQuestions)[number]) => (
    `${freshnessTier(questionFamiliarity.get(question.id))}:${question.difficulty}`
  );
  const baselineStratumOrder = new Map<string, number>();
  for (let index = 0; index < selectedQuestions.length; index++) {
    const stratum = questionStratum(selectedQuestions[index]);
    if (!baselineStratumOrder.has(stratum)) baselineStratumOrder.set(stratum, index);
  }
  const conceptThreadMatcher = prepareConceptThreadMatcher(
    conceptThreadAnchors,
    instantNowMs,
  );
  if (conceptThreadMatcher.anchorCount > 0 && baselineStratumOrder.size > 0) {
    const matched = siblingSafeQuestions
      .map((question, controlRank) => ({
        question,
        controlRank,
        stratum: questionStratum(question),
      }))
      // The reservation cannot cross the baseline difficulty/freshness mix, so
      // do not spend matcher work on candidates that could never replace a
      // selected seat.
      .filter(entry => baselineStratumOrder.has(entry.stratum))
      .map(entry => ({
        ...entry,
        match: conceptThreadMatcher.findMatch({
          id: entry.question.id,
          itemType: 'question',
          text: entry.question.stem,
          topics: entry.question.topics,
          questionType: entry.question.questionType,
          format: entry.question.format,
          conceptIds: [],
          variantGroupId: entry.question.variantGroupId,
        }),
      }))
      .filter((entry): entry is typeof entry & { match: ConceptThreadMatch } => (
        entry.match !== null
      ))
      .sort((left, right) => (
        (baselineStratumOrder.get(left.stratum) ?? Number.MAX_SAFE_INTEGER)
        - (baselineStratumOrder.get(right.stratum) ?? Number.MAX_SAFE_INTEGER)
        || left.match.targetPreference - right.match.targetPreference
        || left.controlRank - right.controlRank
      ));
    const winner = matched[0];
    if (winner) {
      instantConceptThreadMatch = winner.match;
      instantConceptThreadQuestionId = winner.question.id;
      if (!selectedQuestions.some(question => question.id === winner.question.id)) {
        const replacementIndex = selectedQuestions.findLastIndex(question => (
          questionStratum(question) === winner.stratum
        ));
        if (replacementIndex >= 0) selectedQuestions[replacementIndex] = winner.question;
      }
    }
  }

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

  // Selection descriptors are hydrated from current rows at final egress,
  // where their current image key is resolved for the viewer's trust tier.
  const trustOverride = ctx.imageTier === 'copyright'
    ? 'copyright-required' as const
    : ctx.isGuest ? 'public' as const : 'auth-required' as const;

  async function hydrateInstantCard(
    c: (typeof ctx.rotationContent.cardList)[number],
    interventionReason?: UnifiedItem['interventionReason'],
  ): Promise<UnifiedItem | null> {
    // Assemble selection metadata here. Clinical bodies and images are
    // replaced together from current authorized rows at the final batch read.
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
      imageUrl: null,
      imageKey: c.imageUrl ?? null,
      imageCaption: c.imageCaption ?? null,
      imageRole: c.imageRole ?? null,
      interventionReason,
      priority: 1,
      liked: false,
      flagged: false,
    };
  }

  const instantItems: UnifiedItem[] = [
    // Retain image identity in candidate metadata, then resolve only the
    // authorized current key after all scaffold insertions are selected.
    ...(await Promise.all(selectedCards.map((card) => hydrateInstantCard(card))))
      .filter((item): item is UnifiedItem => item !== null),
    ...(await Promise.all(selectedQuestions.map(async (q): Promise<UnifiedItem | null> => {
      const threadMatch = q.id === instantConceptThreadQuestionId
        ? instantConceptThreadMatch
        : null;
      return {
        type: 'question',
        id: q.id,
        stem: q.stem,
        context: q.context ?? null,
        imageUrl: null,
        imageKey: q.imageUrl ?? null,
        imageCaption: q.imageCaption ?? null,
        imageRole: q.imageRole ?? null,
        rotation: q.rotation || ctx.rotation,
        week: q.week ?? null,
        topics: q.topics,
        difficulty: q.difficulty,
        variantGroupId: q.variantGroupId,
        variantType: q.variantType,
        interventionReason: threadMatch ? 'concept_followup' : undefined,
        conceptThreadPolicyVersion: CONCEPT_THREAD_POLICY_VERSION,
        conceptThreadPolicyApplied: Boolean(threadMatch),
        ...(threadMatch ? {
          conceptThreadAnchorEventId: threadMatch.anchorEventId,
          conceptThreadAnchorItemId: threadMatch.anchorItemId,
          conceptThreadAnchorFacet: threadMatch.anchorFacet,
          conceptThreadTargetFacet: threadMatch.targetFacet,
          conceptThreadSharedTopic: threadMatch.sharedTopic,
          conceptThreadAgeMs: threadMatch.ageMs,
          conceptThreadInterveningExposures: threadMatch.interveningExposures,
        } : {}),
        priority: 1,
        liked: false,
        flagged: false,
      };
    }))).filter((item): item is UnifiedItem => item !== null),
  ];
  // Interleave cards and questions with an ease-in ramp (easy -> hard; the
  // instant lane IS a new user's first experience, and a shuffled batch once
  // led with a 573-char hard ethics vignette), then enforce the modality-run
  // cap so ordering doesn't trip the audit's modality-monotony pathology.
  const modalityBoundInstant = breakModalityRuns(orderEaseIn(shuffle(instantItems)));

  // The instant lane used to bypass the manifold scheduler's pre-emptive
  // scaffold pass entirely. Reuse the same bounded planner, then hydrate each
  // chosen static C1 through this lane's signed-image boundary.
  const scaffoldInsertions = questionsOnly ? [] : planPreemptiveScaffoldInsertions(
    modalityBoundInstant,
    {
      rotation: ctx.rotation,
      candidateCards: staticCards,
    },
    {
      // Spread the pairing across equally-eligible C1 cards instead of always
      // taking the fixed-build-order head, and never re-teach a scaffold whose
      // due clock has not arrived.
      rotationSeed: ctx.sessionId,
      scaffoldDueAt,
    },
  );
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

  // Timing note: tInstantEnd marks the end of SELECTION only. The tail below
  // (pairwise scoring, eligibility lookups, ServeDecision writes) is real
  // request-path work, so totalMs and the diagnostic are captured at the
  // response point — before 2026-08-19 they under-reported the exact path
  // being debugged (measured instant builds of 50-87s logged as less).
  const tInstantEnd = performance.now();

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
  const tPairwise = performance.now();

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

  // The bundle supplies candidates only. Reuse the final question eligibility
  // read for its current body, and batch-read selected cards alongside the
  // existing lineage/due proofs. No per-item content or history queries.
  const taggedInstantCards = taggedInstant.filter((item) => item.type === 'card');
  const [currentSources, eligibleInstantCards, instantCardDue] = await Promise.all([
    loadCurrentSessionContent({ ...ctx, crossSourceRotations: [] }, taggedInstant, { includeQuestionConcepts: true }),
    filterDeliverableReinforcementCardRows(taggedInstantCards, {
      cardReadScope: ownerPrivateOrSharedCardScope(ctx.userId),
      logContext: { path: 'instant', userId: ctx.userId, rotation: ctx.rotation },
    }),
    filterCardsAtDueEgress(taggedInstantCards, {
      userId: ctx.userId, rotation: ctx.rotation, path: 'instant', isGuest: ctx.isGuest,
    }),
  ]);
  const reinforcementEligibleCardIds = new Set(eligibleInstantCards.map(card => card.id));
  const currentItems = await Promise.all(taggedInstant.map(async (item): Promise<UnifiedItem | null> => {
    if (item.type !== 'card' && item.type !== 'question') return item;
    const source = currentSources.get(sessionSourceKey(item.type, item.id));
    if (!source) return null;
    if (ctx.weekFilter !== null && source.week !== ctx.weekFilter) return null;
    if (ctx.difficultyFilter && source.difficulty !== ctx.difficultyFilter) return null;
    if (!matchesRequestedTopics(source.topics, requestedTopics)) return null;
    if (source.type === 'question' && !isUsableQuestion(source)) return null;
    if (source.type === 'card' && (!reinforcementEligibleCardIds.has(item.id)
      || !instantCardDue.eligibleCardIds.has(item.id))) return null;

    let resolved: Awaited<ReturnType<typeof resolveImage>> = null;
    try {
      resolved = await resolveImage(source.imageUrl, null, trustOverride);
    } catch (error) {
      logger.warn('instant: current image resolution failed', { itemId: item.id, error: String(error) });
    }
    if (questionImageIsPrompt(source.imageRole, source.imageUrl) && !resolved) return null;
    const current = {
      ...withCurrentSessionBody(item, source), rotation: source.rotation, week: source.week,
      imageUrl: resolved?.imageUrl ?? null, imageKey: resolved?.imageKey ?? null,
      imageCaption: source.imageCaption, imageRole: source.imageRole, imageMeta: resolved?.imageMeta,
      imageAlternatives: await resolveImageAlternatives(source, source.imageUrl, null, trustOverride),
    };
    if (source.type === 'card') return { ...current, difficultyTier: tierFromComplexity(source.complexity) };
    const primary = source.concepts;
    return { ...current,
      options: getQuestionOptions({ id: source.id,
        options: source.options as Array<{ text: string; isCorrect: boolean }>,
        combinations: source.combinations as OptionCombination[] | null,
        correctVariants: source.correctVariants as string[] | null,
      }, instantAttemptCounts[source.id] ?? 0, {
        avoidCorrectDisplayPosition: instantLastCorrectDisplayPositions[source.id] ?? null,
      }) as DisplayOption[],
      ...(primary?.length === 1 ? { conceptId: primary[0].conceptId } : {}),
      difficultyTier: tierFromQuestionDifficulty(source.difficulty),
    };
  }));
  const currentVariantSafeItems = filterDuplicateCardVariantGroups(
    currentItems.filter((item): item is UnifiedItem => item !== null),
  );
  const orderedCurrentItems = breakModalityRuns(currentVariantSafeItems);
  const originalPriorIds = new Map(taggedInstant.map((item, index) => [item.id, taggedInstant[index - 1]?.id]));
  const unchangedPairSimilarities = new Map(orderedCurrentItems.flatMap((item, index) => {
    const similarity = similarityToPriorMap.get(item.id);
    return index > 0 && similarity != null && originalPriorIds.get(item.id) === orderedCurrentItems[index - 1].id
      ? [[item.id, similarity] as const] : [];
  }));
  const egressSafeTaggedInstant = enrichItemsWithWalkMetadata(orderedCurrentItems, unchangedPairSimilarities);
  // The late twin of the bail-out above: the pool was non-empty but nothing
  // survived ordering and egress tagging. Distinguish it in the telemetry —
  // reaching here means the lane did almost all of its work and then threw the
  // result away, which is a different (and more expensive) bug than declining early.
  if (egressSafeTaggedInstant.length === 0) {
    logSessionDiagnostic(ctx, {
      path: 'instant',
      itemCount: 0,
      totalMs: +(performance.now() - ctx.t0).toFixed(1),
      cacheState: 'miss',
      extra: {
        declineReason: 'empty-after-egress-tagging',
        orderedItemCount: orderedCurrentItems.length,
      },
    });
    return null;
  }

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
    cardDueAudit: instantCardDue.audit,
  });

  const itemsForResponse = taggedInstantWithDecisions;

  const tResponse = performance.now();
  const instantTiming = [
    `auth;dur=${(ctx.tAuthEnd - ctx.t0).toFixed(1)}`,
    `contentmap;dur=${ctx.tContentMapMs.toFixed(1)}`,
    `instant;dur=${(tInstantEnd - ctx.tAuthEnd - ctx.tContentMapMs).toFixed(1)}`,
    `tail;dur=${(tResponse - tInstantEnd).toFixed(1)}`,
    `total;dur=${(tResponse - ctx.t0).toFixed(1)}`,
  ].join(', ');

  logger.info('unified-session instant response (cache miss)', {
    userId: ctx.userId, rotation: ctx.rotation, items: itemsForResponse.length,
    totalMs: +(tResponse - ctx.t0).toFixed(1),
    tailMs: +(tResponse - tInstantEnd).toFixed(1),
  });

  logSessionDiagnostic(ctx, {
    path: 'instant',
    itemCount: itemsForResponse.length,
    totalMs: +(tResponse - ctx.t0).toFixed(1),
    cacheState: 'miss',
    exclusionCounts: {
      recentCards: recentExcludedCardIds.size,
      recentQuestions: recentExcludedQuestionIds.size,
      clientCards: ctx.clientExcludeCardSet.size,
      clientQuestions: ctx.clientExcludeQuestionSet.size,
    },
    extra: {
      tailMs: +(tResponse - tInstantEnd).toFixed(1),
      // Each is the SPAN of that phase, not a cumulative timestamp: a reader
      // should be able to spot the slow one without doing arithmetic.
      openIssueMs: +(tOpenIssue - ctx.tAuthEnd).toFixed(1),
      historyMs: +(tExclusions - tOpenIssue).toFixed(1),
      poolMs: +(tPairwise - tExclusions).toFixed(1),
      selectMs: +(tInstantEnd - tPairwise).toFixed(1),
    },
  });

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
