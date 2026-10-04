/**
 * Bulk Candidate Fetching
 *
 * Fetches per-rotation card/question/video metadata + concept embeddings,
 * plus SQL-computed (concept, item) similarity scores. Vectors stay in
 * Postgres; only scalars come back. See docs/superpowers/plans/
 * 2026-04-28-embedding-egress-elimination.md.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { normalizeRawRelevance } from './candidate-ranking';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { EXCLUDED_POOL_TOPICS, imagePromptCardWhere, clipPromptCardWhere } from '@/lib/study/servable-pool';
import {
  practiceLocaleWhere,
  type PracticeLocale,
} from '@/lib/study/practice-locale';
import { batchLoadConceptEmbeddings } from '@/lib/manifold';
import { scoreItemsAgainstConceptsTopK } from '@/lib/manifold/scoring';
import {
  candidatePoolEpochTag,
  learnerOwnsPrivateCards,
  resolveConceptTopK,
} from '@/lib/manifold/concept-topk-store';
import { cachedCandidatePool } from './candidate-pool-cache';
import { createHash } from 'node:crypto';
import {
  CARD_TOPK_ELIGIBILITY_SQL,
  QUESTION_TOPK_ELIGIBILITY_SQL,
  practiceLocaleTopKSql,
} from '@/lib/manifold/concept-topk-sql';
import type { CommitmentLevel } from '@/lib/commitment';
import { meetsRequiredTier } from '@/lib/content-access';
import type { QuestionFamiliarity } from './question-retirement';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { sessionCandidateItemWhere } from '@/lib/knowledge/session-candidate-scope';
import {
  SHARED_CATALOG_CARD_SCOPE,
  findManyCards,
  ownerPrivateOrSharedCardScope,
  scopedCardProgressWhere,
} from '@/lib/cards/read-repository.server';
import {
  loadItemExamTargetScores,
  type ExamTargetScoreRepositoryClient,
  type RuntimeItemExamTargetScore,
} from '@/lib/exam-target/repository.server';
import {
  cardDueForSelectionWhere,
  isCardDueForSelection,
} from '@/lib/knowledge/card-due-eligibility';
import {
  normalizeReviewChallengeLevel,
  type ReviewChallengeLevel,
} from '@/lib/study/review-challenge';

/** Minimal Prisma-like client for raw queries — works with PrismaClient and $extends() result. */
type PrismaRawClient = {
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};

// Re-export under the historical name for callers that already import it from
// here. The canonical definition lives in @/lib/study/servable-pool. Mutable
// copy so existing call sites can still pass it directly to Prisma `hasSome`.
export const EXCLUDED_TOPICS: string[] = [...EXCLUDED_POOL_TOPICS];

// Top-K caps per concept for the SQL scoring queries. These match the
// effective cap the old in-memory ranker applied (rankItemsBySimilarity
// had a fixed limit of 200).
const TOPK_CARDS_PER_CONCEPT = 200;
const TOPK_QUESTIONS_PER_CONCEPT = 200;
const TOPK_VIDEOS_PER_CONCEPT = 50;

const CANDIDATE_CARD_SELECT = {
  id: true, stableId: true, rotation: true, clusterId: true, similarCards: true, topics: true,
  sourceFile: true, imageUrl: true, importance: true, complexity: true, facilityIndex: true,
  sampleSize: true, variantGroupId: true, variantIndex: true, variantType: true,
  examRelevance: true, examRelevancePct: true,
} as const;

const CANDIDATE_QUESTION_SELECT = {
  id: true,
  rotation: true,
  stem: true,
  questionType: true,
  difficulty: true,
  variantGroupId: true,
  variantType: true,
  format: true,
  facilityIndex: true,
  totalAttempts: true,
  source: true,
  topics: true,
  examRelevance: true,
  examRelevancePct: true,
} as const;

const CANDIDATE_VIDEO_SELECT = {
  id: true,
  title: true,
  thumbnailR2Key: true,
  durationSecs: true,
  r2Key: true,
  creatorName: true,
  requiredTier: true,
} as const;

/** Change-log scopes whose epochs gate the cached candidate pools of a session. */
function candidatePoolScopes(rotation: string, crossSource: readonly string[]): string[] {
  return [...new Set([rotation, ...crossSource])].flatMap((r) => [`card:${r}`, `question:${r}`]);
}

function conceptSetKey(conceptIds: readonly string[]): string {
  return createHash('sha1').update([...new Set(conceptIds)].sort().join(',')).digest('base64url');
}

/**
 * This learner's own copy of rows taken from the shared pool cache. The cache
 * shares row objects (and their topics and similarCards arrays) between
 * learners, and the scheduler is free to sort, annotate or extend what it is
 * given, so nothing handed downstream may be a cached object. Measured on
 * Node 24: about 15-20 ms for 5,000 cards that each carry ten similarCards
 * entries, about 2 ms for 2,600 questions or 8,000 concept links. That is small
 * beside the queries the cache saves, and unlike a field-by-field copy it stays
 * deep when a nested field is added to the select.
 */
function ownCopy<T>(rows: readonly T[]): T[] {
  return structuredClone(rows as T[]);
}

