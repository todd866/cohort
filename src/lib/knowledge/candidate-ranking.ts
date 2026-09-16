/**
 * Candidate Ranking
 *
 * In-memory card and question ranking for concept-based session construction.
 * Extracted from unified-scheduler.ts for modularity.
 */

import { expandTopicSet } from '@/lib/topics';
import { specificClinicalTopics } from './specific-topic-overlap';
import {
  calibrateDifficultyFromFacilityIndex,
  MIN_ATTEMPTS_FOR_DIFFICULTY_CALIBRATION,
} from '@/lib/question-analytics';
import { computeTopicCooldownPenalty, computeBankCardPenalty } from './session-filters';
import {
  prioritizeLeastRecentlyServedContrastSiblings,
  questionSuppressionKey,
} from './variant-suppression';
import {
  freshnessTier,
  partitionByFreshness,
  resolveRetirementPolicy,
  takeWithReentryCap,
  type ReentryCounter,
} from './question-retirement';
import { curriculumPacingBoost, curriculumRecencyBoost } from './curriculum-pacing';
import { figureCooldownBoost } from './figure-cooldown';
import { itemTeachingWeek } from '@/lib/curriculum/teaching-pace';
import type { BulkCandidates, BulkQuestionRow } from './bulk-candidates';
import {
  SCAFFOLDING_COMPLEXITY,
  STANDARD_CHALLENGE_RECALL,
  STRETCH_CHALLENGE_RECALL,
  targetComplexityForRecall,
  MAX_COMPLEXITY,
} from './challenge-policy';
import {
  MAX_RECENT_NEIGHBOR_PENALTY,
  RECENT_NEIGHBOR_MAX_RANK_SINK,
  recentNeighborSignal,
} from './recent-neighbor-penalty';
import {
  prepareConceptThreadMatcher,
  type PreparedConceptThreadMatcher,
  type ClinicalThreadAnchor,
  type ConceptThreadMatch,
} from './concept-thread-policy';

/**
 * Convert a `Map<itemId, similarity>` (descending similarity is best) into a
 * `Map<itemId, rank>` (rank 0 = best). Used to consume the SQL-computed
 * scores held in BulkCandidates.cardScores / questionScores / videoScores.
 */
function buildRankFromScores(
  scores: Map<string, number> | undefined,
  limit: number,
): Map<string, number> | null {
  if (!scores || scores.size === 0) return null;
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  const rank = new Map<string, number>();
  for (let i = 0; i < sorted.length; i++) rank.set(sorted[i][0], i);
  return rank;
}

// A bulk snapshot is immutable for one session construction, while its concept
// loop may revisit every item many times. Cache by topic-array identity so
// only selection membership is repeated, not normalization and Set allocation.
// Weak ownership releases the cache with the completed snapshot; a new bulk or
// a replacement topic array gets a fresh value.
const specificItemTopicsByBulk = new WeakMap<
  BulkCandidates,
  Map<readonly string[], ReadonlySet<string>>
>();

function specificItemTopics(
  bulk: BulkCandidates,
  itemTopics: readonly string[],
): ReadonlySet<string> {
  let cache = specificItemTopicsByBulk.get(bulk);
  if (!cache) {
    cache = new Map();
    specificItemTopicsByBulk.set(bulk, cache);
  }
  const cached = cache.get(itemTopics);
  if (cached) return cached;
  const topics = specificClinicalTopics(itemTopics);
  cache.set(itemTopics, topics);
  return topics;
}

// Layer B: exam-relevance influences item ranking.
//
// examRelevance ∈ ~[0.5, 0.85] for scored items (Gemini cosine to exam
// anchors rarely drops below 0.5 same-domain). We map [FLOOR, CEIL] → [0, 1]
// so only above-baseline relevance earns a boost, then return a NEGATIVE rank
// delta (lower rank = served earlier), capped at -factor. Undefined (unscored
// rotation) → 0, so CAH/PWH/PAAM are unaffected until they get a calibration
// anchor. Factor is sized to importanceBoost's mid-tier (-3..-10) — a
// strong-but-not-dominant nudge. Pass factor=0 to disable (feature-flag / A/B
// off path).
export const EXAM_RELEVANCE_BOOST_FACTOR = 5;
const EXAM_RELEVANCE_FLOOR = 0.5;
const EXAM_RELEVANCE_CEIL = 0.85;

/**
 * Normalise a RAW examRelevance cosine (~0.5–0.85 band) to [0,1] via the
 * floor/ceil. Used for the non-CC fallback where only the flat (non-
 * discriminating) examRelevance exists — see buildExamTargetMap.
 */
export function normalizeRawRelevance(relevance: number): number {
  return Math.max(
    0,
    Math.min(1, (relevance - EXAM_RELEVANCE_FLOOR) / (EXAM_RELEVANCE_CEIL - EXAM_RELEVANCE_FLOOR)),
  );
}