export interface BulkCardRow {
  id: string;
  /** Durable content key; the card ↔ question proximity overlay is keyed by it.
   *  Optional so existing fixtures stay valid; absent means "no overlay lookup". */
  stableId?: string | null;
  rotation: string;
  clusterId: string | null;
  similarCards: unknown;
  topics: string[];
  sourceFile: string | null;
  /** Figure on the card, if any. Drives figure spacing in ranking — see
   *  .claude/rules/cloze-granularity.md for why a detector that needs imageUrl
   *  must be given it: an omitted select silently changes the verdict. */
  imageUrl: string | null;
  importance: number;
  /** 1 = scaffolding (teaching), 2 = standard (testing), ≥3 = stretch. */
  complexity: number;
  /** Empirical quality>=3 rate; null until the aggregation sample floor is met. */
  facilityIndex: number | null;
  /** Unique-user review sample contributing to facilityIndex. */
  sampleSize: number | null;
  /** Cloze variant group; null for solo cards. */
  variantGroupId: string | null;
  variantIndex: number | null;
  variantType: string | null;
  /** Exam-relevance ∈ [0,1]; null for rotations without a calibration anchor. */
  examRelevance: number | null;
  /** Discriminating exam-target percentile ∈ [0,1]; null until backfilled (CC only). */
  examRelevancePct: number | null;
}

export interface BulkQuestionRow {
  id: string;
  rotation: string;
  /** Prompt text used by the clinical-thread facet matcher. */
  stem?: string;
  /** Authored clinical operation (diagnosis, management, mechanism, ...). */
  questionType?: string;
  difficulty: string;
  variantGroupId: string | null;
  variantType: string | null;
  /** Cognitive format axis (cloze | recall | mechanism | interpretation | trap | comparison | scenario | unknown). Null until backfilled. */
  format: string | null;
  facilityIndex: number | null;
  totalAttempts: number | null;
  source: string;
  topics: string[];
  /** Exam-relevance ∈ [0,1]; null for rotations without a calibration anchor. */
  examRelevance: number | null;
  /** Discriminating exam-target percentile ∈ [0,1]; null until backfilled (CC only). */
  examRelevancePct: number | null;
}

export interface BulkVideoRow {
  id: string;
  title: string;
  thumbnailR2Key: string | null;
  durationSecs: number | null;
  r2Key: string;
  creatorName: string | null;
  requiredTier: string;
}

export interface BulkCandidates {
  rotation: string;
  unseenCards: BulkCardRow[];
  seenCards: BulkCardRow[];
  seenCardReviewCounts: Map<string, number>;
  /**
   * Grade already read with the seen-card progress rows. Kept so the
   * repetition-slot shadow can run without another query. Absent on
   * fixtures that predate the field.
   */
  cardGradeById?: Map<string, { lastQuality: number | null; correctCount: number }>;
  /**
   * Card IDs at fragile mastery: ≤2 reviews, ≥1 correct, lastReview ≥21 days
   * ago. The candidate ranker boosts these to prevent single-success
   * "mastery" from decaying without re-test.
   */
  fragileSeenCards: Set<string>;
  /**
   * Due cards last graded below Good at complexity 3 or above. The ranker
   * returns these before unseen lower rungs, so a missed vignette is not
   * replaced for the rest of the week by a cloze in the same topic.
   */
  failedStretchCardIds?: ReadonlySet<string>;
  /**
   * Due complexity-1 or 2 cards last graded Good or Easy. They stay available,
   * but only after a harder card in the same topic. This is the easy pile
   * sitting in everyone's near-due queue.
   */
  passedScaffoldCardIds?: ReadonlySet<string>;
  questionConceptLinks: Array<{ questionId: string; conceptId: string; isPrimary: boolean }>;
  videoConceptLinks: Array<{ videoId: string; conceptId: string }>;
  rotationQuestions: BulkQuestionRow[];
  rotationVideos: BulkVideoRow[];
  questionMap: Map<string, BulkQuestionRow>;
  videoMap: Map<string, BulkVideoRow>;
  /**
   * Concept embeddings stay in JS only because downstream code passes
   * them as a pgvector query input. They are not used to multiply
   * against item embeddings in JS.
   */
  conceptEmbeddings: Map<string, number[]>;
  /**
   * SQL-computed top-K per concept: Map<conceptId, Map<itemId, similarity>>.
   * Replaces the rotation-wide embedding loaders that used to return
   * Map<itemId, vector> and forced JS-side cosine.
   */
  cardScores: Map<string, Map<string, number>>;
  questionScores: Map<string, Map<string, number>>;
  videoScores: Map<string, Map<string, number>>;
  /**
   * SQL-computed gap alignment: Map<cardId, alignment ∈ [-1, 1]>. Populated
   * by unified-scheduler after the user knowledge vector is known.
   */
  cardGapAlignment: Map<string, number>;
  /**
   * Per-item exam-relevance: Map<itemId, examRelevance ∈ [0, 1]>. Loaded
   * directly from Card.examRelevance / Question.examRelevance (static,
   * populated by the exam-relevance backfill/cron). Empty for rotations
   * without a calibration anchor (CAH/PWH/PAAM) — the ranker boost no-ops.
   */
  cardExamRelevance: Map<string, number>;
  questionExamRelevance: Map<string, number>;
  /** Explicit scores for the currently loaded immutable target snapshot. */
  examTargetItemScores: Map<string, RuntimeItemExamTargetScore>;
  cardExamTargetScores: Map<string, number>;
  questionExamTargetScores: Map<string, number>;
  /** Invalid/stale sidecars. Active treatment must fail closed when non-empty. */
  examTargetRejectedItemKeys: string[];
  /** Valid but unmapped/new items remain neutral and contribute no target boost. */
  examTargetNeutralItemKeys?: string[];
  /**
   * Per-user variant group history: Map<variantGroupId, Set<seenCardId>>.
   * Each key is a variantGroupId the user has any prior LearningEvent on; the
   * Set contains the card IDs already touched within that group. Solo cards
   * (no variantGroupId) are absent. Used by the ranker to (a) boost unseen
   * siblings of probed groups and (b) penalize already-seen variants.
   */
  cardVariantGroupHistory: Map<string, Set<string>>;
  /**
   * Per-question exposure state for THIS user: when they last saw it and how many
   * times they got it right. Replaces permanent retirement — mastery now sinks a
   * question in ranking (partitionByFreshness) instead of deleting it forever.
   * Questions the user has never answered are absent, which IS the freshest tier.
   */
  questionFamiliarity: Map<string, QuestionFamiliarity>;
}

/** Apply endpoint challenge lanes before quotas and modality selection. */
export function applyReviewLearningPoolPolicy(
  bulk: BulkCandidates,
  level: ReviewChallengeLevel | number | null | undefined,
  demonstratedGapConceptIds: ReadonlySet<string> = new Set(),
): BulkCandidates {
  const normalized = normalizeReviewChallengeLevel(level);
  if (normalized !== 2 && normalized !== -2) return bulk;

  const cards = normalized === -2
    ? bulk.unseenCards.filter((card) => card.complexity === 1)
    : [];
  const seenCards = normalized === -2
    ? bulk.seenCards.filter((card) => card.complexity === 1)
    : [];
  const gapLinkedQuestionIds = new Set(bulk.questionConceptLinks
    .filter(link => demonstratedGapConceptIds.has(link.conceptId))
    .map(link => link.questionId));
  const allowedQuestionIds = new Set(
    normalized === 2
      ? bulk.rotationQuestions
          .filter((question) => question.difficulty === 'hard')
          .filter((question) => gapLinkedQuestionIds.has(question.id))
          .map((question) => question.id)
      : [],
  );
  const questions = bulk.rotationQuestions.filter((question) => allowedQuestionIds.has(question.id));
  const links = bulk.questionConceptLinks.filter((link) => (
    allowedQuestionIds.has(link.questionId)
    && (normalized !== 2 || demonstratedGapConceptIds.has(link.conceptId))
  ));
  const filterQuestionScores = (scores: Map<string, Map<string, number>>) => {
    const result = new Map<string, Map<string, number>>();
    for (const [conceptId, itemScores] of scores) {
      const filtered = new Map([...itemScores].filter(([itemId]) => allowedQuestionIds.has(itemId)));
      if (filtered.size > 0) result.set(conceptId, filtered);
    }
    return result;
  };
  const questionFamiliarity = new Map(
    [...bulk.questionFamiliarity].filter(([questionId]) => allowedQuestionIds.has(questionId)),
  );
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const cardIds = new Set([...cards, ...seenCards].map((card) => card.id));
  const filterCardScores = new Map<string, Map<string, number>>();
  for (const [conceptId, itemScores] of bulk.cardScores) {
    const filtered = new Map([...itemScores].filter(([cardId]) => cardIds.has(cardId)));
    if (filtered.size > 0) filterCardScores.set(conceptId, filtered);
  }
  return {
    ...bulk,
    unseenCards: cards,
    seenCards,
    seenCardReviewCounts: new Map([...bulk.seenCardReviewCounts].filter(([id]) => cardIds.has(id))),
    cardGradeById: new Map([...(bulk.cardGradeById ?? new Map())].filter(([id]) => cardIds.has(id))),
    fragileSeenCards: new Set([...bulk.fragileSeenCards].filter((id) => cardIds.has(id))),
    failedStretchCardIds: new Set([...bulk.failedStretchCardIds ?? []].filter((id) => cardIds.has(id))),
    passedScaffoldCardIds: new Set([...bulk.passedScaffoldCardIds ?? []].filter((id) => cardIds.has(id))),
    questionConceptLinks: links,
    rotationQuestions: questions,
    questionMap,
    questionScores: filterQuestionScores(bulk.questionScores),
    questionFamiliarity,
    rotationVideos: [],
    videoConceptLinks: [],
    videoMap: new Map(),
    videoScores: new Map(),
    cardScores: filterCardScores,
    cardExamRelevance: new Map([...bulk.cardExamRelevance].filter(([id]) => cardIds.has(id))),
    questionExamRelevance: new Map([...bulk.questionExamRelevance].filter(([id]) => allowedQuestionIds.has(id))),
    cardExamTargetScores: new Map([...bulk.cardExamTargetScores].filter(([id]) => cardIds.has(id))),
    questionExamTargetScores: new Map([...bulk.questionExamTargetScores].filter(([id]) => allowedQuestionIds.has(id))),
    examTargetItemScores: new Map(
      [...bulk.examTargetItemScores].filter(([key, score]) => (
        score.itemType === 'card' ? cardIds.has(score.itemId) : allowedQuestionIds.has(score.itemId)
      )),
    ),
  };
}

/**
 * Bulk fetch all candidate cards and questions for a rotation.
 */
/** A scope the caller has already promised; applied in the queries, not after. */
export interface CandidateScope {
  clusterId?: string | null;
}