export function examRelevanceRankBoost(
  relevance: number | undefined,
  factor = EXAM_RELEVANCE_BOOST_FACTOR,
): number {
  if (relevance === undefined) return 0;
  // `|| 0` collapses -0 to +0 so the zero case is a clean no-op delta.
  return -(normalizeRawRelevance(relevance) * factor) || 0;
}

/**
 * Rank boost from an already-normalised [0,1] exam-target score (e.g. the
 * discriminating examRelevancePct). Unlike examRelevanceRankBoost it applies NO
 * floor/ceil — a percentile already spans [0,1], so the whole range earns a
 * proportional boost (an item at the 25th percentile is genuinely less
 * exam-relevant, not clipped to zero). This is the signal that lets the
 * scheduler actually discriminate exam-relevant content.
 */
export function examTargetRankBoost(
  score: number | undefined,
  factor = EXAM_RELEVANCE_BOOST_FACTOR,
): number {
  if (score === undefined) return 0;
  return -(Math.max(0, Math.min(1, score)) * factor) || 0;
}

/**
 * Apply an exam-target nudge to an already ordered pedagogical stratum.
 *
 * The existing order is the control rank. Adding a bounded negative ordinal
 * delta means target relevance can only move an item a small number of places;
 * it cannot jump across caller-defined strata such as unseen/seen or
 * vector-ranked/unranked.
 */
export function applyBoundedExamTargetNudge<T>(
  ordered: readonly T[],
  getScore: (candidate: T) => number | undefined,
  maxMove = EXAM_RELEVANCE_BOOST_FACTOR,
): T[] {
  return ordered
    .map((candidate, controlRank) => ({
      candidate,
      controlRank,
      targetRank: controlRank + examTargetRankBoost(getScore(candidate), maxMove),
    }))
    .sort((a, b) => a.targetRank - b.targetRank || a.controlRank - b.controlRank)
    .map(({ candidate }) => candidate);
}

// =============================================================================
// Types
// =============================================================================

export type QuestionDifficulty = 'easy' | 'medium' | 'hard';

export type CardCandidate = {
  id: string;
  clusterId: string | null;
  similarCards: unknown;
  topics: string[];
  sourceFile: string | null;
  /** Figure on the card. Optional: absent means no figure-spacing signal. */
  imageUrl?: string | null;
  importance: number;
  complexity: number;
  variantGroupId: string | null;
  variantIndex: number | null;
  variantType: string | null;
};

// =============================================================================
// Difficulty helpers
// =============================================================================

export const QUESTION_DIFFICULTIES: QuestionDifficulty[] = ['easy', 'medium', 'hard'];

export function buildDifficultyPlan(pattern: QuestionDifficulty[], length: number): QuestionDifficulty[] {
  const normalizedPattern = pattern.filter((d) => QUESTION_DIFFICULTIES.includes(d));
  const base: QuestionDifficulty[] = normalizedPattern.length > 0 ? normalizedPattern : ['medium'];

  const plan: QuestionDifficulty[] = [];
  for (let i = 0; i < length; i++) {
    plan.push(base[i % base.length]);
  }
  return plan;
}

export function normalizeQuestionDifficulty(value: unknown): QuestionDifficulty {
  if (typeof value !== 'string') return 'medium';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'easy' || normalized === 'medium' || normalized === 'hard') return normalized;
  return 'medium';
}

export function getEffectiveQuestionDifficulty(candidate: {
  difficulty: unknown;
  facilityIndex: number | null;
  totalAttempts: number | null;
}): QuestionDifficulty {
  if (
    typeof candidate.facilityIndex === 'number' &&
    typeof candidate.totalAttempts === 'number' &&
    candidate.totalAttempts >= MIN_ATTEMPTS_FOR_DIFFICULTY_CALIBRATION
  ) {
    return calibrateDifficultyFromFacilityIndex(candidate.facilityIndex);
  }

  return normalizeQuestionDifficulty(candidate.difficulty);
}

// =============================================================================
// Card ranking
// =============================================================================

/**
 * Get card candidates for a concept from bulk-fetched data.
 *
 * When a concept embedding is available, uses in-memory cosine similarity
 * against pre-loaded rotation embeddings to rank candidates. Cards not in
 * the embedding map are shuffled at the end.
 * Falls back to shuffled topic matching when no concept embedding exists.
 */
/**
 * Difficulty-ladder penalty: C1 below 0.6 recall, C2 while consolidating, then
 * C3 at 0.8+. It is a no-op when current recall is unknown. Penalties only sink
 * cards away from today's rung; every tier remains reachable.
 */
export const LADDER_STEP = 4;
export const LADDER_UNLOCK_RECALL = STANDARD_CHALLENGE_RECALL;
export const LADDER_STRETCH_RECALL = STRETCH_CHALLENGE_RECALL;