export async function bulkFetchCandidates(
  userId: string,
  rotation: string,
  conceptIds: string[],
  excludedCardIds: Set<string>,
  excludedQuestionIds: Set<string>,
  conceptEmbeddingsPromise?: Promise<Map<string, number[]>>,
  isCopyrightTier = false,
  commitmentLevel: CommitmentLevel = 'visitor',
  allowedCrossSourceRotations: readonly string[] = [],
  examTargetSnapshotId?: string | null,
  frozenNowMs?: number,
  crossSourceMappingMode: 'adjacent' | 'open' = 'adjacent',
  practiceLocale: PracticeLocale = 'au',
  /**
   * Score videos against concepts at all. Video scoring costs one query per
   * concept — 116 of the 410 queries in a CAH session — and the result is
   * discarded whenever the session is not serving videos, which is the default.
   */
  includeVideos = false,
  /**
   * A narrowing the caller has already promised the learner — today only a
   * manifold cluster, from a square on the profile heatmap.
   *
   * It is applied HERE, in the queries, rather than by filtering the result.
   * A scoped request used to fetch the whole rotation and discard all but one
   * cluster of it, which made the narrowest request in the app the most
   * expensive: 33-50 seconds against production, then a connection timeout and
   * a 503, so the square served nothing at all (2026-09-16).
   */
  scope: CandidateScope = {},
): Promise<BulkCandidates> {
  // Questions carry no clusterId, so there is no such thing as a question
  // scoped to a cluster. Serving unscoped ones beside scoped cards would
  // widen exactly the promise the square made ("Review N cards"), so a
  // cluster-scoped fetch is cards-only and says so.
  const clusterId = scope.clusterId ?? null;
  const cardsOnly = clusterId !== null;
  const hasFrozenNow = Number.isFinite(frozenNowMs);
  const leechEligibilityNow = hasFrozenNow ? new Date(frozenNowMs!) : new Date();
  const cardExcludeList = excludedCardIds.size > 0 ? [...excludedCardIds] : undefined;
  // Exclude image-as-prompt cards (copyright-tier only) for everyone else.
  const imageRoleWhere = imagePromptCardWhere(isCopyrightTier);
  // Same for clip-as-prompt cards. Kept as its own predicate rather than folded
  // into the image one: they gate different media on the same tier, and a
  // combined helper would make a future change to one silently move the other.
  const clipRoleWhere = clipPromptCardWhere(isCopyrightTier);
  const localeWhere = practiceLocaleWhere(practiceLocale);
  const clusterSql = clusterId
    ? Prisma.sql`AND p."clusterId" = ${clusterId}`
    : Prisma.empty;

  const globallyExcludedQIds = await getExcludedQuestionIds();
  const allExcludedQIds = new Set(excludedQuestionIds);
  for (const id of globallyExcludedQIds) allExcludedQIds.add(id);
  const qExcludeList = allExcludedQIds.size > 0 ? [...allExcludedQIds] : undefined;

  const allowPrivateSources = await userIdCanAccessPrivateSources(userId);
  const rotationScope = sessionCandidateItemWhere(
    rotation,
    allowedCrossSourceRotations,
    crossSourceMappingMode,
  );
  const cardScope = ownerPrivateOrSharedCardScope(userId);

  // User-independent candidate data — card and question metadata and concept
  // links — comes from the per-isolate pool cache when the learner owns no
  // private cards and the session is not narrowed to a cluster. The cached
  // pools are supersets; this learner's progress and exclusions are applied in
  // memory below. Any doubt (a private card, an unreadable change log) reads
  // directly, exactly as before. Videos are always read directly: no trigger
  // watches their publish or rights state, and the query is small.
  const ownsPrivateCards = clusterId === null
    ? await learnerOwnsPrivateCards(userId).catch(() => true)
    : true;
  const sharedPoolTag = ownsPrivateCards
    ? null
    : await candidatePoolEpochTag(candidatePoolScopes(rotation, allowedCrossSourceRotations));
  const poolKey = [
    rotation,
    [...new Set(allowedCrossSourceRotations)].sort().join(','),
    crossSourceMappingMode,
    practiceLocale,
  ].join('|');

  // Load concept embeddings first — the live top-K below takes them as input
  // (it runs only for what the precomputed top-K cannot serve) so each
  // per-concept query can use the HNSW index, an approximate search. Joining
  // concept_embeddings to *_embeddings inside SQL forces a sequential scan
  // because pgvector's HNSW only fires against a literal/param vector.
  //
  // Load at FULL DIM (3072) so the embeddings can be re-shipped to SQL as
  // halfvec parameters that match the 3072-dim *_embeddings tables.
  // Truncating to 1024 here would error with "different halfvec dimensions
  // 3072 and 1024" inside the comparing query.
  const conceptEmbeddings = await (
    conceptEmbeddingsPromise ?? batchLoadConceptEmbeddings(conceptIds, /* truncate */ false)
  );

  // Manifold-blindness telemetry (audit): when concepts exist but NONE are
  // embedded, scoreItemsAgainstConceptsTopK early-returns empty → the whole
  // session silently ranks off topic strings instead of the manifold walk, with
  // no serve-time signal (the gap that left PWH/CAH "manifold-blind" in 2026-05).
  // Surface it at serve time rather than only post-hoc via the coverage audit.
  if (conceptIds.length > 0 && conceptEmbeddings.size === 0) {
    logger.warn('scheduler manifold-blind: no concept embeddings for session', {
      rotation,
      conceptIds: conceptIds.length,
      embedded: conceptEmbeddings.size,
    });
  }

  const [
    unseenCards,
    seenCardProgress,
    questionConceptLinks,
    videoConceptLinks,
    rotationQuestions,
    rotationVideos,
    cardScores,
    questionScores,
    videoScores,
    cardVariantGroupHistory,
    questionFamiliarity,
  ] = await Promise.all([
    (async () => {
      if (!sharedPoolTag) {
        return findManyCards(cardScope, {
          where: {
            // Both predicates contain an `OR`; compose them under `AND` so the
            // nullable image gate cannot overwrite the objective/source gate.
            AND: [rotationScope, imageRoleWhere, clipRoleWhere, localeWhere],
            deletedAt: null,
            shelvedAt: null,
            ...(cardExcludeList ? { id: { notIn: cardExcludeList } } : {}),
            ...(clusterId ? { clusterId } : {}),
            progress: { none: { userId } },
            NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
          },
          select: CANDIDATE_CARD_SELECT,
        });
      }
      // The same query without the learner's two filters, cached; then
      // "no progress row" and "not excluded" applied here.
      const [pool, progressed] = await Promise.all([
        cachedCandidatePool(
          `unseen-cards:${isCopyrightTier ? 'copyright' : 'standard'}`,
          poolKey,
          sharedPoolTag,
          () => findManyCards(SHARED_CATALOG_CARD_SCOPE, {
            where: {
              AND: [rotationScope, imageRoleWhere, clipRoleWhere, localeWhere],
              deletedAt: null,
              shelvedAt: null,
              NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
            },
            select: CANDIDATE_CARD_SELECT,
          }),
        ),
        prisma.cardProgress.findMany({
          where: scopedCardProgressWhere(cardScope, { userId }, { AND: [rotationScope] }),
          select: { cardId: true },
        }),
      ]);
      const progressedIds = new Set(progressed.map((row) => row.cardId));
      return ownCopy(pool.filter((card) => !progressedIds.has(card.id) && !excludedCardIds.has(card.id)));
    })(),
    prisma.cardProgress.findMany({
      where: scopedCardProgressWhere(
        cardScope,
        {
          userId,
          suppressed: false,
          flagged: false,
          status: { notIn: ['retired'] },
          ...cardDueForSelectionWhere(leechEligibilityNow),
          OR: [
            { leechSuppressedUntil: null },
            { leechSuppressedUntil: { lt: leechEligibilityNow } },
          ],
        },
        {
          AND: [rotationScope, imageRoleWhere, clipRoleWhere, localeWhere],
          deletedAt: null,
          shelvedAt: null,
          ...(cardExcludeList ? { id: { notIn: cardExcludeList } } : {}),
          // Scoped here as well as on the unseen query above. Without it a
          // long-history account fills the batch from rotation-wide reviewed
          // cards and the post-filter keeps only the few inside the square —
          // a 47-card cluster served one card (2026-09-17).
          ...(clusterId ? { clusterId } : {}),
          NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
        },
      ),
      orderBy: [{ lastReview: 'asc' }],
      select: {
        totalReviews: true,
        correctCount: true,
        lastQuality: true,
        lastReview: true,
        nextDueAt: true,
        leechSuppressedUntil: true,
        card: { select: { id: true, stableId: true, rotation: true, clusterId: true, similarCards: true, topics: true, sourceFile: true, imageUrl: true, importance: true, complexity: true, facilityIndex: true, sampleSize: true, variantGroupId: true, variantIndex: true, variantType: true, examRelevance: true, examRelevancePct: true } },
      },
    }),
    // The concept-link pools have no trigger and stay cached for the TTL. That
    // is safe because a link never grants eligibility: below, every question
    // link is intersected with the freshly filtered question ids and every
    // video link with the freshly read videos, so a stale link can at worst
    // leave an item out of, or in, the ranking of one concept until the TTL.
    (async () => {
      const load = () => prisma.questionConcept.findMany({
        where: { conceptId: { in: conceptIds } },
        select: { questionId: true, conceptId: true, isPrimary: true },
      });
      return sharedPoolTag
        ? ownCopy(await cachedCandidatePool('question-concepts', conceptSetKey(conceptIds), sharedPoolTag, load))
        : load();
    })(),
    (async () => {
      const load = () => prisma.videoConcept.findMany({
        where: { conceptId: { in: conceptIds } },
        select: { videoId: true, conceptId: true },
      });
      return sharedPoolTag
        ? ownCopy(await cachedCandidatePool('video-concepts', conceptSetKey(conceptIds), sharedPoolTag, load))
        : load();
    })(),
    (async () => {
      if (cardsOnly) return [];
      if (!sharedPoolTag) {
        return prisma.question.findMany({
          where: withDefaultQuestionServingPolicy(
            withoutRawPublicUsmleQuestions({
              AND: [rotationScope, localeWhere],
              contentState: { not: 'shelved' },
              ...(qExcludeList ? { id: { notIn: qExcludeList } } : {}),
              NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
            }),
            { allowPrivateSources }
          ),
          select: CANDIDATE_QUESTION_SELECT,
        });
      }
      const pool = await cachedCandidatePool(
        `questions:${allowPrivateSources ? 'private-sources' : 'default-sources'}`,
        poolKey,
        sharedPoolTag,
        () => prisma.question.findMany({
          where: withDefaultQuestionServingPolicy(
            withoutRawPublicUsmleQuestions({
              AND: [rotationScope, localeWhere],
              contentState: { not: 'shelved' },
              NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
            }),
            { allowPrivateSources }
          ),
          select: CANDIDATE_QUESTION_SELECT,
        }),
      );
      return ownCopy(pool.filter((question) => !allExcludedQIds.has(question.id)));
    })(),
    // Never cached: publish and rights state must be current on every pass.
    prisma.video.findMany({
      // NOT rotation-widened: Video has no `moduleNodes` column, so a video
      // cannot declare cross-rotation membership. Strict equality is correct.
      where: {
        rotation,
        published: true,
        rightsStatus: 'cleared',
      },
      select: CANDIDATE_VIDEO_SELECT,
    }),
    // The concept top-K is the same for every learner sharing this rotation,
    // locale and cross-source scope, so it is read precomputed where the
    // precompute is valid and run live otherwise (concept-topk-store.ts).
    resolveConceptTopK({
      itemType: 'card',
      sessionRotation: rotation,
      conceptIds: [...conceptEmbeddings.keys()],
      allowedCrossSourceRotations,
      crossSourceMappingMode,
      practiceLocale,
      topK: TOPK_CARDS_PER_CONCEPT,
      clusterId,
      ownerUserId: userId,
      live: (ids) => scoreItemsAgainstConceptsTopK({
        itemTable: 'card_embeddings',
        itemIdColumn: 'card_id',
        conceptEmbeddings: pickConceptEmbeddings(conceptEmbeddings, ids),
        rotation,
        allowedCrossSourceRotations,
        crossSourceMappingMode,
        cardReadScope: cardScope,
        topK: TOPK_CARDS_PER_CONCEPT,
        // The cluster goes into the top-K search too, not just the candidate
        // list: scoring is scoped by ROTATION and runs once per concept, so it
        // is where a scoped session actually spent its time.
        extraWhere: Prisma.sql`AND ${CARD_TOPK_ELIGIBILITY_SQL} AND ${practiceLocaleTopKSql(practiceLocale)}${clusterSql}`,
      }),
    }).then((resolved) => resolved.scores),
    cardsOnly ? new Map<string, Map<string, number>>() : resolveConceptTopK({
      itemType: 'question',
      sessionRotation: rotation,
      conceptIds: [...conceptEmbeddings.keys()],
      allowedCrossSourceRotations,
      crossSourceMappingMode,
      practiceLocale,
      topK: TOPK_QUESTIONS_PER_CONCEPT,
      live: (ids) => scoreItemsAgainstConceptsTopK({
        itemTable: 'question_embeddings',
        itemIdColumn: 'question_id',
        conceptEmbeddings: pickConceptEmbeddings(conceptEmbeddings, ids),
        rotation,
        allowedCrossSourceRotations,
        crossSourceMappingMode,
        topK: TOPK_QUESTIONS_PER_CONCEPT,
        extraWhere: Prisma.sql`AND ${QUESTION_TOPK_ELIGIBILITY_SQL} AND ${practiceLocaleTopKSql(practiceLocale)}`,
      }),
    }).then((resolved) => resolved.scores),
    includeVideos ? scoreItemsAgainstConceptsTopK({
      itemTable: 'video_embeddings',
      itemIdColumn: 'video_id',
      conceptEmbeddings,
      rotation,
      // Video has no moduleNodes column; keep this parent join native-only.
      allowedCrossSourceRotations: [],
      topK: TOPK_VIDEOS_PER_CONCEPT,
      extraWhere: Prisma.sql`AND p.published = true AND p."rightsStatus" = 'cleared'`,
    }) : Promise.resolve(new Map<string, Map<string, number>>()),
    loadCardVariantGroupHistory(prisma as unknown as PrismaRawClient, userId),
    loadQuestionFamiliarity(prisma as unknown as PrismaRawClient, userId),
  ]);

  // Filter out leech-suppressed + not-due cards (belt-and-suspenders with DB where)
  const now = hasFrozenNow ? new Date(frozenNowMs!) : new Date();
  const activeProgress = seenCardProgress.filter(p => {
    if (!isCardDueForSelection(p.nextDueAt, now)) return false;
    if (!p.leechSuppressedUntil) return true;
    return p.leechSuppressedUntil < now;
  });

  const seenCards = activeProgress.map(p => p.card);
  const accessibleRotationVideos = rotationVideos.filter((video) =>
    meetsRequiredTier(commitmentLevel, video.requiredTier),
  );
  const accessibleVideoIds = new Set(accessibleRotationVideos.map((video) => video.id));
  const accessibleVideoConceptLinks = videoConceptLinks.filter((link) =>
    accessibleVideoIds.has(link.videoId),
  );
  // Question links and SQL scores are loaded independently of the metadata
  // query. Intersect both with the answer-safe ORM result so a stale relation
  // or scoring row can never re-introduce a protected question downstream.
  const accessibleQuestionIds = new Set(rotationQuestions.map((question) => question.id));
  const accessibleQuestionConceptLinks = questionConceptLinks.filter((link) =>
    accessibleQuestionIds.has(link.questionId),
  );
  const accessibleQuestionScores = new Map<string, Map<string, number>>();
  for (const [conceptId, itemScores] of questionScores) {
    const safeScores = new Map(
      [...itemScores].filter(([questionId]) => accessibleQuestionIds.has(questionId)),
    );
    if (safeScores.size > 0) accessibleQuestionScores.set(conceptId, safeScores);
  }
  const accessibleQuestionFamiliarity = new Map(
    [...questionFamiliarity].filter(([questionId]) => accessibleQuestionIds.has(questionId)),
  );
  const seenCardReviewCounts = new Map<string, number>();
  const cardGradeById = new Map<string, { lastQuality: number | null; correctCount: number }>();
  for (const p of activeProgress) {
    seenCardReviewCounts.set(p.card.id, p.totalReviews);
    cardGradeById.set(p.card.id, {
      lastQuality: p.lastQuality ?? null,
      correctCount: p.correctCount ?? 0,
    });
  }

  // Fragile-mastery surfacing: cards seen ≤2 times, mostly correct, not
  // re-tested in 21+ days. Marked so the ranker can boost them above
  // already-mastered content that keeps re-surfacing.
  const FRAGILE_MAX_REVIEWS = 2;
  const FRAGILE_MIN_DAYS_SINCE_REVIEW = 21;
  const fragileSurfaceCutoff = new Date(now.getTime() - FRAGILE_MIN_DAYS_SINCE_REVIEW * 24 * 60 * 60 * 1000);
  const fragileSeenCards = new Set<string>();
  const failedStretchCardIds = new Set<string>();
  const passedScaffoldCardIds = new Set<string>();
  for (const p of activeProgress) {
    if (p.totalReviews <= FRAGILE_MAX_REVIEWS
        && (p.correctCount ?? 0) >= 1
        && p.lastReview
        && p.lastReview < fragileSurfaceCutoff) {
      fragileSeenCards.add(p.card.id);
    }
    if (p.lastQuality == null) continue;
    if (p.lastQuality < 3 && p.card.complexity >= 3) {
      failedStretchCardIds.add(p.card.id);
    } else if (p.lastQuality >= 3 && p.card.complexity <= 2) {
      passedScaffoldCardIds.add(p.card.id);
    }
  }

  const examTargetRows = examTargetSnapshotId
    ? await loadItemExamTargetScores({
        client: prisma as unknown as ExamTargetScoreRepositoryClient,
        targetSnapshotId: examTargetSnapshotId,
        items: [
          ...[...unseenCards, ...seenCards].map((card) => ({
            itemType: 'card' as const,
            itemId: card.id,
            sourceRotation: card.rotation,
          })),
          ...rotationQuestions.map((question) => ({
            itemType: 'question' as const,
            itemId: question.id,
            sourceRotation: question.rotation,
          })),
        ],
      })
    : {
        scores: new Map<string, RuntimeItemExamTargetScore>(),
        rejectedItemKeys: [],
        neutralItemKeys: [],
      };
  const cardExamTargetScores = new Map<string, number>();
  const questionExamTargetScores = new Map<string, number>();
  for (const score of examTargetRows.scores.values()) {
    if (score.itemType === 'card') cardExamTargetScores.set(score.itemId, score.itemTargetIndex);
    else questionExamTargetScores.set(score.itemId, score.itemTargetIndex);
  }

  return {
    rotation,
    unseenCards,
    seenCards,
    seenCardReviewCounts,
    cardGradeById,
    fragileSeenCards,
    failedStretchCardIds,
    passedScaffoldCardIds,
    questionConceptLinks: accessibleQuestionConceptLinks,
    videoConceptLinks: accessibleVideoConceptLinks,
    rotationQuestions,
    rotationVideos: accessibleRotationVideos,
    questionMap: new Map(rotationQuestions.map(q => [q.id, q])),
    videoMap: new Map(accessibleRotationVideos.map(v => [v.id, v])),
    conceptEmbeddings,
    cardScores,
    questionScores: accessibleQuestionScores,
    videoScores,
    cardGapAlignment: new Map(),
    cardExamRelevance: buildLegacyHomeExamTargetMap(
      [...unseenCards, ...seenCards],
      rotation,
    ),
    questionExamRelevance: buildLegacyHomeExamTargetMap(rotationQuestions, rotation),
    examTargetItemScores: examTargetRows.scores,
    cardExamTargetScores,
    questionExamTargetScores,
    examTargetRejectedItemKeys: examTargetRows.rejectedItemKeys,
    examTargetNeutralItemKeys: examTargetRows.neutralItemKeys,
    cardVariantGroupHistory,
    questionFamiliarity: accessibleQuestionFamiliarity,
  };
}

/** The subset of loaded concept vectors the live top-K needs for `ids`. */
function pickConceptEmbeddings(
  conceptEmbeddings: Map<string, number[]>,
  ids: readonly string[],
): Map<string, number[]> {
  if (ids.length === conceptEmbeddings.size) return conceptEmbeddings;
  const picked = new Map<string, number[]>();
  for (const id of ids) {
    const vector = conceptEmbeddings.get(id);
    if (vector) picked.set(id, vector);
  }
  return picked;
}

/**
 * Build Map<id, exam-target score ∈ [0,1]>. Prefers the DISCRIMINATING
 * examRelevancePct (within-rotation percentile, real low tail; CC backfilled);
 * falls back to the floor/ceil-normalised raw examRelevance for rotations with
 * only the flat signal. Items with neither are omitted (no boost).
 */
export function buildLegacyHomeExamTargetMap(
  rows: Array<{
    id: string;
    rotation: string;
    examRelevance: number | null;
    examRelevancePct: number | null;
  }>,
  targetRotation: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    // Legacy fields describe the item's home exam only. A cross-source item
    // needs an explicit target-relative sidecar before it can receive a boost.
    if (r.rotation !== targetRotation) continue;
    if (r.examRelevancePct != null) map.set(r.id, r.examRelevancePct);
    else if (r.examRelevance != null) map.set(r.id, normalizeRawRelevance(r.examRelevance));
  }
  return map;
}