export function complexityLadderBoost(
  complexity: number | undefined,
  conceptRecall: number | undefined,
): number {
  // No recall means first contact, and first contact belongs on the bottom rung.
  // Abstaining here (the old `return 0`) made every rung rank identically on the
  // one exposure where the ladder matters most, so the hardest variant could win
  // it: on the BlueLink plates that is "every label is hidden" reaching a learner
  // before "other labels are visible" for the same structure, which is the harder
  // card first and the scaffold never. Treating unknown as the weakest tier makes
  // a never-seen concept behave like a badly-known one instead of like a third,
  // unladdered case. Narrow on purpose — the question-difficulty path in
  // unified-scheduler.ts still distinguishes unknown from weak.
  const target = targetComplexityForRecall(conceptRecall) ?? SCAFFOLDING_COMPLEXITY;
  // Clamp to the full 1-5 ladder. This was Math.min(3, ...), which silently
  // ranked a board-style C5 vignette as if it were a C3 — the ladder distance
  // that drives selection could never see the top two rungs, so authoring them
  // would have changed nothing about what gets served.
  const boundedComplexity = Math.max(1, Math.min(MAX_COMPLEXITY, complexity ?? 2));
  return Math.abs(boundedComplexity - target) * LADDER_STEP;
}

export function getCardsFromBulk(
  conceptId: string,
  concept: { topics: string[] },
  maxCandidates: number,
  bulk: BulkCandidates,
  selectedCardIds: Set<string>,
  penaltyContext?: {
    recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>;
    /** Exact cards delivered recently; their semantic neighbours sink softly. */
    recentCardIds?: ReadonlySet<string>;
    /** Acute failure is an intentional concept revisit, not accidental repetition. */
    recentFailureConceptIds?: ReadonlySet<string>;
    nowMs: number;
  },
  /** Current decayed concept recall — drives the learner's difficulty rung today. */
  conceptRecall?: number,
  /**
   * The teaching week the course is currently in, injected by the caller.
   *
   * Passed in rather than derived here on purpose. Resolving it needs the
   * student's track and their institution's block calendar, and this module
   * ships in the public distribution while that calendar does not. A plain
   * number crosses the boundary; the calendar stays private. null/undefined
   * means "no signal" and the boost is inert.
   */
  currentTeachingWeek?: number | null,
  /**
   * Explicit scores for the current exam-target snapshot. Passing an empty map
   * is meaningful: it disables home-exam legacy scores for unmapped items.
   */
  examTargetScores?: ReadonlyMap<string, number>,
  /** Authority-bounded maximum ordinal movement for this target snapshot. */
  examTargetMaxRankMove = EXAM_RELEVANCE_BOOST_FACTOR,
  /**
   * Neutral topic-slug → teaching-week map for this rotation, built by the
   * caller from the institution's curriculum. Same boundary as
   * `currentTeachingWeek`: a plain map of strings to numbers crosses into the
   * ranker, the calendar does not. Empty/omitted means "no signal".
   */
  topicTeachingWeeks?: ReadonlyMap<string, number>,
  /** Figure URL → this user's showings of it. Drives the expanding
   *  figure-spacing interval; empty/omitted means no signal. */
  recentFigureExposures?: ReadonlyMap<string, { count: number; mostRecentMs: number }>,
  /** Frozen clock for the selection, so ranking stays deterministic. */
  figureNowMs: number = Date.now(),
): CardCandidate[] {
  const expandedTopics = expandTopicSet(concept.topics);
  if (expandedTopics.length === 0) return [];

  const topicSet = new Set(expandedTopics);

  const matchingUnseen: CardCandidate[] = [];
  const matchingSeen: CardCandidate[] = [];

  for (const card of bulk.unseenCards) {
    if (selectedCardIds.has(card.id)) continue;
    if (card.topics.some(t => topicSet.has(t))) {
      matchingUnseen.push({
        id: card.id,
        clusterId: card.clusterId,
        similarCards: card.similarCards,
        topics: card.topics,
        sourceFile: card.sourceFile,
        imageUrl: card.imageUrl,
        importance: card.importance,
        complexity: card.complexity,
        variantGroupId: card.variantGroupId,
        variantIndex: card.variantIndex,
        variantType: card.variantType,
      });
    }
  }

  for (const card of bulk.seenCards) {
    if (selectedCardIds.has(card.id)) continue;
    if (card.topics.some(t => topicSet.has(t))) {
      matchingSeen.push({
        id: card.id,
        clusterId: card.clusterId,
        similarCards: card.similarCards,
        topics: card.topics,
        sourceFile: card.sourceFile,
        imageUrl: card.imageUrl,
        importance: card.importance,
        complexity: card.complexity,
        variantGroupId: card.variantGroupId,
        variantIndex: card.variantIndex,
        variantType: card.variantType,
      });
    }
  }

  // Rank by SQL-computed (concept, card) similarity scores.
  const vectorRank = buildRankFromScores(bulk.cardScores.get(conceptId), 200);

  // Importance rank boost: foundational cards float up within a concept's card pool.
  // importance=3 → -10 positions, importance=2 → -3, importance=1 → 0
  const importanceBoost = (importance: number): number =>
    importance === 3 ? -10 : importance === 2 ? -3 : 0;

  // Exam-target score: a normalised [0,1] value for the session's target.
  // It is applied only after pedagogical ordering, within each caller-defined
  // stratum, so it cannot displace protected recovery or cross provenance
  // boundaries.
  const examScore = (card: CardCandidate): number | undefined =>
    (examTargetScores ?? bulk.cardExamRelevance).get(card.id);

  // Variant group boost: unseen siblings of probed groups float up;
  // already-seen variants sink. Sized between examBoost (up to -5) and
  // importanceBoost (-10/-3/0). Tunable from audit:walk.
  const VARIANT_BOOST = 4;
  const variantBoost = (card: CardCandidate): number => {
    if (card.variantGroupId == null) return 0;
    const seenInGroup = bulk.cardVariantGroupHistory?.get(card.variantGroupId);
    if (!seenInGroup || seenInGroup.size === 0) return 0; // group never touched
    if (seenInGroup.has(card.id)) return +VARIANT_BOOST; // this variant already seen
    return -VARIANT_BOOST; // unseen sibling of probed group
  };

  // Difficulty-ladder boost: easy rung first when the concept is weak, harder
  // companion once consolidated. No-op when conceptRecall is undefined.
  const ladderBoost = (card: CardCandidate): number =>
    complexityLadderBoost(card.complexity, conceptRecall);

  // Curriculum pacing, both directions: material the course has not taught yet
  // sinks (capped, so reading ahead stays possible), and the topic being taught
  // this week floats up. Week resolves from the card's topics first — that is
  // what the timetable actually schedules — and falls back to md3's own filing.
  const pacingBoost = (card: CardCandidate): number => {
    const week = itemTeachingWeek(
      bulk.rotation, card.sourceFile, card.topics, topicTeachingWeeks,
    );
    return curriculumPacingBoost(week, currentTeachingWeek)
      + curriculumRecencyBoost(week, currentTeachingWeek);
  };

  // Figure spacing: a picture the user has seen recently sinks, with the
  // interval expanding each time they see it. Keeps one figure off fifteen
  // cards' worth of consecutive mornings without ever making it unreachable.
  const figureBoost = (card: CardCandidate): number =>
    figureCooldownBoost(card.imageUrl, recentFigureExposures, figureNowMs);

  const applyRecentNeighborOrdering = (
    ordered: CardCandidate[],
    enabled: boolean,
  ): CardCandidate[] => {
    if (
      !enabled
      || !penaltyContext?.recentCardIds?.size
      || penaltyContext.recentFailureConceptIds?.has(conceptId)
    ) {
      return ordered;
    }
    return ordered
      .map((card, originalIndex) => ({
        card,
        originalIndex,
        penalty: recentNeighborSignal(card.similarCards, penaltyContext.recentCardIds).penalty,
      }))
      .map(entry => ({
        ...entry,
        adjustedRank: entry.originalIndex
          + (entry.penalty / MAX_RECENT_NEIGHBOR_PENALTY) * RECENT_NEIGHBOR_MAX_RANK_SINK,
      }))
      .sort((a, b) => (
        a.adjustedRank - b.adjustedRank
        || a.penalty - b.penalty
        || a.originalIndex - b.originalIndex
      ))
      .map(({ card }) => card);
  };

  const rankCandidates = (
    candidates: CardCandidate[],
    applyRecentNovelty: boolean,
  ): CardCandidate[] => {
    if (!vectorRank) {
      // No vector ranking: variant-boosted unseen siblings first, then the
      // difficulty ladder, then importance desc. Lower-is-better on the boost
      // axis matches the rest of the ranker.
      const sortKey = (a: CardCandidate, b: CardCandidate): number => {
        const va = variantBoost(a);
        const vb = variantBoost(b);
        if (va !== vb) return va - vb;
        const la = ladderBoost(a);
        const lb = ladderBoost(b);
        if (la !== lb) return la - lb;
        const pa = pacingBoost(a) + figureBoost(a);
        const pb = pacingBoost(b) + figureBoost(b);
        if (pa !== pb) return pa - pb;
        return (b.importance ?? 1) - (a.importance ?? 1);
      };
      const controlOrder = [...candidates].sort(sortKey);
      return applyRecentNeighborOrdering(
        applyBoundedExamTargetNudge(controlOrder, examScore, examTargetMaxRankMove),
        applyRecentNovelty,
      );
    }

    const ranked: Array<{ card: CardCandidate; rank: number }> = [];
    const unranked: CardCandidate[] = [];

    for (const card of candidates) {
      const baseRank = vectorRank.get(card.id);
      if (baseRank !== undefined) {
        ranked.push({ card, rank: baseRank + importanceBoost(card.importance ?? 1) + variantBoost(card) + ladderBoost(card) + pacingBoost(card) + figureBoost(card) });
      } else {
        unranked.push(card);
      }
    }

    ranked.sort((a, b) => a.rank - b.rank);
    // Unranked cards: variant-boosted first, then ladder, then importance desc.
    unranked.sort((a, b) => {
      const va = variantBoost(a);
      const vb = variantBoost(b);
      if (va !== vb) return va - vb;
      const la = ladderBoost(a);
      const lb = ladderBoost(b);
      if (la !== lb) return la - lb;
      const pa = pacingBoost(a) + figureBoost(a);
      const pb = pacingBoost(b) + figureBoost(b);
      if (pa !== pb) return pa - pb;
      return (b.importance ?? 1) - (a.importance ?? 1);
    });
    return [
      ...applyRecentNeighborOrdering(
        applyBoundedExamTargetNudge(ranked.map(r => r.card), examScore, examTargetMaxRankMove),
        applyRecentNovelty,
      ),
      ...applyRecentNeighborOrdering(
        applyBoundedExamTargetNudge(unranked, examScore, examTargetMaxRankMove),
        applyRecentNovelty,
      ),
    ];
  };

  // Novelty is intentionally confined to the unseen stratum. Exact-due seen
  // cards retain their existing order and can never be displaced by this layer.
  let combined = [
    ...rankCandidates(matchingUnseen, true),
    ...rankCandidates(matchingSeen, false),
  ];

  // Apply topic cooldown + bank card penalties to reorder candidates.
  // Cards with high penalty sink to the end — only picked if nothing better passes.
  if (penaltyContext) {
    const penalized = combined.map((card, originalIndex) => {
      const topicPenalty = computeTopicCooldownPenalty(
        card.topics,
        penaltyContext.recentTopicExposures,
        penaltyContext.nowMs
      );
      const bankPenalty = computeBankCardPenalty(
        card.sourceFile,
        bulk.seenCardReviewCounts.get(card.id) ?? 0
      );
      let penalty = Math.max(topicPenalty, bankPenalty);
      // Fragile-mastery boost: a card seen ≤2 times and not re-tested in
      // 21+ days needs to come back up. Apply a strong negative penalty so
      // it floats above topic-cooldown'd or bank-penalised candidates.
      if (bulk.fragileSeenCards.has(card.id)) {
        penalty -= 1.0;
      }
      return { card, penalty, originalIndex };
    });
    // Stable sort: cards with lower penalty keep their relative order
    penalized.sort((a, b) => a.penalty - b.penalty || a.originalIndex - b.originalIndex);
    combined = penalized.map(p => p.card);
  }

  const seen = new Set<string>();
  const deduped: CardCandidate[] = [];

  for (const card of combined) {
    if (deduped.length >= maxCandidates) break;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    deduped.push(card);
  }

  return deduped;
}

// =============================================================================
// Video ranking
// =============================================================================

export interface VideoCandidate {
  id: string;
  title: string;
  thumbnailR2Key: string | null;
  durationSecs: number | null;
  r2Key: string;
  creatorName: string | null;
}

export interface RankedQuestionCandidate {
  id: string;
  variantGroupId: string | null;
  variantType: string | null;
  conceptThreadMatch?: ConceptThreadMatch;
}

/**
 * Get video candidates for a concept from bulk-fetched data.
 * Replaces sequential per-concept DB queries.
 * Uses 2-tier waterfall: linked → topic-matched.
 */
export function getVideosFromBulk(
  conceptId: string,
  concept: { topics: string[] },
  limit: number,
  bulk: BulkCandidates,
  options: {
    excludeVideoIds: Set<string>;
  }
): VideoCandidate[] {
  const linked: VideoCandidate[] = [];
  for (const link of bulk.videoConceptLinks) {
    if (link.conceptId !== conceptId) continue;
    if (options.excludeVideoIds.has(link.videoId)) continue;
    const v = bulk.videoMap.get(link.videoId);
    if (!v) continue;
    linked.push(v);
  }

  const expandedTopics = expandTopicSet(concept.topics);
  const topicMatched: VideoCandidate[] = [];
  if (expandedTopics.length > 0) {
    for (const v of bulk.rotationVideos) {
      if (options.excludeVideoIds.has(v.id)) continue;
      if (linked.some((l) => l.id === v.id)) continue;
      if (v.id.includes(conceptId)) {
        topicMatched.push(v);
      }
      // Videos don't yet carry topics in the schema, so we can only
      // match by id substring above. Embedding-based matching happens
      // below via the cosine ranking pass.
    }
  }

  // Rank by SQL-computed (concept, video) similarity scores.
  const vectorRank = buildRankFromScores(bulk.videoScores.get(conceptId), 100);

  const rankByVector = (videos: VideoCandidate[]): VideoCandidate[] => {
    if (!vectorRank || videos.length <= 1) return videos;

    const ranked: Array<{ v: VideoCandidate; rank: number }> = [];
    const unranked: VideoCandidate[] = [];

    for (const v of videos) {
      const rank = vectorRank.get(v.id);
      if (rank !== undefined) {
        ranked.push({ v, rank });
      } else {
        unranked.push(v);
      }
    }

    ranked.sort((a, b) => a.rank - b.rank);
    return [...ranked.map((r) => r.v), ...unranked];
  };

  const combined = [...rankByVector(linked), ...rankByVector(topicMatched)];
  const seen = new Set<string>();
  const deduped: VideoCandidate[] = [];

  for (const v of combined) {
    if (deduped.length >= limit) break;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    deduped.push(v);
  }

  return deduped;
}