/**
 * For each variantGroupId the user has any prior LearningEvent on, return the
 * set of card IDs already touched. Used by the ranker to (a) boost unseen
 * siblings of probed groups and (b) penalize already-seen variants.
 *
 * One round-trip per session, expected size O(distinct groups touched).
 * Solo cards (no variantGroupId) are absent from the returned map.
 */
/**
 * Per-question exposure state for one user, in one round-trip.
 *
 * `lastSeenAtMs` merges answered QuestionResponses with actually delivered
 * ServeDecisions. Background cache-refresh decisions are deliberately excluded:
 * choosing an item is not the same as showing it. This distinction is load-bearing
 * for contrast families, whose next sibling is selected by delivered recency.
 *
 * Bounded by the number of distinct questions the user has ever answered or been
 * served, not by corpus size. Feeds the freshness ranking that replaced permanent
 * retirement — see knowledge/question-retirement.ts.
 */
export async function loadQuestionFamiliarity(
  client: PrismaRawClient,
  userId: string,
  /**
   * Optional id scope. The instant fast-path passes its rotation's question ids so
   * it stays fast; the full scheduler omits it and takes the whole history.
   */
  questionIds?: string[],
): Promise<Map<string, QuestionFamiliarity>> {
  if (questionIds && questionIds.length === 0) return new Map();

  const rows = questionIds
    ? await client.$queryRaw<
        Array<{ questionId: string; lastSeenAtMs: number; corrects: number }>
      >`
        WITH question_exposures AS (
          SELECT "questionId",
                 "createdAt" AS "seenAt",
                 CASE WHEN "isCorrect" THEN 1 ELSE 0 END AS "correctIncrement"
            FROM "QuestionResponse"
           WHERE "userId" = ${userId}
             AND "questionId" IN (${Prisma.join(questionIds)})
          UNION ALL
          SELECT "itemId" AS "questionId",
                 COALESCE("exposedAt", "decidedAt") AS "seenAt",
                 0 AS "correctIncrement"
            FROM "ServeDecision"
           WHERE "userId" = ${userId}
             AND "itemType" = 'question'
             AND ("deliveryPath" IS NOT NULL OR "exposedAt" IS NOT NULL)
             AND "itemId" IN (${Prisma.join(questionIds)})
        )
        SELECT "questionId",
               (EXTRACT(EPOCH FROM MAX("seenAt")) * 1000)::float8 AS "lastSeenAtMs",
               SUM("correctIncrement")::int AS "corrects"
          FROM question_exposures
         GROUP BY "questionId"
      `
    : await client.$queryRaw<
        Array<{ questionId: string; lastSeenAtMs: number; corrects: number }>
      >`
        WITH question_exposures AS (
          SELECT "questionId",
                 "createdAt" AS "seenAt",
                 CASE WHEN "isCorrect" THEN 1 ELSE 0 END AS "correctIncrement"
            FROM "QuestionResponse"
           WHERE "userId" = ${userId}
          UNION ALL
          SELECT "itemId" AS "questionId",
                 COALESCE("exposedAt", "decidedAt") AS "seenAt",
                 0 AS "correctIncrement"
            FROM "ServeDecision"
           WHERE "userId" = ${userId}
             AND "itemType" = 'question'
             AND ("deliveryPath" IS NOT NULL OR "exposedAt" IS NOT NULL)
        )
        SELECT "questionId",
               (EXTRACT(EPOCH FROM MAX("seenAt")) * 1000)::float8 AS "lastSeenAtMs",
               SUM("correctIncrement")::int AS "corrects"
          FROM question_exposures
         GROUP BY "questionId"
      `;

  const map = new Map<string, QuestionFamiliarity>();
  // Defensive: tests mock $queryRaw with no return value; treat falsy as empty.
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    map.set(row.questionId, {
      lastSeenAtMs: Number(row.lastSeenAtMs),
      corrects: Number(row.corrects),
    });
  }
  return map;
}

export async function loadCardVariantGroupHistory(
  client: PrismaRawClient,
  userId: string,
): Promise<Map<string, Set<string>>> {
  const rows = await client.$queryRaw<Array<{ variantGroupId: string; sourceId: string }>>`
    SELECT c."variantGroupId", e."sourceId"
      FROM "LearningEvent" e
      JOIN "Card" c ON c.id = e."sourceId"
     WHERE e."userId" = ${userId}
       AND e."eventType" = 'card_reviewed'
       AND e."sourceType" = 'card'
       AND c."variantGroupId" IS NOT NULL
  `;

  const map = new Map<string, Set<string>>();
  // Defensive: tests mock $queryRaw with no return value; treat falsy as empty.
  if (!Array.isArray(rows)) return map;
  for (const { variantGroupId, sourceId } of rows) {
    let set = map.get(variantGroupId);
    if (!set) {
      set = new Set<string>();
      map.set(variantGroupId, set);
    }
    set.add(sourceId);
  }
  return map;
}