/**
 * Get questions for a concept from bulk-fetched data (in-memory).
 * Replaces per-concept getQuestionsForConcept DB queries.
 * Uses 3-tier waterfall: primary-linked → any-linked → topic-matched.
 */
export function getQuestionsFromBulk(
  conceptId: string,
  concept: { topics: string[] },
  limit: number,
  bulk: BulkCandidates,
  options: {
    difficultyPlan?: QuestionDifficulty[];
    selectedQuestionIds: Set<string>;
    selectedQuestionVariantGroups: Set<string>;
    /**
     * Per-concept set of cognitive formats the user has been served
     * recently. Within each difficulty bucket, candidates whose format
     * is NOT in this set are preferred over those whose format IS in
     * the set — variety in *how* a concept is probed. Null/missing
     * formats count as un-seen so backfill gaps don't starve concepts.
     */
    recentFormatsByConcept?: Map<string, Set<string>>;
    /** Mature successful anchors that may seed a different-facet follow-up. */
    conceptThreadAnchors?: readonly ClinicalThreadAnchor[];
    /** Frozen selection clock used by the concept-thread cadence policy. */
    conceptThreadNowMs?: number;
    /** Prepared once by hot callers so anchor normalization is not repeated. */
    conceptThreadMatcher?: PreparedConceptThreadMatcher;
    /** Explicit scores for the current target; an empty map is an intentional neutral fallback. */
    examTargetScores?: ReadonlyMap<string, number>;
    /** Authority-bounded maximum ordinal movement for this target snapshot. */
    examTargetMaxRankMove?: number;
    /**
     * Shared per-session budget for mastered questions re-entering rotation.
     * Mutable and shared across per-concept calls, like selectedQuestionIds.
     * Omit and mastered questions are uncapped (they still sink in ranking).
     */
    masteredReentryCounter?: ReentryCounter;
    /** Teaching week the course is currently in; null/omitted means no signal. */
    currentTeachingWeek?: number | null;
    /** Neutral topic-slug → teaching-week map for this rotation. */
    topicTeachingWeeks?: ReadonlyMap<string, number>;
  }
): RankedQuestionCandidate[] {
  const difficultyPlan = options.difficultyPlan
    ? buildDifficultyPlan(options.difficultyPlan, limit)
    : buildDifficultyPlan(['medium'], limit);

  const usedInPool = new Set(options.selectedQuestionIds);

  // Tier 1: Primary-linked questions
  const primaryLinked: BulkQuestionRow[] = [];
  for (const link of bulk.questionConceptLinks) {
    if (link.conceptId !== conceptId || !link.isPrimary) continue;
    if (usedInPool.has(link.questionId)) continue;
    const q = bulk.questionMap.get(link.questionId);
    if (!q) continue;
    usedInPool.add(link.questionId);
    primaryLinked.push(q);
  }

  // Tier 2: Any-linked (only if no primary found)
  const linked: BulkQuestionRow[] = [];
  if (primaryLinked.length === 0) {
    for (const link of bulk.questionConceptLinks) {
      if (link.conceptId !== conceptId) continue;
      if (usedInPool.has(link.questionId)) continue;
      const q = bulk.questionMap.get(link.questionId);
      if (!q) continue;
      usedInPool.add(link.questionId);
      linked.push(q);
    }
  }

  // Tier 3: A specific clinical topic may justify an unlinked fallback.
  // Shared population or specialty labels alone must not stamp an unrelated
  // question with this concept and redirect subsequent failure remediation.
  const topicSet = specificClinicalTopics(concept.topics);
  const topicMatched: BulkQuestionRow[] = [];
  if (topicSet.size > 0) {
    for (const q of bulk.rotationQuestions) {
      if (usedInPool.has(q.id)) continue;
      if ([...specificItemTopics(bulk, q.topics)].some(topic => topicSet.has(topic))) {
        usedInPool.add(q.id);
        topicMatched.push(q);
      }
    }
  }

  // Rank within each tier by SQL-computed (concept, question) similarity scores.
  const vectorRank = buildRankFromScores(bulk.questionScores.get(conceptId), 200);
  const examTargetScores = options.examTargetScores ?? bulk.questionExamRelevance;

  // Curriculum pacing for questions. Questions carry no `sourceFile`, so their
  // only week signal is their topics — which is why this could not exist until
  // pacing resolved by topic. Before that a student in CAH week 1 was as likely
  // to be asked about week-4 fractures as about the asthma they were being
  // lectured on that morning.
  //
  // Applied at the similarity layer, so the freshness and format passes below
  // still dominate: what the course is teaching decides between comparable
  // candidates, it does not resurrect a question answered an hour ago.
  const questionPacing = (row: BulkQuestionRow): number => {
    const week = itemTeachingWeek(bulk.rotation, null, row.topics, options.topicTeachingWeeks);
    return curriculumPacingBoost(week, options.currentTeachingWeek)
      + curriculumRecencyBoost(week, options.currentTeachingWeek);
  };

  const rankByVector = (questions: BulkQuestionRow[]): BulkQuestionRow[] => {
    const targetNudge = (ordered: readonly BulkQuestionRow[]): BulkQuestionRow[] =>
      applyBoundedExamTargetNudge(
        ordered,
        candidate => examTargetScores.get(candidate.id),
        options.examTargetMaxRankMove,
      );

    // Sort is stable, so equal-pacing candidates keep the order they arrived in.
    const byPacing = (rows: readonly BulkQuestionRow[]): BulkQuestionRow[] =>
      [...rows].sort((a, b) => questionPacing(a) - questionPacing(b));

    if (!vectorRank || questions.length <= 1) return targetNudge(byPacing(questions));

    const ranked: Array<{ q: BulkQuestionRow; rank: number }> = [];
    const unranked: BulkQuestionRow[] = [];

    for (const q of questions) {
      const rank = vectorRank.get(q.id);
      if (rank !== undefined) {
        ranked.push({ q, rank: rank + questionPacing(q) });
      } else {
        unranked.push(q);
      }
    }

    ranked.sort((a, b) => a.rank - b.rank);
    return [
      ...targetNudge(ranked.map(r => r.q)),
      ...targetNudge(byPacing(unranked)),
    ];
  };

  const orderedCandidates = [
    ...rankByVector(primaryLinked),
    ...rankByVector(linked),
    ...rankByVector(topicMatched),
  ];

  // Bank-preferred ordering (within each similarity rank)
  const bankPreferred = [
    ...orderedCandidates.filter(c => c.source === 'bank'),
    ...orderedCandidates.filter(c => c.source !== 'bank'),
  ];

  // Difficulty bucketing (same logic as original)
  const candidatesByDifficulty = new Map<QuestionDifficulty, BulkQuestionRow[]>(
    QUESTION_DIFFICULTIES.map(d => [d, []])
  );

  for (const candidate of bankPreferred) {
    const effective = getEffectiveQuestionDifficulty(candidate);
    candidatesByDifficulty.get(effective)?.push(candidate);
  }

  // Within each bucket, float candidates whose format the user hasn't seen
  // recently for this concept. Stable: equal-class candidates keep their
  // existing similarity-then-bank order. Null format counts as un-seen.
  const seenFormats = options.recentFormatsByConcept?.get(conceptId);
  if (seenFormats && seenFormats.size > 0) {
    for (const [difficulty, list] of candidatesByDifficulty) {
      const unseen: BulkQuestionRow[] = [];
      const seen: BulkQuestionRow[] = [];
      for (const c of list) {
        if (c.format && seenFormats.has(c.format)) seen.push(c);
        else unseen.push(c);
      }
      candidatesByDifficulty.set(difficulty, [...unseen, ...seen]);
    }
  }

  // Identify clinical-thread candidates once. Reservation happens below only
  // after difficulty and freshness strata are known: a follow-up may win one
  // seat inside its existing stratum, but cannot cross either boundary.
  const conceptThreadMatchById = new Map<string, ConceptThreadMatch>();
  const conceptThreadNowMs = options.conceptThreadNowMs;
  const conceptThreadMatcher = options.conceptThreadMatcher ?? (
    options.conceptThreadAnchors?.length
    && typeof conceptThreadNowMs === 'number'
    && Number.isFinite(conceptThreadNowMs)
      ? prepareConceptThreadMatcher(options.conceptThreadAnchors, conceptThreadNowMs)
      : undefined
  );
  if (conceptThreadMatcher?.anchorCount) {
    for (const list of candidatesByDifficulty.values()) {
      for (const candidate of list) {
        const threadCandidate = {
          id: candidate.id,
          itemType: 'question',
          text: candidate.stem ?? '',
          topics: candidate.topics,
          questionType: candidate.questionType,
          format: candidate.format,
          conceptIds: [conceptId],
          variantGroupId: candidate.variantGroupId,
        } as const;
        const match = conceptThreadMatcher.findMatch(threadCandidate);
        if (match) conceptThreadMatchById.set(threadCandidate.id, match);
      }
    }
  }

  // Freshness partition — applied AFTER format so freshness DOMINATES: a question
  // this user has never seen beats format variety, and a mastered one sinks below
  // both regardless of format. This is what replaced permanent retirement (mastery
  // used to delete a question outright, which let a pattern-matched 2nd correct
  // retire something the user never learned). A rank penalty degrades gracefully
  // where an exclusion starves: 500 unseen questions means a mastered one never
  // surfaces; 3 means it should. See knowledge/question-retirement.ts.
  const familiarity = bulk.questionFamiliarity;
  if (familiarity && familiarity.size > 0) {
    for (const [difficulty, list] of candidatesByDifficulty) {
      const freshnessRanked = partitionByFreshness(list, (c) => c.id, familiarity);
      candidatesByDifficulty.set(
        difficulty,
        prioritizeLeastRecentlyServedContrastSiblings(
          freshnessRanked,
          (candidate) => candidate.id,
          familiarity,
        ),
      );
    }
  }

  // Reserve the best complementary facet at the head of its CURRENT freshness
  // tier. This makes a real follow-up reachable even in a broad, embedding-
  // blind concept pool, while never promoting seen/mastered material over a
  // fresh question or crossing the caller's requested difficulty bucket. Only
  // the winner moves; exam-target/vector ordering of the remaining tail stays
  // intact. The unified scheduler separately caps this at one seat per batch.
  if (conceptThreadMatchById.size > 0) {
    for (const [difficulty, list] of candidatesByDifficulty) {
      const ranked = [...list];
      for (const tier of [0, 1, 2] as const) {
        const tierStart = ranked.findIndex(candidate => (
          freshnessTier(familiarity?.get(candidate.id)) === tier
        ));
        if (tierStart < 0) continue;
        let winnerIndex = -1;
        let winnerMatch: ConceptThreadMatch | null = null;
        for (let index = tierStart; index < ranked.length; index++) {
          const candidate = ranked[index];
          if (freshnessTier(familiarity?.get(candidate.id)) !== tier) break;
          const match = conceptThreadMatchById.get(candidate.id);
          if (!match) continue;
          if (
            !winnerMatch
            || match.targetPreference < winnerMatch.targetPreference
          ) {
            winnerIndex = index;
            winnerMatch = match;
          }
        }
        if (winnerIndex > tierStart) {
          const [winner] = ranked.splice(winnerIndex, 1);
          ranked.splice(tierStart, 0, winner);
        }
      }
      candidatesByDifficulty.set(difficulty, ranked);
    }
  }

  const selectedIds = options.selectedQuestionIds;
  const selectedVariantGroups = options.selectedQuestionVariantGroups;

  function takeNext(difficulty: QuestionDifficulty): {
    id: string;
    variantGroupId: string | null;
    variantType: string | null;
    conceptThreadMatch?: ConceptThreadMatch;
  } | null {
    const list = candidatesByDifficulty.get(difficulty);
    if (!list || list.length === 0) return null;

    while (list.length > 0) {
      const candidate = list.shift();
      if (!candidate) break;
      if (selectedIds.has(candidate.id)) continue;
      // Suppress only where two siblings in one session is genuinely redundant
      // (near-duplicate, contrast-set). A raw variantGroupId gate also collapsed
      // TOPIC BUCKETS, whose siblings are unrelated questions. See variant-suppression.ts.
      const suppressKey = questionSuppressionKey(candidate);
      if (suppressKey && selectedVariantGroups.has(suppressKey)) continue;
      // Mastered questions are eligible again (retirement is gone) but capped per
      // session, so ~885 formerly-retired questions return as a maintenance tail
      // rather than a mid-block flood.
      if (
        options.masteredReentryCounter
        && familiarity
        && !takeWithReentryCap(
          candidate.id,
          familiarity,
          resolveRetirementPolicy(),
          options.masteredReentryCounter,
        )
      ) {
        continue;
      }

      selectedIds.add(candidate.id);
      if (suppressKey) selectedVariantGroups.add(suppressKey);
      return {
        id: candidate.id,
        variantGroupId: candidate.variantGroupId,
        variantType: candidate.variantType,
        ...(conceptThreadMatchById.has(candidate.id)
          ? { conceptThreadMatch: conceptThreadMatchById.get(candidate.id) }
          : {}),
      };
    }

    return null;
  }

  const selected: RankedQuestionCandidate[] = [];

  // 1) Try to satisfy the requested difficulty ladder
  for (const difficulty of difficultyPlan) {
    if (selected.length >= limit) break;
    const picked = takeNext(difficulty);
    if (picked) selected.push(picked);
  }

  // 2) Backfill from easiest → hardest
  if (selected.length < limit) {
    for (const difficulty of QUESTION_DIFFICULTIES) {
      while (selected.length < limit) {
        const picked = takeNext(difficulty);
        if (!picked) break;
        selected.push(picked);
      }
      if (selected.length >= limit) break;
    }
  }

  return selected;
}
