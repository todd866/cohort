/**
 * Unified Scheduler
 *
 * Constructs study sessions using ConceptMastery (recall probability)
 * instead of per-card due-date queues. This scheduler:
 *
 * 1. Identifies weak concepts (low recallOnExamDay)
 * 2. Decides intervention type per concept:
 *    - Low confidence → probe with MCQ (need more data)
 *    - High confidence + low recall → review cards (known weak)
 * 3. Selects items from weak concepts
 * 4. Avoids interference (similar items spaced apart)
 *
 * This replaces the legacy card-only session builder for session construction.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { withQueryCounting } from '@/lib/observability/query-counter';
import { getExamDateForUser } from '@/lib/rotations';
import { getExcludedQuestionIds } from '@/lib/question-bank';
import { withDefaultQuestionServingPolicy } from '@/lib/questions/source-policy';
import { userIdCanAccessPrivateSources } from '@/lib/questions/private-access';
import { withoutRawPublicUsmleQuestions } from '@/lib/usmle/raw-question-boundary';
import { getClusterMastery } from '@/lib/manifold/clustering';
import { selectVariantAwareQuestions } from '@/lib/question-variants';
import {
  batchLoadConceptEmbeddings,
  batchLoadItemEmbeddings,
} from '@/lib/manifold';
import { EXCLUDED_TOPICS, bulkFetchCandidates, loadQuestionFamiliarity } from './bulk-candidates';
import {
  prioritizeLeastRecentlyServedContrastSiblings,
  questionSuppressionKey,
} from './variant-suppression';
import {
  admitMasteredWithinBudget,
  countMastered,
  resolveRetirementPolicy,
  takeWithReentryCap,
  type QuestionFamiliarity,
  type ReentryCounter,
} from './question-retirement';
import { fetchRecentlyServedFormatsByConcept } from './format-history';
import { expandTopicSet } from '@/lib/topics';
import { type QuestionDifficulty, type CardCandidate, getCardsFromBulk, getQuestionsFromBulk, getVideosFromBulk, buildDifficultyPlan, normalizeQuestionDifficulty, getEffectiveQuestionDifficulty } from './candidate-ranking';
import { orderByManifoldWalk, cosineSimilarity, computeConceptPairingRate } from './manifold-walk';
import { getExamTarget, truncateToManifoldDim } from '@/lib/manifold/exam-target';
import { getFlowAxis } from '@/lib/manifold/flow-axis';
import { computeKnowledgeVectorFromData } from '@/lib/manifold/knowledge-vector';
import { computeGapDirection } from '@/lib/manifold/gap-analysis';
import { applyDecay, projectRecallToExamDay } from './state';
import { shuffle } from '@/lib/utils/shuffle';
import { fetchExclusionData } from './exclusion-data';
import { applyStruggleInterventions } from './struggle-interventions';
import {
  injectPreemptiveScaffolds,
  injectPreemptiveScaffoldsFromPool,
} from './preemptive-scaffold';
import { recordScaffoldGap } from './record-scaffold-gap';
import { isSyntheticConceptAttribution } from './synthetic-concept';
import { estimateDailyThroughput, computeRemainingBudget, computeExposuresNeeded } from './throughput';
import { getOpenIssueExclusions } from '@/lib/content-quality/open-issue-exclusions';
import { computeHubReadiness, computeKnowledgeBreadth, computeMaintenanceShift } from './scheduler-signals';
import { applyDifficultyRhythm } from './difficulty-rhythm';
import { breakModalityRuns } from './modality-guard';
import { CALIBRATION_ITEM_PENALTY_THRESHOLD } from '@/lib/audit/walk-pathologies';
import { classifyTeachingState, teachingArcFor } from '@/lib/scheduler/concept-teaching-state';
import { pickNaivePreTeachCards, type NaivePreTeachConcept } from '@/lib/scheduler/naive-pre-teach';
import { resolveInterventionReason } from './intervention-reason';
import { estimateItemRecall } from './item-recall-estimate';
import type { CommitmentLevel } from '@/lib/commitment';
import {
  buildConceptTopicIndex,
  deriveCardSignalConcepts,
  deriveRecentFailureConceptIds,
  resolveCardConceptId,
} from './scheduler-attribution';

export { resolveCardConceptId };

// =============================================================================
// Types
// =============================================================================

type SimilarLink = { cardId: string; similarity: number };

function parseSimilarLinks(value: unknown): SimilarLink[] {
  if (!Array.isArray(value)) return [];
  const links: SimilarLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const cardId =
      typeof (entry as { cardId?: unknown }).cardId === 'string'
        ? ((entry as { cardId: string }).cardId as string)
        : null;
    const similarity =
      typeof (entry as { similarity?: unknown }).similarity === 'number'
        ? ((entry as { similarity: number }).similarity as number)
        : null;
    if (!cardId || similarity === null) continue;
    links.push({ cardId, similarity });
  }
  return links;
}

export interface UnifiedSessionItem {
  type: 'card' | 'question' | 'video';
  id: string;
  conceptId: string;
  conceptName: string;
  priority: number; // 0-1, higher = more urgent
  interventionReason:
    | 'low_confidence'
    | 'weak_recall'
    | 'needs_retest'
    | 'reinforcement'
    | 'stuck_intervention'
    | 'pre_teach'
    // Naive-concept pre-teach: C1 card injected for a concept the user
    // has zero prior exposure to, so the first encounter is teaching
    // rather than a cold test. See @/lib/scheduler/naive-pre-teach.
    | 'pre_teach_naive'
    // MCQ-specific stuck flow: tagged on a question the user has been
    // answering wrong over time; bridge card injected before it.
    | 'chronic_stuck_mcq'
    | 'mcq_bridge_card'
    // Preemptive scaffold paired with a high-test-pressure question
    // (complexity ≥ 2) so that an in-session miss is followed by a
    // teaching card. See @/lib/knowledge/preemptive-scaffold.
    | 'preemptive_scaffold'
    // Concept-boost labels (D failure-escalation, E strong-pristine).
    // Resolved by resolveInterventionReason at picking time so analytics
    // can observe when these boosts drove a serve. Kept in sync with the
    // unions in unified-session-types.ts and teaching-dynamics.ts.
    | 'failure_escalation'
    | 'strong_pristine';
  // Scaffold/intervention pairing metadata. targetCardId is the supported
  // anchor item (historical name retained for compatibility even for MCQs).
  struggleIntervention?: {
    strategy: string;
    isScaffold?: boolean;
    targetCardId?: string;
  };
  /** Coverage flag for sparse manifold regions */
  coverageFlag?: 'thin' | 'adjacent';
  /** @deprecated TeachingSignal cache-build writes are disabled; retained for wire compatibility. */
  signalId?: string;
  /** Derived difficulty for rhythm reordering (easy/medium/hard) */
  difficulty?: string;
  /** Pre-serve item outcome proxy (0-1). Derived after ordering from decayed
   *  concept recall plus sample-size-shrunk item facility/cold-start priors.
   *  It is not a validated item-correctness probability. */
  predictedRecall?: number;
  /** Version/source carried into ServeDecision and labeled outcome telemetry. */
  predictedRecallModel?: string;
  predictedRecallSource?: 'empirical' | 'fallback';
  predictedRecallStatus?: 'telemetry-only-unvalidated';
  /** Topic tags from the underlying card/question. Populated at assembly time so
   *  later passes (e.g. preemptive-scaffold pairing) can do topic-overlap lookups
   *  without re-fetching from bulk. */
  topics?: string[];
  /** Complexity tier (1=scaffolding, 2=standard, ≥3=stretch). Populated at
   *  assembly time when known; used by preemptive-scaffold to decide which
   *  items deserve a paired teaching card. */
  complexity?: number;
  /** Rotation tag carried through to the response. */
  rotation?: string;
  /** Cluster tag for walk-audit cluster-coverage metrics. */
  clusterId?: string | null;
  /** Cloze-variant fields. Carry through scheduler → hydration → walk-audit so
   *  sibling suppression, hydration cleanup, and audit pathology checks can
   *  all see the variant identity. Null/undefined for solo cards. */
  variantGroupId?: string | null;
  variantIndex?: number | null;
  variantType?: string | null;
  // Video fields (present when type === 'video')
  videoTitle?: string;
  videoThumbnailUrl?: string | null;
  videoDuration?: number;
  videoR2Key?: string;
  creatorName?: string;
}

export type SessionMode = 'normal' | 'crunch' | 'rereview';

export interface UnifiedSessionOptions {
  rotation: string;
  week?: number;
  size?: number;
  /** Session mode. 'crunch' = MCQ-heavy, no new cards, high-yield only. Default 'normal'. */
  mode?: SessionMode;
  /** Ratio of cards to questions (0-1). Default 0.7 = 70% cards */
  cardRatio?: number;
  /** Minimum similarity to consider as interference. Default 0.85 */
  interferenceThreshold?: number;
  /** Card IDs to exclude (recently seen, suppressed, etc.) */
  excludeCardIds?: string[];
  /** Question IDs to exclude (recently answered, etc.) */
  excludeQuestionIds?: string[];
  /** Video IDs to exclude (recently watched, etc.) */
  excludeVideoIds?: string[];
  /** Max new (unseen) cards to introduce in this session. Defaults to unlimited. */
  maxNewCards?: number;
  /** Whether to include video "pre-teach" items for weak concepts. Default false. */
  includeVideos?: boolean;
  /** Recent topic exposures (from LearningEvents) for cross-session topic cooldown. */
  recentTopicExposures?: Map<string, { count: number; mostRecentMs: number }>;
  /** Recent cluster exposures (from LearningEvents) for inter-session cluster dampening. */
  recentClusterExposures?: Map<string, number>;
  /** Commitment level for difficulty rhythm modulation. Default 'browser'. */
  commitmentLevel?: CommitmentLevel;
  /** Copyright image tier — when 'copyright', image-as-prompt cards are eligible (S1). */
  imageTier?: 'standard' | 'copyright';
}

export interface ConceptState {
  conceptId: string;
  conceptName: string;
  currentRecall: number;
  recallOnExamDay: number;
  confidence: number;
  exposureCount: number;
  daysSinceProbe: number;
  daysSinceExposure: number;
  priority: number;
  intervention: 'probe' | 'remediate' | 'reinforce';
}

interface SessionStats {
  totalConcepts: number;
  weakConcepts: number;
  selectedConcepts: number;
  cardCount: number;
  questionCount: number;
  averagePriority: number;
  /** 0 (far from exam) to 1 (exam day). Drives difficulty/ratio shifts. */
  examPressure?: number;
  /** Fraction of multi-item concepts with at least one pair within 3 positions. Null if no pairs. */
  conceptPairingRate?: number | null;
  dailyThroughput?: number;
  totalBudgetRemaining?: number;
  sessionsRemaining?: number;
}

export interface UnifiedSessionResult {
  items: UnifiedSessionItem[];
  stats: SessionStats;
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULTS = {
  size: 20,
  cardRatio: 0.7,
  interferenceThreshold: 0.85,
  // Per-session diversity (soft caps; may be exceeded if not enough concepts)
  maxCardsPerConcept: 1,
  maxQuestionsPerConcept: 1,
  // Thresholds for intervention decisions
  confidenceThreshold: 0.3, // Below this = need to probe
  recallThreshold: 0.6, // Below this = weak
  targetRecall: 0.8, // Above this = strong
  daysSinceProbeThreshold: 3, // Above this = should retest
};

/**
 * Horizon cap (days) for the recall projection used in concept RANKING.
 *
 * Without it, forward-decaying recall over a months-away exam horizon
 * (research block: CAH ≈72d, PWH ≈127d) saturates every concept's
 * recallOnExamDay to ~0, so gapScore ≈ targetRecall for all and the scheduler
 * can no longer separate a mastered concept from a weak one (the 12f
 * projection-collapse / BACKLOG #9). examPressure already carries exam urgency
 * separately, so ranking only needs a bounded-horizon recall to stay
 * discriminating. This is a no-op in-block (daysToExam <= cap), so it changes
 * behaviour ONLY in the far-from-exam regime that is currently degenerate.
 */
const RECALL_RANKING_HORIZON_DAYS = 21;

// =============================================================================
// Exam Pressure
// =============================================================================

/**
 * Compute exam pressure using a sigmoid centered at 21 days.
 * Returns 0–1: low far from exam, ramps through 0.5 at 21 days, near 1 on exam day.
 *
 * Key values: 42d→0.04, 30d→0.20, 21d→0.50, 19d→0.57, 14d→0.74, 7d→0.89, 0d→0.96
 */
export function computeExamPressure(daysToExam: number): number {
  return 1 / (1 + Math.exp(-0.15 * (21 - daysToExam)));
}

// =============================================================================
// Calibration soft penalty
// =============================================================================

/** Multiplier applied to concept priority when currentRecall > CALIBRATION_ITEM_PENALTY_THRESHOLD
 *  and the concept is not on a fragile-mastery / chronic-failure list. Soft on purpose:
 *  high-recall items still surface for maintenance, just less often. */
export const HIGH_RECALL_PRIORITY_MULTIPLIER = 0.4;

/**
 * Does this item carry a meaningful `predictedRecall` for walk-audit calibration?
 *
 * C1 cards are teaching interventions — preemptive-scaffold pairings or remediation
 * cards served *because* the user just failed an integration question. Their
 * `predictedRecall` (if drawn from the simple prereq concept's recall state) does
 * not reflect the failure that triggered them, so feeding it into the session-
 * average calibration metric produces false-positive "calibration-too-easy" flags
 * on majority-scaffolding sessions. Leave it unset for these items so the audit
 * naturally excludes them.
 *
 * Questions (no complexity tier), C2 standard cards, and C3 stretch cards are
 * the calibrated review items the metric is designed to evaluate.
 */
export function isCalibratedReviewItem(item: {
  type: string;
  complexity?: number | null;
}): boolean {
  if (item.type === 'question') return true;
  if (item.type === 'card') return item.complexity !== 1;
  return false;
}

/**
 * Re-assert per-concept teaching budgets after intervention/scaffold passes.
 *
 * Those passes intentionally run after the main picker and can inject bridge
 * cards. When that grows a concept beyond its budget, preserve the supported
 * anchor + scaffold pair by removing another ordinary item from that concept
 * first. If the cap is too small for the pair (for example mastered=1), keep
 * the anchor and drop the scaffold. Synthetic attribution buckets represent
 * unrelated items and are therefore exempt.
 */
export function enforceConceptTeachingCaps(
  items: UnifiedSessionItem[],
  capFor: (conceptId: string) => number,
): UnifiedSessionItem[] {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < items.length; index += 1) {
    const conceptId = items[index].conceptId;
    if (isSyntheticConceptAttribution(conceptId)) continue;
    const indexes = groups.get(conceptId) ?? [];
    indexes.push(index);
    groups.set(conceptId, indexes);
  }

  const removed = new Set<number>();
  for (const [conceptId, indexes] of groups) {
    const cap = Math.max(0, Math.floor(capFor(conceptId)));
    let excess = indexes.length - cap;
    if (excess <= 0) continue;

    const scaffoldIndexes = new Set(
      indexes.filter((index) => items[index].struggleIntervention?.isScaffold === true),
    );
    const protectedTargetIds = new Set(
      [...scaffoldIndexes]
        .map((index) => items[index].struggleIntervention?.targetCardId)
        .filter((id): id is string => Boolean(id)),
    );

    const removeWhere = (predicate: (index: number) => boolean) => {
      for (let cursor = indexes.length - 1; cursor >= 0 && excess > 0; cursor -= 1) {
        const index = indexes[cursor];
        if (removed.has(index) || !predicate(index)) continue;
        removed.add(index);
        excess -= 1;
      }
    };

    // Preserve scaffold + supported anchor by sacrificing an ordinary sibling
    // first. This keeps the immediate teaching pair intact when the cap allows.
    removeWhere((index) =>
      !scaffoldIndexes.has(index) && !protectedTargetIds.has(items[index].id),
    );
    // If every item is part of a pair, discard the latest scaffold before its
    // anchor. A mastered=1 concept should retain the tested item, not only help.
    removeWhere((index) => scaffoldIndexes.has(index));
    // Defensive fallback for malformed pairing metadata.
    removeWhere(() => true);
  }

  return items.filter((_, index) => !removed.has(index));
}

/**
 * Soft-deprioritise concepts whose current recall is already very high (>0.9)
 * to push session-average predicted recall toward the desirable difficulty band
 * (0.6-0.8). Hard cutoffs would starve maintenance probing of mastered material;
 * the multiplier lets these items still appear, just at a reduced rate.
 *
 * Two opt-outs:
 *  - Concept is in the chronic-failure list (we know the user has missed it
 *    repeatedly — recall estimate is suspect, keep priority intact).
 *  - Concept is fragile (low confidence at high recall — also keep it surfaced).
 */
export function computeRecallSoftPenalty(
  currentRecall: number,
  confidence: number,
  options: { isChronicFailure?: boolean } = {},
): number {
  if (options.isChronicFailure) return 1;
  if (currentRecall <= CALIBRATION_ITEM_PENALTY_THRESHOLD) return 1;
  // Fragile mastery exception: high recall + low confidence is unstable. Keep
  // priority intact so we re-test the wobbly concept rather than skipping it.
  if (confidence < 0.4) return 1;
  return HIGH_RECALL_PRIORITY_MULTIPLIER;
}

// =============================================================================
// Cluster Round-Robin
// =============================================================================

/**
 * Build a round-robin ordering over concepts grouped by cluster.
 * Each round visits every cluster once (highest-priority concept first)
 * before any cluster contributes again.
 *
 * @param concepts - Concepts sorted by priority (desc)
 * @param getCluster - Function that returns the cluster ID for a concept
 */
export function buildClusterRoundRobin(
  concepts: ConceptState[],
  getCluster: (concept: ConceptState) => string
): ConceptState[] {
  // Group by cluster
  const clusterGroups = new Map<string, ConceptState[]>();
  for (const concept of concepts) {
    const clusterId = getCluster(concept);
    if (!clusterGroups.has(clusterId)) {
      clusterGroups.set(clusterId, []);
    }
    clusterGroups.get(clusterId)!.push(concept);
  }

  // Within each group, concepts are already sorted by priority (from input)
  // Sort groups by their top concept's priority (desc)
  const sortedGroups = [...clusterGroups.values()]
    .filter(g => g.length > 0)
    .sort((a, b) => b[0].priority - a[0].priority);

  // Round-robin: take one from each group per round (O(n) via per-group counters)
  const result: ConceptState[] = [];
  const groupCounters = new Map<typeof sortedGroups[number], number>();
  for (const group of sortedGroups) groupCounters.set(group, 0);

  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const group of sortedGroups) {
      const nextIdx = groupCounters.get(group)!;
      if (nextIdx < group.length) {
        result.push(group[nextIdx]);
        groupCounters.set(group, nextIdx + 1);
        if (nextIdx + 1 < group.length) hasMore = true;
      }
    }
  }

  return result;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Construct a unified study session driven by ConceptMastery
 */
/**
 * Public entry: builds a session and emits per-pass scheduler telemetry.
 *
 * Wraps the implementation in a query-counting scope so we capture how many DB
 * queries one scheduling pass issues. Latency was already logged downstream
 * (`schedulerMs`); query count is the missing N+1 / cost-creep signal — it
 * scales with every heuristic we add × sessions × users. Emitted as a
 * `scheduler.pass` structured log; querying that in Vercel shows whether the
 * per-session DB cost is drifting up over time.
 */
export async function constructUnifiedSession(
  userId: string,
  options: UnifiedSessionOptions
): Promise<UnifiedSessionResult> {
  const tracked = await withQueryCounting(() =>
    constructUnifiedSessionImpl(userId, options)
  );

  logger.info('scheduler.pass', {
    userId,
    rotation: options.rotation,
    week: options.week ?? null,
    size: options.size ?? null,
    mode: options.mode ?? null,
    durationMs: tracked.durationMs,
    queryCount: tracked.queryCount,
    items: tracked.result.items.length,
    concepts: tracked.result.stats.totalConcepts,
  });

  return tracked.result;
}

async function constructUnifiedSessionImpl(
  userId: string,
  options: UnifiedSessionOptions
): Promise<UnifiedSessionResult> {
  const {
    rotation,
    week,
    size = DEFAULTS.size,
    interferenceThreshold = DEFAULTS.interferenceThreshold,
    includeVideos = false,
  } = options;

  // When exclusion data is not provided, fetch it internally (used by background cache refresh)
  const needsExclusionFetch = !options.excludeCardIds && !options.excludeQuestionIds && !options.recentTopicExposures;

  const nowMs = Date.now();
  const cardRepeatCutoff = new Date(nowMs - 24 * 60 * 60 * 1000);
  const questionRepeatCutoff = new Date(nowMs - 48 * 60 * 60 * 1000);

  // 1+2. Get exam date, concepts, and optionally exclusion data — all in parallel
  const [examDate, concepts, exclusionData, openIssueExclusions, recentVideoProgress] = await Promise.all([
    getExamDateForUser(rotation, userId).catch(() => null),
    prisma.concept.findMany({
      where: {
        rotation,
        ...(week !== undefined ? { week } : {}),
      },
      select: { id: true, name: true, week: true, examWeight: true, prerequisiteIds: true, topics: true },
    }).catch((err) => {
      logger.warn('Failed to fetch concepts, falling back to cluster session', { error: String(err) });
      return [] as Array<{ id: string; name: string; week: number | null; examWeight: number | null; prerequisiteIds: string[]; topics: string[] }>;
    }),
    needsExclusionFetch
      ? fetchExclusionData(userId, cardRepeatCutoff, questionRepeatCutoff)
      : Promise.resolve(null),
    getOpenIssueExclusions().catch((error) => {
      logger.warn('Failed to apply open issue exclusions', { error: String(error) });
      return { cardIds: new Set<string>(), questionIds: new Set<string>() };
    }),
    includeVideos ? prisma.videoProgress.findMany({
      where: { userId, watchedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      select: { videoId: true }
    }).catch(() => []) : Promise.resolve([]),
  ]);

  let excludedCardIds: Set<string>;
  let excludedQuestionIds: Set<string>;
  const excludedVideoIds = new Set(options.excludeVideoIds ?? []);
  for (const v of recentVideoProgress) excludedVideoIds.add(v.videoId);
  let penaltyContext: { recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>; nowMs: number } | undefined;
  let recentClusterExposures: Map<string, number> | undefined;

  if (exclusionData) {
    excludedCardIds = exclusionData.excludedCardIds;
    excludedQuestionIds = exclusionData.excludedQuestionIds;
    penaltyContext = exclusionData.recentTopicExposures.size > 0
      ? { recentTopicExposures: exclusionData.recentTopicExposures, nowMs: Date.now() }
      : undefined;
    recentClusterExposures = exclusionData.recentClusterExposures.size > 0
      ? exclusionData.recentClusterExposures
      : undefined;
  } else {
    excludedCardIds = new Set(options.excludeCardIds ?? []);
    excludedQuestionIds = new Set(options.excludeQuestionIds ?? []);
    penaltyContext = options.recentTopicExposures
      ? { recentTopicExposures: options.recentTopicExposures, nowMs: Date.now() }
      : undefined;
    recentClusterExposures = options.recentClusterExposures;
  }

  for (const id of openIssueExclusions.cardIds) excludedCardIds.add(id);
  for (const id of openIssueExclusions.questionIds) excludedQuestionIds.add(id);

  const daysToExam = examDate
    ? Math.max(0, (examDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 45; // Default 45 days

  // Exam proximity pressure: sigmoid centered at 21 days
  // Drives gradual shift toward MCQ-heavy, hard-only, high-yield sessions
  const examPressure = options.mode === 'crunch' ? 1 : computeExamPressure(daysToExam);

  // Card ratio: 0.7 (70% cards) at low pressure → 0.4 (40% cards) at full pressure
  let cardRatio = options.cardRatio ?? (DEFAULTS.cardRatio - 0.3 * examPressure);
  // New cards: taper off as exam approaches. At full pressure, no new cards.
  const effectiveMaxNewCards = options.maxNewCards ?? (examPressure >= 0.8 ? 0 : Infinity);
  // Min exam weight: at high pressure, skip low-yield concepts
  const minExamWeight = examPressure >= 0.5 ? 2 : 1;

  if (concepts.length === 0) {
    // No Concept rows for this rotation → cluster fallback. Logged so a seed/config
    // gap (a rotation that SHOULD be conceptualized but isn't — the class the team
    // closed by conceptualizing CAH/PWH) is distinguishable at serve time from a
    // genuinely cluster-only rotation.
    logger.warn('scheduler: no concepts for rotation, using cluster fallback', { rotation });
    return constructClusterSession(userId, {
      rotation,
      size,
      cardRatio,
      maxNewCards: effectiveMaxNewCards,
      excludeCardIds: [...excludedCardIds],
      excludeQuestionIds: [...excludedQuestionIds],
    });
  }

  const conceptIds = concepts.map((c) => c.id);
  const currentConceptIds = new Set(conceptIds);
  const conceptMap = new Map(concepts.map(c => [c.id, c]));
  const conceptTopicIndex = buildConceptTopicIndex(concepts);

  // 3. Get concept states, embeddings, exam target, flow axis, knowledge vector, AND bulk candidates — all in parallel
  // Share a single embeddings promise to avoid fetching the same data twice.
  // Load FULL-DIM (3072) so the embeddings can be re-shipped to SQL as halfvec
  // parameters against the 3072-dim *_embeddings tables. Downstream JS consumers
  // (computeKnowledgeVectorFromData, gapAlignmentBoost) call truncateToManifoldDim
  // themselves, so they tolerate either dim.
  const conceptEmbeddingsPromise = batchLoadConceptEmbeddings(conceptIds, /* truncate */ false);
  const bulkPromise = bulkFetchCandidates(
    userId,
    rotation,
    conceptIds,
    excludedCardIds,
    excludedQuestionIds,
    conceptEmbeddingsPromise,
    options.imageTier === 'copyright',
    options.commitmentLevel ?? 'browser',
  );
  const flowAxisPromise = getFlowAxis(rotation).catch(() => null);

  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentFormatsPromise = fetchRecentlyServedFormatsByConcept(userId, conceptIds);
  // Acute-failure window: concepts the user has graded q<3 in the last 2h.
  // Used to boost the failed concept's priority on the *next* batch fetch
  // within the same session — so failing item N doesn't lead to item N+1
  // from an unrelated concept; instead, the next batch reshuffles to
  // surface the just-failed concept again for a remediation arc.
  // 2h window matches an average review session length; longer than that
  // and the scheduler relies on the usual recallProbability decay.
  const acuteFailureWindowStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  // ServeDecision is the delivery-grounded attribution contract for both
  // cards and questions. Card.conceptId is intentionally sparse in the live
  // corpus, so joining CardProgress through that nullable column silently
  // disabled failure escalation for nearly every card.
  const recentFailurePromise = Promise.all([
    prisma.serveDecision.findMany({
      where: {
        userId,
        answeredAt: { gte: acuteFailureWindowStart },
        deliveryPath: { not: null },
        conceptId: { in: conceptIds },
        OR: [
          { itemType: 'card', quality: { lt: 3 } },
          { itemType: 'question', isCorrect: false },
        ],
      },
      select: { conceptId: true },
    }).catch(() => [] as Array<{ conceptId: string | null }>),
    // Legacy/direct card-review routes may not have a ServeDecision. Preserve
    // their remediation behavior with the same topic attribution used by the
    // rest of the card scheduler.
    prisma.cardProgress.findMany({
      where: {
        userId,
        lastQuality: { lt: 3 },
        lastReview: { gte: acuteFailureWindowStart },
        card: { rotation, deletedAt: null },
      },
      select: { card: { select: { conceptId: true, topics: true } } },
    }).catch(() => [] as Array<{ card: { conceptId: string | null; topics: string[] } }>),
    // Keep the pre-ServeDecision question path as a compatibility fallback.
    prisma.questionResponse.findMany({
      where: {
        userId,
        isCorrect: false,
        createdAt: { gte: acuteFailureWindowStart },
        question: { concepts: { some: { conceptId: { in: conceptIds } } } },
      },
      select: {
        question: { select: { concepts: { select: { conceptId: true } } } },
      },
    }).catch(() => [] as Array<{ question: { concepts: Array<{ conceptId: string }> } }>),
  ]).then(([servedFailures, cardFailures, questionFailures]) => (
    deriveRecentFailureConceptIds({
      servedFailures,
      cardFailures,
      questionFailures,
      currentConceptIds,
      conceptTopicIndex,
    })
  ));

  const cardSignalConceptsPromise = prisma.cardProgress.findMany({
    where: {
      userId,
      OR: [
        { liked: true },
        { totalReviews: { gte: 3 } },
      ],
      card: { rotation, deletedAt: null },
    },
    select: {
      liked: true,
      totalReviews: true,
      correctCount: true,
      card: { select: { id: true, conceptId: true, topics: true } },
    },
  }).then(async rows => {
    if (rows.length === 0) {
      return deriveCardSignalConcepts({
        rows,
        servedRowsNewestFirst: [],
        currentConceptIds,
        conceptTopicIndex,
      });
    }

    // Prefer the most recent delivery-grounded attribution. Only fall back to
    // Card.conceptId or a unique topic match when no such row exists.
    const servedRows = await prisma.serveDecision.findMany({
      where: {
        userId,
        itemType: 'card',
        itemId: { in: rows.map(row => row.card.id) },
        conceptId: { in: conceptIds },
        deliveryPath: { not: null },
      },
      select: { itemId: true, conceptId: true },
      orderBy: { decidedAt: 'desc' },
    }).catch(() => [] as Array<{ itemId: string; conceptId: string | null }>);
    return deriveCardSignalConcepts({
      rows,
      servedRowsNewestFirst: servedRows,
      currentConceptIds,
      conceptTopicIndex,
    });
  }).catch(() => ({ liked: new Set<string>(), chronic: new Set<string>() }));

  const [stateRecords, conceptEmbeddings, examTargetResult, throughputStats, cardSignalConcepts, recentFormatsByConcept, recentFailureConceptIds] = await Promise.all([
    prisma.conceptState.findMany({
      where: { userId, conceptId: { in: conceptIds } },
    }).catch((err) => {
      logger.warn('Failed to fetch concept states', { error: String(err) });
      return [] as Awaited<ReturnType<typeof prisma.conceptState.findMany>>;
    }),
    conceptEmbeddingsPromise,
    getExamTarget(rotation).catch(() => null),
    prisma.dailyStats.findMany({
      where: {
        userId,
        date: { gte: fourteenDaysAgo },
      },
      select: { cardsReviewed: true, quizzesTaken: true },
      orderBy: { date: 'asc' },
    }).catch(() => [] as Array<{ cardsReviewed: number; quizzesTaken: number }>),
    // Explicit preference and chronic-failure signals share one card-history
    // load and one delivery-attribution lookup.
    cardSignalConceptsPromise,
    recentFormatsPromise.catch(() => new Map()),
    recentFailurePromise.catch(() => new Set<string>()),
  ]);
  const likedConceptIds = cardSignalConcepts.liked;
  const chronicFailureConceptIds = cardSignalConcepts.chronic;
  const stateMap = new Map(stateRecords.map((s) => [s.conceptId, s]));

  // Compute throughput and budget
  const dailyThroughput = estimateDailyThroughput(throughputStats);
  const budget = computeRemainingBudget(dailyThroughput, daysToExam, size);

  // Compute knowledge vector from already-loaded data (no extra DB queries)
  const knowledgeResult = (() => {
    try {
      return computeKnowledgeVectorFromData(conceptIds, stateMap, conceptEmbeddings);
    } catch {
      return null;
    }
  })();

  // Compute 256D gap direction for exam-readiness bias
  let gapDirection: number[] | null = null;
  if (examTargetResult && knowledgeResult && examTargetResult.chunkCount > 0 && knowledgeResult.conceptCount > 0) {
    gapDirection = computeGapDirection(examTargetResult.centroid, knowledgeResult.knowledgeVector);
  }

  // 4. Compute concept states with priority scores
  const now = new Date();
  const conceptStates: ConceptState[] = concepts.map((concept) => {
    const state = stateMap.get(concept.id);

    // Time since last interactions
    const daysSinceProbe = state?.lastProbeAt
      ? (now.getTime() - state.lastProbeAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    const daysSinceExposure = state?.lastExposureAt
      ? (now.getTime() - state.lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    // Current state (with decay applied)
    const storedRecall = state?.recallProbability ?? 0;
    const confidence = state?.confidence ?? 0;
    const exposureCount = state?.exposureCount ?? 0;

    // Apply decay since last exposure
    const currentRecall = daysSinceExposure < Infinity
      ? applyDecay(storedRecall, daysSinceExposure, confidence)
      : 0;

    // Project to exam day
    // True exam-day recall — the SEMANTIC value. Hub-readiness gating, prereq
    // gates, the difficulty ladder, diagnostics, and the returned state all read
    // this, so it must stay uncapped or those behaviours silently shift.
    const recallOnExamDay = projectRecallToExamDay(currentRecall, daysToExam, confidence);
    // RANKING recall: the same projection horizon-capped so priority stays
    // discriminating far from exam, where the true exam-day recall collapses to
    // ~0 for every concept (examPressure carries exam urgency separately). Used
    // ONLY for the priority gap below — never as recallOnExamDay's substitute
    // (BACKLOG #9 / adversarial review: capping it everywhere changed
    // hub-readiness, not just the sort).
    const rankingRecall = projectRecallToExamDay(currentRecall, daysToExam, confidence, RECALL_RANKING_HORIZON_DAYS);

    // Decide intervention type
    let intervention: 'probe' | 'remediate' | 'reinforce';
    if (confidence < DEFAULTS.confidenceThreshold || exposureCount < 3) {
      // Not enough data - need to probe
      intervention = 'probe';
    } else if (recallOnExamDay < DEFAULTS.recallThreshold) {
      // Known weak - remediate with cards
      intervention = 'remediate';
    } else if (daysSinceProbe > DEFAULTS.daysSinceProbeThreshold) {
      // Haven't tested recently - probe to verify
      intervention = 'probe';
    } else {
      // Okay but could be stronger
      intervention = 'reinforce';
    }

    // Compute priority score (higher = more urgent)
    // Gap to target (0-0.8 maps to 0.8-0)
    const gapScore = Math.max(0, DEFAULTS.targetRecall - rankingRecall);
    // Low confidence boost
    const confidenceBoost = confidence < DEFAULTS.confidenceThreshold ? 0.2 : 0;
    // Stale probe boost
    const staleBoost = daysSinceProbe > DEFAULTS.daysSinceProbeThreshold ? 0.1 : 0;
    // 256D gap alignment: boost concepts aligned with exam cold spots
    // Base 0.15, scales up to 0.30 as exam approaches (examPressure → 1)
    const rawConceptEmb = conceptEmbeddings.get(concept.id);
    const conceptEmb = rawConceptEmb ? truncateToManifoldDim(rawConceptEmb) : null;
    const gapAlignmentBoost =
      conceptEmb && gapDirection
        ? Math.max(0, cosineSimilarity(conceptEmb, gapDirection)) * (0.15 + examPressure * 0.15)
        : 0;
    // Liked concept boost: user explicitly wants more of this
    const likedBoost = likedConceptIds.has(concept.id) ? 0.15 : 0;
    // Acute-failure boost: user failed this concept in the last 2h. Bump
    // its priority so the next batch fetch (within the same session) surfaces
    // remediation rather than continuing the manifold walk away from the
    // failure. Decays naturally as 2h passes without further failure.
    // Magnitude (0.25) deliberately above likedBoost — fresh failure is a
    // stronger signal than a stale "I like this" preference.
    const recentFailureBoost = recentFailureConceptIds.has(concept.id) ? 0.25 : 0;
    // Exam weight multiplier
    const examWeightMultiplier = (concept.examWeight || 1) / 3; // Normalize 1-5 to ~0.3-1.7

    // Soft-deprioritise concepts whose current recall is already very high so
    // session-average predictedRecall lands in the desirable 0.6-0.8 band rather
    // than the >0.85 "wasting review time" band flagged by walk-audit.
    // Chronic-failure concepts opt out: even if the model thinks recall is high,
    // we know the user keeps missing items in this concept — keep them surfaced
    // so struggle-interventions can scaffold them.
    const recallSoftPenalty = computeRecallSoftPenalty(currentRecall, confidence, {
      isChronicFailure: chronicFailureConceptIds.has(concept.id),
    });

    const priority =
      (gapScore + confidenceBoost + staleBoost + gapAlignmentBoost + likedBoost + recentFailureBoost) *
      examWeightMultiplier *
      recallSoftPenalty;

    return {
      conceptId: concept.id,
      conceptName: concept.name,
      currentRecall,
      recallOnExamDay,
      confidence,
      exposureCount,
      daysSinceProbe,
      daysSinceExposure,
      priority,
      intervention,
    };
  });

  // 4b. Prerequisite boosting: weak concepts pull their prereqs forward so sessions
  // naturally include “build-up” items before high-integration items.
  const statesById = new Map(conceptStates.map((s) => [s.conceptId, s]));
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  for (const concept of concepts) {
    const state = statesById.get(concept.id);
    if (!state) continue;
    if (state.recallOnExamDay >= DEFAULTS.targetRecall) continue;

    const baseBoost = state.priority * 0.85;
    if (baseBoost <= 0) continue;

    const visited = new Set<string>([concept.id]);
    const queue: Array<{ id: string; depth: number }> = concept.prerequisiteIds.map((id) => ({
      id,
      depth: 1,
    }));

    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (visited.has(next.id)) continue;
      visited.add(next.id);

      const prereq = statesById.get(next.id);
      if (!prereq) continue;

      const boostedPriority = baseBoost * Math.pow(0.7, next.depth - 1);

      // Don’t waste slots on prereqs already very solid.
      const prereqIsSolid =
        prereq.recallOnExamDay >= DEFAULTS.targetRecall && prereq.confidence >= DEFAULTS.confidenceThreshold;
      if (!prereqIsSolid) {
        prereq.priority = Math.max(prereq.priority, boostedPriority);
      }

      // Expand transitively (depth-capped).
      if (next.depth < 3) {
        const prereqConcept = conceptById.get(next.id);
        if (!prereqConcept) continue;

        for (const prereqId of prereqConcept.prerequisiteIds) {
          if (!visited.has(prereqId)) {
            queue.push({ id: prereqId, depth: next.depth + 1 });
          }
        }
      }
    }
  }

  // 4c. Hub readiness gating: dampen hub concepts whose prerequisites aren't ready.
  // This is complementary to prerequisite boosting above — boosting pulls prereqs forward,
  // gating holds hubs back. Together they ensure sessions build foundations before testing connections.
  const prereqRecallMap = new Map(
    conceptStates.map((s) => [s.conceptId, s.recallOnExamDay]),
  );
  for (const concept of concepts) {
    if (concept.prerequisiteIds.length === 0) continue;
    const state = statesById.get(concept.id);
    if (!state) continue;

    const hubReady = computeHubReadiness(concept.prerequisiteIds, prereqRecallMap);
    if (!hubReady.ready) {
      state.priority *= hubReady.dampening;
    }
  }

  // 4d. Await bulk candidates (started in parallel with step 3)
  const bulk = await bulkPromise;
  // Card-level gapBoost is now driven by SQL-side cardGapAlignment (populated
  // when scoreItemsByGapAlignment is wired up; no-op while courseware_embeddings
  // is empty). The per-concept gapAlignmentBoost above still uses the JS
  // gapDirection because it operates on ~100 concept vectors, not thousands of
  // cards. See docs/superpowers/plans/2026-04-28-embedding-egress-elimination.md.

  // Build topic→cluster map from bulk card data for round-robin grouping
  const topicToCluster = new Map<string, string>();
  for (const card of [...bulk.unseenCards, ...bulk.seenCards]) {
    if (!card.clusterId) continue;
    for (const topic of card.topics) {
      if (!topicToCluster.has(topic)) {
        topicToCluster.set(topic, card.clusterId);
      }
    }
  }

  function getConceptCluster(concept: ConceptState): string {
    const conceptData = conceptMap.get(concept.conceptId);
    if (!conceptData) return concept.conceptId;
    for (const topic of conceptData.topics) {
      const cluster = topicToCluster.get(topic);
      if (cluster) return cluster;
    }
    return concept.conceptId; // fallback: each concept is its own group
  }

  // 4e. Inter-session cluster dampening: reduce priority for concepts in clusters
  // that dominated the previous session, ensuring day-to-day variety.
  if (recentClusterExposures && recentClusterExposures.size > 0) {
    const totalRecentExposures = [...recentClusterExposures.values()].reduce((sum, c) => sum + c, 0);
    if (totalRecentExposures > 0) {
      for (const state of conceptStates) {
        const conceptCluster = getConceptCluster(state);
        const clusterCount = recentClusterExposures.get(conceptCluster) ?? 0;
        const clusterWeight = clusterCount / totalRecentExposures;
        // Dampening: cluster at 100% of recent session -> priority *= 0.7
        // Cluster at 0% -> no dampening. Never reduce below 50% of original priority.
        const clusterDampening = Math.max(0.5, 1.0 - 0.3 * clusterWeight);
        state.priority *= clusterDampening;
      }
    }
  }

  // Track unseen card IDs for new-card budget enforcement
  const unseenCardIds = new Set(bulk.unseenCards.map(c => c.id));
  const maxNewCards = effectiveMaxNewCards ?? Infinity;
  let newCardCount = 0;

  // 5. Sort by priority (highest first) with jitter to avoid deterministic ordering.
  // ±30% jitter ensures different weak concepts surface each session instead of
  // the same top-7 dominating every time. High-urgency items still appear often
  // but aren't guaranteed to fill every session.
  for (const state of conceptStates) {
    const jitter = (Math.random() - 0.5) * 0.6 * Math.max(state.priority, 0.05);
    state.priority += jitter;
  }
  conceptStates.sort((a, b) => b.priority - a.priority);

  // Precompute which concepts have unseen cards in bulk — used both for
  // the strong-but-pristine extension below AND for the coverage lane (7d).
  // One pass over (concepts × unseen cards), cached for reuse.
  const conceptHasPristine = new Set<string>();
  for (const c of concepts) {
    const topicSet = new Set<string>(expandTopicSet(c.topics));
    for (const card of bulk.unseenCards) {
      if (card.topics.some((t) => topicSet.has(t))) {
        conceptHasPristine.add(c.id);
        break;
      }
    }
  }

  // 6. Select concepts that need work.
  //   Primary: weak by recall (recallOnExamDay < targetRecall).
  //   Extension: STRONG-BUT-PRISTINE concepts (recall >= targetRecall but with
  //   unseen cards still in bulk). Previously these were excluded entirely
  //   and only reachable via the meager coverage lane (7d, ~2 reserved slots).
  //   PAAM postmortem: at exam time ~68% of pristine cards lived behind
  //   strong concepts → structurally unreachable. Including them in the
  //   weak-set lets the round-robin surface their pristine cards, naturally
  //   throttled by:
  //     - recallSoftPenalty (deprioritises high-recall concepts)
  //     - teaching cap (mastered concepts get 1 maintenance item)
  //   so they don't crowd out genuinely weak concepts.
  let weakConcepts = conceptStates.filter(
    (s) => s.recallOnExamDay < DEFAULTS.targetRecall || conceptHasPristine.has(s.conceptId)
  );

  // Under exam pressure, skip low-yield concepts
  if (minExamWeight > 1) {
    const filtered = weakConcepts.filter((s) => {
      const concept = conceptMap.get(s.conceptId);
      return concept && (concept.examWeight || 1) >= minExamWeight;
    });
    // Fallback: if filtering removes everything, keep original list
    if (filtered.length > 0) {
      weakConcepts = filtered;
    }
  }

  // 6b. Budget-aware filtering: skip concepts already projected to pass on exam day.
  // Uses currentRecall (not recallOnExamDay) because computeExposuresNeeded
  // applies its own forward projection internally.
  const budgetFilteredConcepts = weakConcepts.filter((c) => {
    const needed = computeExposuresNeeded(
      c.currentRecall, DEFAULTS.targetRecall, c.confidence, daysToExam
    );
    return needed > 0;
  });
  if (budgetFilteredConcepts.length > 0) {
    weakConcepts = budgetFilteredConcepts;
  }

  // 6c. D_eff maintenance shift: when knowledge breadth is narrowing, shift toward
  // broader card reviews (higher cardRatio) instead of deep-diving weak spots with MCQs.
  // See MATH_MODEL.md §8 — D_eff as a health metric.
  if (!options.cardRatio) {
    const conceptRecalls = conceptStates.map((s) => s.recallOnExamDay);
    const breadth = computeKnowledgeBreadth(conceptRecalls);
    const maintenanceShift = computeMaintenanceShift(breadth.breadthRatio, conceptStates.length);
    if (maintenanceShift > 0) {
      cardRatio = Math.min(0.9, cardRatio + maintenanceShift);
      logger.debug('D_eff maintenance shift', {
        dEff: breadth.dEff.toFixed(1),
        breadthRatio: breadth.breadthRatio.toFixed(2),
        maintenanceShift: maintenanceShift.toFixed(2),
        adjustedCardRatio: cardRatio.toFixed(2),
      });
    }
  }

  // 7. Select items from top concepts
  const targetCardCount = Math.ceil(size * cardRatio);
  const targetQuestionCount = size - targetCardCount;

  const selectedItems: UnifiedSessionItem[] = [];
  const selectedConceptIds = new Set<string>();
  const selectedCardIds = new Set<string>(excludedCardIds);
  const selectedQuestionIds = new Set<string>(excludedQuestionIds);
  const selectedVideoIds = new Set<string>(excludedVideoIds);
  const selectedQuestionVariantGroups = new Set<string>();
  const selectedCardVariantGroups = new Set<string>();
  // Shared per-session budget for mastered questions re-entering rotation now that
  // permanent retirement is gone (see knowledge/question-retirement.ts). Shared
  // across every per-concept getQuestionsFromBulk call, like the Sets above.
  const masteredReentryCounter = { masteredServed: 0 };
  const cardsPerConcept = new Map<string, number>();
  const questionsPerConcept = new Map<string, number>();
  const videosPerConcept = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  const similarityToSelected = new Map<string, number>(); // cardId -> max similarity to any selected card

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _maxCardsPerConcept = DEFAULTS.maxCardsPerConcept;
  const maxQuestionsPerConcept = DEFAULTS.maxQuestionsPerConcept;

  // Per-concept teaching arc — how many items each concept should consume
  // this session, based on its teaching state. naive=2, learning=3,
  // consolidating=3, mastered=1. The round-robin loops below consult this
  // cap (instead of the previous one-size-fits-all HARD_MAX_CARDS_PER_CONCEPT
  // = 3) so mastered concepts no longer eat 3 slots for maintenance work
  // they don't need and the freed budget goes to weak concepts that do.
  //
  // Cap is total items per concept (cards + questions + pre-teach combined).
  // The 7a-naive section above already added items for naive concepts; those
  // count against this budget via cardsPerConcept/questionsPerConcept.
  const conceptTeachingCap = new Map<string, number>();
  for (const cs of weakConcepts) {
    const state = classifyTeachingState({
      exposureCount: cs.exposureCount,
      recallOnExamDay: cs.recallOnExamDay,
      confidence: cs.confidence,
    });
    conceptTeachingCap.set(cs.conceptId, teachingArcFor(state).targetItems);
  }
  function teachingCapFor(conceptId: string): number {
    // Default 3 for concepts not in the weak-set (covers backfill paths
    // where teaching state wasn't computed). Matches old HARD_MAX behaviour.
    return conceptTeachingCap.get(conceptId) ?? 3;
  }
  function conceptItemsSoFar(conceptId: string): number {
    return (cardsPerConcept.get(conceptId) ?? 0) + (questionsPerConcept.get(conceptId) ?? 0);
  }

  let selectedCardCount = 0;
  let selectedQuestionCount = 0;

  function addItem(item: UnifiedSessionItem): boolean {
    // Every real-concept lane shares the same teaching budget. Keeping the
    // guard here prevents fallback, maintenance and orphan-rescue paths from
    // silently undoing the caps enforced by the primary round-robin loops.
    //
    // `_unattached` is an attribution bucket for unrelated orphan cards, not
    // a real concept, so counting it as one would truncate otherwise diverse
    // rescue content. Rotation top-up questions already use one synthetic id
    // per item, but are made explicit here for the same reason.
    const isSyntheticAttribution =
      item.conceptId === '_unattached' || item.conceptId.startsWith('rotation:');
    if (
      item.type !== 'video'
      && !isSyntheticAttribution
      && conceptItemsSoFar(item.conceptId) >= teachingCapFor(item.conceptId)
    ) {
      return false;
    }

    selectedItems.push(item);
    selectedConceptIds.add(item.conceptId);

    if (item.type === 'card') {
      selectedCardCount += 1;
      if (unseenCardIds.has(item.id)) newCardCount += 1;
      cardsPerConcept.set(item.conceptId, (cardsPerConcept.get(item.conceptId) ?? 0) + 1);
      selectedCardIds.add(item.id);
      // Record variant group on accept so pickCardCandidate (and any later
      // fallback path that takes this set as input) can refuse siblings.
      // Mirrors selectedQuestionVariantGroups for question variants.
      if (item.variantGroupId) selectedCardVariantGroups.add(item.variantGroupId);
      return true;
    }

    if (item.type === 'video') {
      videosPerConcept.set(item.conceptId, (videosPerConcept.get(item.conceptId) ?? 0) + 1);
      selectedVideoIds.add(item.id);
      return true;
    }

    selectedQuestionCount += 1;
    questionsPerConcept.set(item.conceptId, (questionsPerConcept.get(item.conceptId) ?? 0) + 1);
    selectedQuestionIds.add(item.id);
    const qSuppress = questionSuppressionKey(item);
    if (qSuppress) selectedQuestionVariantGroups.add(qSuppress);
    return true;
  }

  function wouldCauseInterference(candidate: CardCandidate, threshold: number): boolean {
    const knownSimilarity = similarityToSelected.get(candidate.id);
    if (typeof knownSimilarity === 'number' && knownSimilarity > threshold) return true;

    const links = parseSimilarLinks(candidate.similarCards);
    return links.some(
      (link) => selectedCardIds.has(link.cardId) && link.similarity > threshold
    );
  }

  function recordCardNeighborhood(candidate: CardCandidate): void {
    const links = parseSimilarLinks(candidate.similarCards);
    for (const link of links) {
      const current = similarityToSelected.get(link.cardId) ?? 0;
      if (link.similarity > current) similarityToSelected.set(link.cardId, link.similarity);
    }
  }

  function canUseCluster(clusterId: string | null, maxPerCluster: number): boolean {
    if (!clusterId) return true;
    return (clusterCounts.get(clusterId) ?? 0) < maxPerCluster;
  }

  function recordCluster(clusterId: string | null): void {
    if (!clusterId) return;
    clusterCounts.set(clusterId, (clusterCounts.get(clusterId) ?? 0) + 1);
  }

  function pickCardCandidate(
    candidates: CardCandidate[],
    constraints: { similarityThreshold: number; maxPerCluster: number }
  ): CardCandidate | null {
    for (const candidate of candidates) {
      if (selectedCardIds.has(candidate.id)) continue;
      // Sibling suppression: refuse any candidate whose cloze-variant group is
      // already represented in this session. Prevents serving 2-3 near-identical
      // cloze cards back-to-back. Mirrors the question variant suppression.
      if (candidate.variantGroupId && selectedCardVariantGroups.has(candidate.variantGroupId)) continue;
      // Skip unseen cards when new-card budget is exhausted
      if (unseenCardIds.has(candidate.id) && newCardCount >= maxNewCards) continue;
      if (!canUseCluster(candidate.clusterId, constraints.maxPerCluster)) continue;
      if (wouldCauseInterference(candidate, constraints.similarityThreshold)) continue;
      return candidate;
    }
    return null;
  }

  function getQuestionRequestDifficulty(
    reason: UnifiedSessionItem['interventionReason'],
    indexForConcept: number
  ): QuestionDifficulty {
    // High exam pressure: harder ladder regardless of intervention reason
    if (examPressure >= 0.5) {
      const plan: QuestionDifficulty[] = ['medium', 'hard', 'hard', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
    }

    if (reason === 'low_confidence') {
      const plan: QuestionDifficulty[] = ['easy', 'medium', 'medium', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'easy';
    }
    if (reason === 'needs_retest') {
      const plan: QuestionDifficulty[] = ['medium', 'hard', 'hard', 'hard'];
      return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
    }

    const plan: QuestionDifficulty[] = ['medium', 'hard'];
    return plan[Math.min(indexForConcept, plan.length - 1)] ?? 'medium';
  }

  // 7a) NEW: Video Pre-teach (Inject videos for very weak concepts)
  if (includeVideos) {
    const weakRecallConcepts = weakConcepts.filter(c => c.recallOnExamDay < 0.4 && c.confidence < 0.6);
    for (const concept of weakRecallConcepts) {
      if (selectedItems.length >= size) break;
      const already = videosPerConcept.get(concept.conceptId) ?? 0;
      if (already >= 1) continue;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const videos = getVideosFromBulk(concept.conceptId, conceptData, 1, bulk, { excludeVideoIds: selectedVideoIds });
      if (videos.length > 0) {
        const v = videos[0];
        addItem({
          type: 'video',
          id: v.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: 'pre_teach',
          videoTitle: v.title,
          videoThumbnailUrl: v.thumbnailR2Key,
          videoDuration: v.durationSecs ?? undefined,
          videoR2Key: v.r2Key,
          creatorName: v.creatorName ?? undefined,
        });
      }
    }
  }

  // 7a-naive) Naive-concept pre-teach.
  //
  // For each concept the user has zero prior exposure to (classified as
  // 'naive' by classifyTeachingState), inject a topic-matched C1 card
  // BEFORE the regular fill loop reaches that concept. Rationale: first
  // encounter with a brand-new concept should be a teaching moment, not
  // a cold test served from the C2/C3 pool. Empirical-difficulty data
  // (commit 4d863d17) shows ~60% of C1-labelled cards are actually hard
  // — that's a separate calibration problem, but the cleaner first-touch
  // surface here keeps cold-start failures from compounding.
  //
  // Capped at a small number (default 3) so this doesn't crowd out the
  // regular weak-concept loop. Picked cards count against the card
  // budget exactly like any other card pick.
  {
    const naivePreTeachConcepts: NaivePreTeachConcept[] = [];
    for (const cs of weakConcepts) {
      const state = classifyTeachingState({
        exposureCount: cs.exposureCount,
        recallOnExamDay: cs.recallOnExamDay,
        confidence: cs.confidence,
      });
      if (state !== 'naive') continue;
      const conceptData = conceptMap.get(cs.conceptId);
      if (!conceptData) continue;
      naivePreTeachConcepts.push({
        conceptId: cs.conceptId,
        conceptName: cs.conceptName,
        topics: conceptData.topics,
        priority: cs.priority,
      });
    }

    // Pre-teach C1 cards are UNSEEN → they are new cards and must respect the
    // new-card budget. In crunch mode (maxNewCards=0, e.g. exam-day review-only)
    // the regular fill adds no new cards; pre-teach must not sneak them in either.
    // Cap the picks to the remaining new-card budget as well as the card slots.
    const newCardBudgetRemaining = maxNewCards === Infinity ? Infinity : Math.max(0, maxNewCards - newCardCount);
    if (newCardBudgetRemaining > 0 && naivePreTeachConcepts.length > 0 && selectedCardCount < targetCardCount) {
      const slotsRemaining = targetCardCount - selectedCardCount;
      const picks = pickNaivePreTeachCards(naivePreTeachConcepts, bulk, {
        maxPreTeach: Math.min(3, slotsRemaining, newCardBudgetRemaining),
        alreadySelectedCardIds: selectedCardIds,
      });
      for (const pick of picks) {
        if (selectedCardCount >= targetCardCount) break;
        addItem({
          type: 'card',
          id: pick.card.id,
          conceptId: pick.conceptId,
          conceptName: pick.conceptName,
          priority: pick.priority,
          interventionReason: 'pre_teach_naive',
          variantGroupId: pick.card.variantGroupId,
          variantIndex: pick.card.variantIndex,
          variantType: pick.card.variantType,
        });
      }
    }
  }

  // 7b) Fill questions (round-robin across clusters)
  if (targetQuestionCount > 0) {
    const roundRobinForQuestions = buildClusterRoundRobin(weakConcepts, getConceptCluster);

    // Iterate the round-robin ordering repeatedly to fill the session.
    // Each pass allows one more question per concept (soft cap escalation).
    for (let pass = 0; selectedQuestionCount < targetQuestionCount; pass++) {
      const allowedPerConcept = maxQuestionsPerConcept + pass;
      let addedThisPass = 0;

      for (const concept of roundRobinForQuestions) {
        if (selectedQuestionCount >= targetQuestionCount) break;

        const already = questionsPerConcept.get(concept.conceptId) ?? 0;
        if (already >= allowedPerConcept) continue;
        // Teaching-state cap: don't exceed the concept's per-state target.
        // Mastered concepts cap at 1 item total; learning/consolidating at 3;
        // naive at 2 (the 7a-naive C1 already counts).
        if (conceptItemsSoFar(concept.conceptId) >= teachingCapFor(concept.conceptId)) continue;

        const baseReason =
          concept.intervention === 'probe'
            ? concept.confidence < DEFAULTS.confidenceThreshold || concept.exposureCount < 3
              ? 'low_confidence'
              : 'needs_retest'
            : concept.intervention === 'remediate'
              ? 'needs_retest'
              : 'reinforcement';
        const interventionReason = resolveInterventionReason({
          conceptId: concept.conceptId,
          recallOnExamDay: concept.recallOnExamDay,
          baseReason,
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        });

        // Difficulty ladder still keys off the base teaching-state reason —
        // a failure-escalation pick should use the same ladder it would've
        // used otherwise (needs_retest typically). The boost label is a
        // separate signal for analytics, not a difficulty input.
        const desiredDifficulty = getQuestionRequestDifficulty(baseReason, already);

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
          difficultyPlan: [desiredDifficulty],
          selectedQuestionIds,
          selectedQuestionVariantGroups,
          masteredReentryCounter,
          recentFormatsByConcept,
        });

        if (questions.length === 0) continue;

        const question = questions[0];
        const added = addItem({
          type: 'question',
          id: question.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason,
          variantGroupId: question.variantGroupId,
          variantType: question.variantType,
        });
        if (added) addedThisPass += 1;
      }

      if (addedThisPass === 0) break;
    }
  }

  // Coverage reservation — slots that the priority-driven 7c cannot consume,
  // so concepts outside `weakConcepts` (e.g., strong but pristine-rich) get a
  // path into every session. See
  // docs/designs/2026-04-29-scheduler-coverage-postmortem.md §10:
  // ~68% of pristine cards in PAAM are reachable only via strong concepts;
  // without a reservation, 7c monopolizes the budget and 8a never fires.
  // Disabled for crunch mode and when the caller pins maxNewCards = 0
  // (since coverage lane only picks pristine cards, it would no-op anyway).
  const coverageReservation =
    options.mode === 'crunch' || effectiveMaxNewCards === 0
      ? 0
      : Math.min(2, Math.max(0, Math.floor(targetCardCount * 0.3)));
  const targetWeakCardCount = Math.max(0, targetCardCount - coverageReservation);

  // 7c) Fill cards (round-robin across clusters for spatial diversity)
  if (targetWeakCardCount > 0) {
    // Safety ceiling — even if teaching-state suggests 4, never serve more
    // than 5 cards from a single concept in one session (queue health).
    const HARD_MAX_CARDS_PER_CONCEPT = 5;
    const roundRobinConcepts = buildClusterRoundRobin(weakConcepts, getConceptCluster);

    // Iterate the round-robin ordering repeatedly (up to HARD_MAX passes)
    // to fill the session. Each pass adds at most 1 card per concept.
    for (let pass = 0; pass < HARD_MAX_CARDS_PER_CONCEPT && selectedCardCount < targetWeakCardCount; pass++) {
      let addedThisPass = 0;

      for (const concept of roundRobinConcepts) {
        if (selectedCardCount >= targetWeakCardCount) break;

        const already = cardsPerConcept.get(concept.conceptId) ?? 0;
        if (already >= HARD_MAX_CARDS_PER_CONCEPT) continue;
        // Teaching-state cap: total items per concept ≤ teachingArc.targetItems
        // (mastered=1 maintenance, learning/consolidating=3, naive=2). The
        // safety ceiling above is the absolute backstop; this is the
        // pedagogically-intended budget.
        if (conceptItemsSoFar(concept.conceptId) >= teachingCapFor(concept.conceptId)) continue;

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.recallOnExamDay);
        if (candidates.length === 0) continue;

        const similarityThreshold = already === 0 ? interferenceThreshold : Math.min(0.97, interferenceThreshold + 0.1);
        const maxPerCluster = already === 0 ? 3 : 5;

        const picked = pickCardCandidate(candidates, { similarityThreshold, maxPerCluster });
        if (!picked) continue;

        const baseCardReason =
          concept.recallOnExamDay < DEFAULTS.recallThreshold
            ? 'weak_recall'
            : 'reinforcement';
        const added = addItem({
          type: 'card',
          id: picked.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: resolveInterventionReason({
            conceptId: concept.conceptId,
            recallOnExamDay: concept.recallOnExamDay,
            baseReason: baseCardReason,
            recentFailureConceptIds,
            conceptHasPristine,
            targetRecall: DEFAULTS.targetRecall,
          }),
          variantGroupId: picked.variantGroupId,
          variantIndex: picked.variantIndex,
          variantType: picked.variantType,
        });
        if (added) {
          recordCluster(picked.clusterId);
          recordCardNeighborhood(picked);
          addedThisPass += 1;
        }
      }

      if (addedThisPass === 0) break;
    }
  }

  // 7d) Coverage lane — fill the reserved slots with pristine cards from
  // concepts the main loop wouldn't reach. Concepts ordered by their pristine
  // pool size (most stranded first), exam-weight tiebreak. Skips concepts
  // already touched in this session.
  if (coverageReservation > 0 && selectedCardCount < targetCardCount) {
    const conceptPristineCount = new Map<string, number>();
    for (const c of concepts) {
      if (selectedConceptIds.has(c.id)) continue;
      // Use the SAME topic expansion as getCardsFromBulk so the ordering
      // signal matches what the picker can actually find. Earlier version
      // used exact topics, which silently excluded concepts whose cards only
      // match via expansion — pristine candidates were unreachable even
      // though getCardsFromBulk would have returned them.
      const conceptTopics = new Set<string>(expandTopicSet(c.topics));
      let count = 0;
      for (const card of bulk.unseenCards) {
        if (selectedCardIds.has(card.id)) continue;
        if (card.topics.some((t) => conceptTopics.has(t))) count++;
      }
      if (count > 0) conceptPristineCount.set(c.id, count);
    }

    const coverageOrder = [...conceptPristineCount.keys()]
      .map((id) => ({
        concept: conceptMap.get(id),
        state: statesById.get(id),
        pristineCount: conceptPristineCount.get(id) ?? 0,
      }))
      .filter((row) => row.concept !== undefined)
      .sort((a, b) => {
        if (a.pristineCount !== b.pristineCount) return b.pristineCount - a.pristineCount;
        return (b.concept!.examWeight ?? 1) - (a.concept!.examWeight ?? 1);
      });

    for (const { concept, state } of coverageOrder) {
      if (selectedCardCount >= targetCardCount) break;
      if (!concept) continue;

      const candidates = getCardsFromBulk(concept.id, concept, 20, bulk, selectedCardIds, penaltyContext, state?.recallOnExamDay);
      // Coverage lane only surfaces actually-pristine cards (the whole point).
      const pristineCandidates = candidates.filter((c) => unseenCardIds.has(c.id));
      if (pristineCandidates.length === 0) continue;

      const picked = pickCardCandidate(pristineCandidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = addItem({
        type: 'card',
        id: picked.id,
        conceptId: concept.id,
        conceptName: concept.name,
        priority: state?.priority ?? 0,
        // Coverage lane only picks pristine cards from concepts the main
        // loop didn't reach. If those concepts are strong (recall ≥ target),
        // that's E un-starve territory — surface it as strong_pristine so
        // analytics can see the lane firing. Failure-escalation still wins
        // if the user just failed this concept.
        interventionReason: resolveInterventionReason({
          conceptId: concept.id,
          recallOnExamDay: state?.recallOnExamDay ?? 0,
          baseReason: 'reinforcement',
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        }),
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });
      if (added) {
        recordCluster(picked.clusterId);
        recordCardNeighborhood(picked);
      }
    }
  }

  // 8. If still short on items, backfill from any concepts (cards + questions)
  if (selectedItems.length < size) {
    const remainingConcepts = conceptStates.filter((s) => {
      if (selectedConceptIds.has(s.conceptId)) return false;
      if (minExamWeight > 1) {
        const c = conceptMap.get(s.conceptId);
        if (!c || (c.examWeight || 1) < minExamWeight) return false;
      }
      return true;
    });

    // 8a. Backfill with cards — capped at targetCardCount so card backfill
    // does not absorb the question quota when 7b found no linked questions.
    // Without this cap, users with weak concepts that lack question→concept
    // links (e.g. stuanki-derived PAAM concepts) get all-card sessions even
    // when the rotation bank has unanswered MCQs ready for top-up below.
    for (const concept of remainingConcepts) {
      if (selectedItems.length >= size) break;
      if (selectedCardCount >= targetCardCount) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.recallOnExamDay);
      if (candidates.length === 0) continue;

      const picked = pickCardCandidate(candidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = addItem({
        type: 'card',
        id: picked.id,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        interventionReason: 'reinforcement',
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });
      if (added) {
        recordCluster(picked.clusterId);
        recordCardNeighborhood(picked);
      }
    }

    // 8b. Backfill with questions from any remaining concepts
    if (selectedItems.length < size) {
      const stillRemaining = conceptStates.filter((s) => {
        if (selectedConceptIds.has(s.conceptId)) return false;
        if (minExamWeight > 1) {
          const c = conceptMap.get(s.conceptId);
          if (!c || (c.examWeight || 1) < minExamWeight) return false;
        }
        return true;
      });
      for (const concept of stillRemaining) {
        if (selectedItems.length >= size) break;

        const conceptData = conceptMap.get(concept.conceptId);
        if (!conceptData) continue;

        const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
          difficultyPlan: ['medium'],
          selectedQuestionIds,
          selectedQuestionVariantGroups,
          masteredReentryCounter,
          recentFormatsByConcept,
        });
        if (questions.length === 0) continue;

        const question = questions[0];
        addItem({
          type: 'question',
          id: question.id,
          conceptId: concept.conceptId,
          conceptName: concept.conceptName,
          priority: concept.priority,
          interventionReason: 'reinforcement',
          variantGroupId: question.variantGroupId,
          variantType: question.variantType,
        });
      }
    }
  }

  // 8.2. Maintenance probing: when session is still short, pull questions from
  // strong concepts that haven't been probed recently. This ensures mastered
  // material gets periodically retested rather than being abandoned.
  if (selectedItems.length < size) {
    const staleStrongConcepts = conceptStates
      .filter((s) => {
        if (s.recallOnExamDay < DEFAULTS.targetRecall) return false;
        if (s.daysSinceProbe <= DEFAULTS.daysSinceProbeThreshold) return false;
        if (selectedConceptIds.has(s.conceptId)) return false;
        if (minExamWeight > 1) {
          const c = conceptMap.get(s.conceptId);
          if (!c || (c.examWeight || 1) < minExamWeight) return false;
        }
        return true;
      })
      .sort((a, b) => b.daysSinceProbe - a.daysSinceProbe); // most stale first

    for (const concept of staleStrongConcepts) {
      if (selectedItems.length >= size) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const questions = getQuestionsFromBulk(concept.conceptId, conceptData, 1, bulk, {
        difficultyPlan: ['hard'],
        selectedQuestionIds,
        selectedQuestionVariantGroups,
        masteredReentryCounter,
        recentFormatsByConcept,
      });
      if (questions.length === 0) continue;

      const question = questions[0];
      addItem({
        type: 'question',
        id: question.id,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        // 8a stale-strong fires only on already-strong concepts, so the
        // resolver will tag it as failure_escalation if a recent failure
        // happens to coincide, or strong_pristine if the concept still
        // has unseen cards; otherwise the base needs_retest sticks.
        interventionReason: resolveInterventionReason({
          conceptId: concept.conceptId,
          recallOnExamDay: concept.recallOnExamDay,
          baseReason: 'needs_retest',
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        }),
        variantGroupId: question.variantGroupId,
        variantType: question.variantType,
      });
    }
  }

  // 8b. Rotation-bank top-up: when concept-driven selection under-fills the
  // batch (sparse concept coverage, missing question-concept links), pad with
  // unanswered questions from the rotation bank so users always see a full
  // session instead of hitting a loading screen every few cards.
  //
  // Cap the top-up at the unmet question quota (`targetQuestionCount -
  // selectedQuestionCount`) instead of the whole remaining deficit. Without
  // this cap, sessions where weak concepts have no topic-matching cards (e.g.
  // PAAM stuanki concepts whose topics like "Cluster"/"Detail" don't intersect
  // the cards' "BPD"/"Borderline" topic strings) saw rotation top-up claim
  // the full card budget, and the downstream card backfill (8c) and orphan
  // rescue (8d) never ran. Result: weeks of 15-question/0-card sessions.
  // Capping here lets 8c/8d surface cards before falling back to extra
  // questions in the final orphan-question pass at the end of 8d.
  if (selectedItems.length < size) {
    const questionDeficit = Math.max(0, targetQuestionCount - selectedQuestionCount);
    const deficit = Math.min(size - selectedItems.length, questionDeficit);
    if (deficit > 0) {
      const alreadyPicked = new Set<string>(selectedQuestionIds);
      for (const i of selectedItems) {
        if (i.type === 'question') alreadyPicked.add(i.id);
      }
      try {
        const topup = await getQuestionsForRotation(userId, rotation, deficit, {
          selectedQuestionIds: alreadyPicked,
          selectedQuestionVariantGroups,
          questionFamiliarity: bulk.questionFamiliarity,
          masteredReentryCounter,
        });
        for (const q of topup) {
          addItem({
            type: 'question',
            id: q.id,
            conceptId: `rotation:${q.id}`,
            conceptName: 'Rotation fill',
            priority: 0.4,
            interventionReason: 'needs_retest',
            variantGroupId: q.variantGroupId,
            variantType: q.variantType,
          });
        }
      } catch (err) {
        logger.warn('Rotation top-up failed, continuing with short batch', {
          rotation, deficit, error: String(err),
        });
      }
    }
  }

  // 8c. Final uncapped card backfill — if all question-fill paths above were
  // exhausted (no concept links, no stale-strong, no rotation bank), make up
  // the remaining deficit with cards rather than shipping a short session.
  if (selectedItems.length < size) {
    const stillRemaining = conceptStates.filter((s) => {
      if (selectedConceptIds.has(s.conceptId)) return false;
      if (minExamWeight > 1) {
        const c = conceptMap.get(s.conceptId);
        if (!c || (c.examWeight || 1) < minExamWeight) return false;
      }
      return true;
    });
    for (const concept of stillRemaining) {
      if (selectedItems.length >= size) break;

      const conceptData = conceptMap.get(concept.conceptId);
      if (!conceptData) continue;

      const candidates = getCardsFromBulk(concept.conceptId, conceptData, 20, bulk, selectedCardIds, penaltyContext, concept.recallOnExamDay);
      if (candidates.length === 0) continue;

      const picked = pickCardCandidate(candidates, {
        similarityThreshold: Math.min(0.97, interferenceThreshold + 0.1),
        maxPerCluster: 5,
      });
      if (!picked) continue;

      const added = addItem({
        type: 'card',
        id: picked.id,
        conceptId: concept.conceptId,
        conceptName: concept.conceptName,
        priority: concept.priority,
        // 8c uncapped backfill — same resolver pass so D/E aren't lost in
        // the deepest fallback lane either.
        interventionReason: resolveInterventionReason({
          conceptId: concept.conceptId,
          recallOnExamDay: concept.recallOnExamDay,
          baseReason: 'reinforcement',
          recentFailureConceptIds,
          conceptHasPristine,
          targetRecall: DEFAULTS.targetRecall,
        }),
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });
      if (added) {
        recordCluster(picked.clusterId);
        recordCardNeighborhood(picked);
      }
    }
  }

  // 8d. Orphan rescue — final fill that surfaces pristine cards / un-responded
  // questions even when they have no topic intersection with any concept (the
  // ~17% topic-orphan tier in PAAM measured in 2026-04-29 post-mortem §4) or
  // no questionConcept link (~42% of un-responded questions for power users).
  //
  // No per-type cap: if the upstream passes left a deficit and there's
  // anything left in the pool, fill to session size. Cards first, then
  // questions. This is what enforces the "never show 'nothing more' when
  // pool > 0" UX guarantee — the empty-state should only fire when the
  // pristine pool is genuinely zero.
  //
  // Skipped only when the caller has explicitly pinned maxNewCards = 0
  // (e.g., crunch mode), which is incompatible with surfacing pristine cards.
  if (selectedItems.length < size && effectiveMaxNewCards !== 0) {
    const findAttributionConcept = (topics: string[]): { id: string; name: string } => {
      for (const c of concepts) {
        const expanded = new Set(expandTopicSet(c.topics));
        if (topics.some((t) => expanded.has(t))) return { id: c.id, name: c.name };
      }
      return { id: '_unattached', name: 'Unattached' };
    };

    // Pass 1: pristine cards. Sort by importance (high first) so foundational
    // cards rescue ahead of stretch cards.
    const orphanCards = bulk.unseenCards
      .filter((c) => !selectedCardIds.has(c.id))
      .sort((a, b) => (b.importance ?? 1) - (a.importance ?? 1));
    for (const card of orphanCards) {
      if (selectedItems.length >= size) break;
      // Respect cloze-variant suppression even in the orphan-rescue lane: surfacing
      // two siblings of the same group back-to-back here is the worst place for it
      // (no concept context to soften the redundancy).
      if (card.variantGroupId && selectedCardVariantGroups.has(card.variantGroupId)) continue;
      const attribution = findAttributionConcept(card.topics);
      addItem({
        type: 'card',
        id: card.id,
        conceptId: attribution.id,
        conceptName: attribution.name,
        priority: 0.2,
        interventionReason: 'reinforcement',
        variantGroupId: card.variantGroupId,
        variantIndex: card.variantIndex,
        variantType: card.variantType,
      });
      // Don't recordCluster / recordCardNeighborhood here — those signals
      // exist for within-session interference avoidance among related cards;
      // orphan rescue is by definition about reaching unrelated material.
    }

    // Pass 2: un-responded questions. Variant filter still respected because
    // surfacing two near-identical questions is worse than ending the session
    // a touch short.
    const orphanQuestions = prioritizeLeastRecentlyServedContrastSiblings(
      bulk.rotationQuestions.filter((q) => !selectedQuestionIds.has(q.id)),
      (question) => question.id,
      bulk.questionFamiliarity,
    );
    for (const q of orphanQuestions) {
      if (selectedItems.length >= size) break;
      const qKey = questionSuppressionKey(q);
      if (qKey && selectedQuestionVariantGroups.has(qKey)) continue;
      // This rescue lane has no ranking of its own, so without the cap it would fill
      // the session tail with mastered questions in raw DB order once the pristine
      // card pool is exhausted.
      if (!takeWithReentryCap(q.id, bulk.questionFamiliarity, resolveRetirementPolicy(), masteredReentryCounter)) {
        continue;
      }
      const attribution = findAttributionConcept(q.topics);
      addItem({
        type: 'question',
        id: q.id,
        conceptId: attribution.id,
        conceptName: attribution.name,
        priority: 0.2,
        interventionReason: 'reinforcement',
        variantGroupId: q.variantGroupId,
        variantType: q.variantType,
      });
    }
  }

  // 8.5. Apply struggle interventions to stuck cards
  // This is the local intelligence layer: detect stuck cards and apply interventions
  let itemsWithInterventions: UnifiedSessionItem[];
  try {
    itemsWithInterventions = await applyStruggleInterventions(
      userId,
      rotation,
      selectedItems
    );
  } catch (err) {
    logger.warn('Struggle interventions failed, using items as-is', { error: String(err) });
    itemsWithInterventions = selectedItems;
  }

  // 9. Order by manifold walk (replaces round-robin interleaving)
  const sessionCardIds = itemsWithInterventions.filter((i) => i.type === 'card').map((i) => i.id);
  const sessionQuestionIds = itemsWithInterventions.filter((i) => i.type === 'question').map((i) => i.id);
  const sessionVideoIds = itemsWithInterventions.filter((i) => i.type === 'video').map((i) => i.id);

  const [itemEmbeddings, flowResult] = await Promise.all([
    batchLoadItemEmbeddings(sessionCardIds, sessionQuestionIds, sessionVideoIds),
    flowAxisPromise,
  ]);
  const ordered = orderByManifoldWalk(itemsWithInterventions, itemEmbeddings, {
    flowAxis: flowResult?.axis && flowResult.axis.length > 0 ? flowResult.axis : undefined,
  });

  // 9b. Apply difficulty rhythm — light reorder for challenge/relief oscillation
  // Derive difficulty from priority: high priority = weak concept = hard for the student
  for (const item of ordered) {
    item.difficulty = item.priority > 0.66 ? 'hard' : item.priority > 0.33 ? 'medium' : 'easy';
  }
  const rhythmOrdered = applyDifficultyRhythm(ordered, options.commitmentLevel ?? 'browser');

  // 9c. Break trailing same-type runs that would trip walk-audit's modality-monotony
  // pathology. Applied after rhythm so we don't fight its swaps; only a final sweep.
  const monotonyOrdered = breakModalityRuns(rhythmOrdered);

  // 9d. Populate topics + complexity on items from bulk lookups so the
  // preemptive-scaffold pass can do topic-overlap matching without re-fetching.
  const cardMetaById = new Map<string, {
    topics: string[];
    complexity: number;
    clusterId: string | null;
    facilityIndex: number | null;
    sampleSize: number | null;
  }>();
  for (const c of [...bulk.unseenCards, ...bulk.seenCards]) {
    cardMetaById.set(c.id, {
      topics: c.topics,
      complexity: c.complexity,
      clusterId: c.clusterId,
      facilityIndex: c.facilityIndex,
      sampleSize: c.sampleSize,
    });
  }
  for (const it of monotonyOrdered) {
    if (it.type === 'card') {
      const meta = cardMetaById.get(it.id);
      if (meta) {
        if (!it.topics) it.topics = meta.topics;
        if (it.complexity == null) it.complexity = meta.complexity;
        if (it.clusterId == null) it.clusterId = meta.clusterId;
      }
    } else if (it.type === 'question') {
      const meta = bulk.questionMap.get(it.id);
      if (meta && !it.topics) it.topics = meta.topics;
    }
  }

  // 9e. Pre-emptively pair high-pressure items (questions and C≥2 cards) with
  // a topic-matched complexity-1 card. Closes the no-scaffolding-on-fail gap
  // for first-encounter misses that applyStruggleInterventions can't catch
  // (it only fires on items already known to be stuck). Cap scales with anchor
  // count, hard ceiling at items.length/4. When a pairable anchor finds no
  // matching scaffold, log a ContentGap row so demand surfaces in scaffold:needs.
  // See @/lib/knowledge/preemptive-scaffold and
  // docs/superpowers/specs/2026-05-03-paam-scaffolding-loop-design.md.
  const scaffoldPaired = injectPreemptiveScaffolds(monotonyOrdered, bulk, {
    // Paired scaffolds come exclusively from bulk.unseenCards, so they are
    // new material too. Keep review-only sessions strict: the final pairing
    // pass must not bypass maxNewCards=0 or grow the requested queue with a
    // pristine C1 after all earlier selection gates have run.
    maxPairings: effectiveMaxNewCards === 0 ? 0 : undefined,
    // Fire-and-forget; recordScaffoldGap never throws/rejects and enriches the
    // row with conceptId + a real topic-matched C1 candidateCount so the gap is
    // a usable authoring-vs-consumption signal, not a conceptId:null/0 stub.
    recordGap: (gap) => {
      void recordScaffoldGap(gap);
    },
  });

  // 9f. Final modality guard. injectPreemptiveScaffolds inserts C1 cards
  // after questions/C≥2 anchors, which can extend a trailing card run that
  // step 9c had bounded at 5 (e.g. [q, 5×c] → scaffold inserts c1 after q
  // → 6×c). Re-apply the guard so the scheduler's contract — output runs
  // ≤ MODALITY_MAX_SAME_TYPE_RUN — survives the scaffold pass. Verified by
  // regression test in preemptive-scaffold.test.ts.
  const teachingCapped = enforceConceptTeachingCaps(scaffoldPaired, teachingCapFor);
  const finalOrdered = breakModalityRuns(teachingCapped);

  // 10. Attach item-recall telemetry after ordering. This remains descriptive
  // and cannot change queue membership or rank.
  //
  // Do not create TeachingSignal rows here. This function runs for cache builds,
  // not actual deliveries, and the client never returned signalId on grade. That
  // produced a large orphaned prediction table with effectively no outcomes.
  // ServeDecision + LearningEvent are the delivery-grounded measurement contract.
  for (const item of finalOrdered) {
    const rawState = stateMap.get(item.conceptId);
    const scheduledState = statesById.get(item.conceptId);
    const serveRecallEstimate = scheduledState?.currentRecall ?? rawState?.recallProbability ?? 0;
    const serveExposureCount = scheduledState?.exposureCount ?? rawState?.exposureCount ?? 0;
    // Concept recall is the person/concept prior; item facility and its sample
    // size adjust it toward the actual item base rate. Scaffolds and videos have
    // no calibrated binary review outcome and remain unset.
    if (isCalibratedReviewItem(item)) {
      const cardMeta = item.type === 'card' ? cardMetaById.get(item.id) : undefined;
      const questionMeta = item.type === 'question' ? bulk.questionMap.get(item.id) : undefined;
      const estimate = estimateItemRecall({
        conceptRecall: serveRecallEstimate,
        conceptExposureCount: serveExposureCount,
        itemType: item.type,
        facilityIndex: cardMeta?.facilityIndex ?? questionMeta?.facilityIndex ?? null,
        sampleSize: cardMeta?.sampleSize ?? questionMeta?.totalAttempts ?? null,
        complexity: cardMeta?.complexity ?? item.complexity ?? null,
        difficulty: questionMeta?.difficulty ?? item.difficulty ?? null,
      });
      item.predictedRecall = estimate.predictedRecall;
      item.predictedRecallModel = estimate.model;
      item.predictedRecallSource = estimate.source;
      item.predictedRecallStatus = estimate.validationStatus;
    }
  }

  // 11. Compute stats
  const cardCount = finalOrdered.filter((i) => i.type === 'card').length;
  const questionCount = finalOrdered.filter((i) => i.type === 'question').length;
  const avgPriority =
    finalOrdered.length > 0
      ? finalOrdered.reduce((sum, i) => sum + i.priority, 0) / finalOrdered.length
      : 0;
  const conceptPairingRate = computeConceptPairingRate(finalOrdered);

  return {
    items: finalOrdered,
    stats: {
      totalConcepts: concepts.length,
      weakConcepts: weakConcepts.length,
      selectedConcepts: selectedConceptIds.size,
      cardCount,
      questionCount,
      averagePriority: Math.round(avgPriority * 1000) / 1000,
      examPressure: Math.round(examPressure * 100) / 100,
      conceptPairingRate,
      dailyThroughput: Math.round(budget.dailyThroughput),
      totalBudgetRemaining: Math.round(budget.totalRemaining),
      sessionsRemaining: budget.sessionsRemaining,
    },
  };
}

// =============================================================================
// Cluster-Driven Fallback (for rotations without Concept rows)
// =============================================================================

async function constructClusterSession(
  userId: string,
  options: {
    rotation: string;
    size: number;
    cardRatio: number;
    maxNewCards: number;
    excludeCardIds: string[];
    excludeQuestionIds: string[];
  }
): Promise<UnifiedSessionResult> {
  const {
    rotation,
    size,
    cardRatio,
    maxNewCards,
    excludeCardIds,
    excludeQuestionIds,
  } = options;

  const clusters = await getClusterMastery(userId, rotation);
  if (clusters.length === 0) {
    // Cluster fallback found no clusters either → empty session. Logged so this
    // root cause is distinguishable from "user genuinely finished the rotation".
    logger.warn('scheduler: cluster fallback produced empty session', { rotation });
    return {
      items: [],
      stats: {
        totalConcepts: 0,
        weakConcepts: 0,
        selectedConcepts: 0,
        cardCount: 0,
        questionCount: 0,
        averagePriority: 0,
      },
    };
  }

  const clusterStates = clusters.map((cluster) => {
    const coverage = cluster.cardCount > 0 ? cluster.cardsReviewed / cluster.cardCount : 1;
    const mastery = cluster.mastery ?? 0;
    const priority = (1 - coverage) * 0.6 + (1 - mastery) * 0.4 + (cluster.needsAttention ? 0.1 : 0);
    return {
      ...cluster,
      coverage,
      priority,
    };
  });

  clusterStates.sort((a, b) => b.priority - a.priority);

  const targetCardCount = Math.ceil(size * cardRatio);
  const targetQuestionCount = size - targetCardCount;

  const selectedItems: UnifiedSessionItem[] = [];
  const selectedCardIds = new Set<string>(excludeCardIds);
  const selectedQuestionIds = new Set<string>(excludeQuestionIds);
  const selectedQuestionVariantGroups = new Set<string>();
  const cardsPerCluster = new Map<string, number>();
  const selectedClusterIds = new Set<string>();

  let selectedCardCount = 0;

  for (let pass = 0; selectedCardCount < targetCardCount; pass++) {
    const maxPerCluster = 2 + pass;
    let addedThisPass = 0;

    for (const cluster of clusterStates) {
      if (selectedCardCount >= targetCardCount) break;
      const already = cardsPerCluster.get(cluster.clusterId) ?? 0;
      if (already >= maxPerCluster) continue;

      const candidates = await getCardsForCluster(userId, rotation, cluster.clusterId, 12, {
        selectedCardIds,
        minComplexity: 2,
      });
      if (candidates.length === 0) continue;

      const picked = candidates[0];
      selectedItems.push({
        type: 'card',
        id: picked.id,
        conceptId: cluster.clusterId,
        conceptName: cluster.clusterName,
        priority: cluster.priority,
        interventionReason: cluster.mastery < 0.6 ? 'weak_recall' : 'reinforcement',
        rotation,
        topics: picked.topics,
        complexity: picked.complexity,
        clusterId: picked.clusterId,
        variantGroupId: picked.variantGroupId,
        variantIndex: picked.variantIndex,
        variantType: picked.variantType,
      });

      selectedCardIds.add(picked.id);
      selectedCardCount += 1;
      cardsPerCluster.set(cluster.clusterId, already + 1);
      selectedClusterIds.add(cluster.clusterId);
      addedThisPass += 1;
    }

    if (addedThisPass === 0) break;
  }

  if (targetQuestionCount > 0) {
    // This fallback path returns before bulkFetchCandidates, so it has no familiarity
    // map — load one. Without it selectVariantAwareQuestions would draw mastered and
    // fresh questions with equal probability (it is only never-answered-first WITHIN a
    // variant group; see the note in getQuestionsForRotation).
    const questionFamiliarity = await loadQuestionFamiliarity(
      prisma as unknown as Parameters<typeof loadQuestionFamiliarity>[0],
      userId,
    );
    const questions = await getQuestionsForRotation(userId, rotation, targetQuestionCount, {
      selectedQuestionIds,
      selectedQuestionVariantGroups,
      questionFamiliarity,
      masteredReentryCounter: { masteredServed: 0 },
    });

    for (const q of questions) {
      selectedItems.push({
        type: 'question',
        id: q.id,
        conceptId: `question:${q.id}`,
        conceptName: 'Rotation probe',
        priority: 0.5,
        interventionReason: 'needs_retest',
        rotation,
        topics: q.topics,
        variantGroupId: q.variantGroupId,
        variantType: q.variantType,
      });
      const suppressKey = questionSuppressionKey(q);
      if (suppressKey) selectedQuestionVariantGroups.add(suppressKey);
    }
  }

  const clusterCardIds = selectedItems.filter((i) => i.type === 'card').map((i) => i.id);
  const clusterQuestionIds = selectedItems.filter((i) => i.type === 'question').map((i) => i.id);
  const clusterEmbeddings = await batchLoadItemEmbeddings(clusterCardIds, clusterQuestionIds);
  const clusterOrdered = orderByManifoldWalk(selectedItems, clusterEmbeddings);

  // Cluster-only rotations do not go through bulkFetchCandidates, so build the
  // smallest possible pool for the shared preemptive-scaffold pass here. Keep
  // C1 cards out of the anchor selection above, then pair only unseen C1 cards
  // from the exact clusters represented in this session. The caller's recent
  // and explicit exclusions are already present in selectedCardIds.
  const unseenClusterScaffolds = maxNewCards === 0
    ? []
    : await getUnseenScaffoldsForClusters(
        userId,
        rotation,
        [...selectedClusterIds],
        selectedCardIds,
      );
  const scaffoldPaired = injectPreemptiveScaffoldsFromPool(
    clusterOrdered,
    {
      rotation,
      candidateCards: unseenClusterScaffolds,
    },
    {
      matchBy: 'cluster',
      // A review-only/crunch session must not grow by introducing pristine C1
      // cards after its anchor budget has already been assembled.
      maxPairings: maxNewCards === 0 ? 0 : undefined,
    },
  );

  // The shared scaffold candidate shape is intentionally minimal. Restore the
  // cloze-variant identity carried by the full cluster candidate so hydration,
  // sibling suppression, and walk audits see the same metadata as anchors.
  const scaffoldMetaById = new Map(unseenClusterScaffolds.map((card) => [card.id, card]));
  for (const item of scaffoldPaired) {
    if (item.type !== 'card' || item.interventionReason !== 'preemptive_scaffold') continue;
    const meta = scaffoldMetaById.get(item.id);
    if (!meta) continue;
    item.variantGroupId = meta.variantGroupId;
    item.variantIndex = meta.variantIndex;
    item.variantType = meta.variantType;
  }

  const clusterTeachingCaps = new Map(
    clusterStates.map((cluster) => [
      cluster.clusterId,
      teachingArcFor(classifyTeachingState({
        exposureCount: cluster.cardsReviewed,
        recallOnExamDay: cluster.mastery,
        confidence: cluster.mastery,
      })).targetItems,
    ]),
  );
  const teachingCapped = enforceConceptTeachingCaps(
    scaffoldPaired,
    (conceptId) => clusterTeachingCaps.get(conceptId) ?? 3,
  );
  const finalOrdered = breakModalityRuns(teachingCapped);

  const avgPriority =
    finalOrdered.length > 0
      ? finalOrdered.reduce((sum, i) => sum + i.priority, 0) / finalOrdered.length
      : 0;
  const finalCardCount = finalOrdered.filter((item) => item.type === 'card').length;
  const finalQuestionCount = finalOrdered.filter((item) => item.type === 'question').length;

  return {
    items: finalOrdered as UnifiedSessionItem[],
    stats: {
      totalConcepts: clusters.length,
      weakConcepts: clusterStates.filter((c) => c.priority > 0).length,
      selectedConcepts: selectedClusterIds.size,
      cardCount: finalCardCount,
      questionCount: finalQuestionCount,
      averagePriority: Math.round(avgPriority * 1000) / 1000,
      conceptPairingRate: computeConceptPairingRate(finalOrdered),
    },
  };
}

// =============================================================================
// Helper Functions
// =============================================================================



async function getCardsForCluster(
  userId: string,
  rotation: string,
  clusterId: string,
  maxCandidates: number,
  options: { selectedCardIds: Set<string>; minComplexity?: number }
): Promise<CardCandidate[]> {
  const excludedIds = options.selectedCardIds.size > 0 ? [...options.selectedCardIds] : undefined;
  // Same topics gate every other read path applies — without it the cluster
  // fallback can serve _needs-image / _incomplete-data cards.
  const excludedTopicsNot = { topics: { hasSome: [...EXCLUDED_TOPICS] } };

  const [newCards, weakCards] = await Promise.all([
    prisma.card.findMany({
      where: {
        rotation,
        clusterId,
        deletedAt: null,
        shelvedAt: null,
        ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
        ...(options.minComplexity != null
          ? { complexity: { gte: options.minComplexity } }
          : {}),
        progress: { none: { userId } },
        NOT: excludedTopicsNot,
      },
      select: {
        id: true,
        clusterId: true,
        similarCards: true,
        topics: true,
        sourceFile: true,
        importance: true,
        complexity: true,
        variantGroupId: true,
        variantIndex: true,
        variantType: true,
      },
      orderBy: { complexity: 'asc' },
      take: maxCandidates,
    }),
    prisma.cardProgress.findMany({
      where: {
        userId,
        suppressed: false,
        flagged: false,
        status: { notIn: ['retired'] },
        card: {
          rotation,
          clusterId,
          deletedAt: null,
          shelvedAt: null,
          ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
          ...(options.minComplexity != null
            ? { complexity: { gte: options.minComplexity } }
            : {}),
          NOT: excludedTopicsNot,
        },
      },
      orderBy: [{ retrievalStrength: 'asc' }],
      select: {
        card: {
          select: {
            id: true,
            clusterId: true,
            similarCards: true,
            topics: true,
            sourceFile: true,
            importance: true,
            complexity: true,
            variantGroupId: true,
            variantIndex: true,
            variantType: true,
          },
        },
      },
      take: maxCandidates,
    }),
  ]);

  const combined = [...shuffle(newCards), ...shuffle(weakCards.map((row) => row.card))];
  const seen = new Set<string>();
  const selected: CardCandidate[] = [];

  for (const card of combined) {
    if (selected.length >= maxCandidates) break;
    if (seen.has(card.id)) continue;
    seen.add(card.id);
    if (options.selectedCardIds.has(card.id)) continue;
    selected.push({
      id: card.id,
      clusterId: card.clusterId,
      similarCards: card.similarCards,
      topics: card.topics,
      sourceFile: card.sourceFile,
      importance: card.importance,
      complexity: card.complexity,
      variantGroupId: card.variantGroupId,
      variantIndex: card.variantIndex,
      variantType: card.variantType,
    });
  }

  return selected;
}

async function getUnseenScaffoldsForClusters(
  userId: string,
  rotation: string,
  clusterIds: string[],
  selectedCardIds: Set<string>,
): Promise<CardCandidate[]> {
  if (clusterIds.length === 0) return [];

  const excludedIds = selectedCardIds.size > 0 ? [...selectedCardIds] : undefined;
  return prisma.card.findMany({
    where: {
      rotation,
      clusterId: { in: clusterIds },
      complexity: 1,
      deletedAt: null,
      shelvedAt: null,
      ...(excludedIds ? { id: { notIn: excludedIds } } : {}),
      progress: { none: { userId } },
      NOT: { topics: { hasSome: [...EXCLUDED_TOPICS] } },
    },
    select: {
      id: true,
      clusterId: true,
      similarCards: true,
      topics: true,
      sourceFile: true,
      importance: true,
      complexity: true,
      variantGroupId: true,
      variantIndex: true,
      variantType: true,
    },
    orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
  });
}

async function getQuestionsForRotation(
  userId: string,
  rotation: string,
  limit: number,
  options: {
    selectedQuestionIds: Set<string>;
    selectedQuestionVariantGroups?: Set<string>;
    /**
     * Per-user question exposure. Supply it (with the counter) or this lane will
     * draw mastered and never-seen questions with equal probability — see below.
     */
    questionFamiliarity?: Map<string, QuestionFamiliarity>;
    masteredReentryCounter?: ReentryCounter;
  }
): Promise<Array<{
  id: string;
  topics: string[];
  variantGroupId: string | null;
  variantType: string | null;
}>> {
  if (limit <= 0) return [];

  const excludedIds = options.selectedQuestionIds.size > 0 ? [...options.selectedQuestionIds] : [];
  const globallyExcluded = await getExcludedQuestionIds();
  if (globallyExcluded.size > 0) {
    excludedIds.push(...globallyExcluded);
  }
  const poolSize = Math.max(30, limit * 10);

  const allowPrivateSources = await userIdCanAccessPrivateSources(userId);
  const candidates = await prisma.question.findMany({
    where: withDefaultQuestionServingPolicy(
      withoutRawPublicUsmleQuestions({
        rotation,
        contentState: { not: 'shelved' },
        ...(excludedIds.length > 0 ? { id: { notIn: excludedIds } } : {}),
        NOT: { topics: { hasSome: EXCLUDED_TOPICS } },
      }),
      { allowPrivateSources }
    ),
    select: {
      id: true,
      topics: true,
      variantGroupId: true,
      variantType: true,
      difficulty: true,
      facilityIndex: true,
      totalAttempts: true,
      source: true,
    },
    take: poolSize,
    orderBy: { createdAt: 'desc' },
  });

  const candidatesAfterSessionVariantFilter = options.selectedQuestionVariantGroups
    ? candidates.filter((q) => {
        const key = questionSuppressionKey(q);
        return !key || !options.selectedQuestionVariantGroups!.has(key);
      })
    : candidates;

  // Gate mastered questions BEFORE selection. selectVariantAwareQuestions is
  // never-answered-first only WITHIN a variant group: solo questions are keyed
  // `__single:${id}` (question-variants.ts:55) so that filter is vacuous for them,
  // and the cross-group pick is `shuffle(selected)` (:97). So it is NOT
  // freshness-first across the pool — an earlier comment here claimed it was, and
  // that was the stated basis for leaving this lane ungated. With mastery no longer
  // excluded upstream, that would draw mastered and fresh with equal probability and,
  // once fresh candidates run out, hand back a whole session of mastered questions —
  // the flood the cap exists to prevent.
  const familiarity = options.questionFamiliarity;
  const counter = options.masteredReentryCounter;
  const admitted = familiarity && counter
    ? admitMasteredWithinBudget(
        candidatesAfterSessionVariantFilter,
        (q) => q.id,
        familiarity,
        limit,
        resolveRetirementPolicy(),
        counter,
      )
    : candidatesAfterSessionVariantFilter;

  const selected = await selectVariantAwareQuestions(
    admitted,
    userId,
    limit,
    48,
    familiarity,
  );
  if (familiarity && counter) {
    // Increment on what was actually SERVED, not what was admitted.
    counter.masteredServed += countMastered(selected, (q) => q.id, familiarity);
  }
  for (const q of selected) {
    options.selectedQuestionIds.add(q.id);
    const key = questionSuppressionKey(q);
    if (key) options.selectedQuestionVariantGroups?.add(key);
  }

  return selected.map((q) => ({
    id: q.id,
    topics: q.topics,
    variantGroupId: q.variantGroupId,
    variantType: q.variantType,
  }));
}

// =============================================================================
// Diagnostic Functions
// =============================================================================

/**
 * Get a diagnostic view of concept states for a rotation
 * Useful for understanding why certain items are being recommended
 */
export async function getConceptDiagnostics(
  userId: string,
  rotation: string,
  options: { week?: number; limit?: number } = {}
): Promise<ConceptState[]> {
  const { week, limit = 20 } = options;

  const examDate = await getExamDateForUser(rotation, userId);
  const daysToExam = examDate
    ? Math.max(0, (examDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 45;

  const concepts = await prisma.concept.findMany({
    where: {
      rotation,
      ...(week !== undefined ? { week } : {}),
    },
    select: { id: true, name: true, week: true, examWeight: true },
  });

  const conceptIds = concepts.map((c) => c.id);
  const stateRecords = await prisma.conceptState.findMany({
    where: { userId, conceptId: { in: conceptIds } },
  });
  const stateMap = new Map(stateRecords.map((s) => [s.conceptId, s]));

  const now = new Date();
  const states: ConceptState[] = concepts.map((concept) => {
    const state = stateMap.get(concept.id);
    const daysSinceProbe = state?.lastProbeAt
      ? (now.getTime() - state.lastProbeAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    const daysSinceExposure = state?.lastExposureAt
      ? (now.getTime() - state.lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    const storedRecall = state?.recallProbability ?? 0;
    const confidence = state?.confidence ?? 0;
    const exposureCount = state?.exposureCount ?? 0;

    const currentRecall =
      daysSinceExposure < Infinity
        ? applyDecay(storedRecall, daysSinceExposure, confidence)
        : 0;
    // True exam-day recall — the SEMANTIC value. Hub-readiness gating, prereq
    // gates, the difficulty ladder, diagnostics, and the returned state all read
    // this, so it must stay uncapped or those behaviours silently shift.
    const recallOnExamDay = projectRecallToExamDay(currentRecall, daysToExam, confidence);
    // RANKING recall: the same projection horizon-capped so priority stays
    // discriminating far from exam, where the true exam-day recall collapses to
    // ~0 for every concept (examPressure carries exam urgency separately). Used
    // ONLY for the priority gap below — never as recallOnExamDay's substitute
    // (BACKLOG #9 / adversarial review: capping it everywhere changed
    // hub-readiness, not just the sort).
    const rankingRecall = projectRecallToExamDay(currentRecall, daysToExam, confidence, RECALL_RANKING_HORIZON_DAYS);

    let intervention: 'probe' | 'remediate' | 'reinforce';
    if (confidence < DEFAULTS.confidenceThreshold || exposureCount < 3) {
      intervention = 'probe';
    } else if (recallOnExamDay < DEFAULTS.recallThreshold) {
      intervention = 'remediate';
    } else if (daysSinceProbe > DEFAULTS.daysSinceProbeThreshold) {
      intervention = 'probe';
    } else {
      intervention = 'reinforce';
    }

    const gapScore = Math.max(0, DEFAULTS.targetRecall - rankingRecall);
    const confidenceBoost = confidence < DEFAULTS.confidenceThreshold ? 0.2 : 0;
    const staleBoost = daysSinceProbe > DEFAULTS.daysSinceProbeThreshold ? 0.1 : 0;
    const examWeightMultiplier = (concept.examWeight || 1) / 3;
    const priority = (gapScore + confidenceBoost + staleBoost) * examWeightMultiplier;

    return {
      conceptId: concept.id,
      conceptName: concept.name,
      currentRecall: Math.round(currentRecall * 1000) / 1000,
      recallOnExamDay: Math.round(recallOnExamDay * 1000) / 1000,
      confidence: Math.round(confidence * 1000) / 1000,
      exposureCount,
      daysSinceProbe: Math.round(daysSinceProbe * 10) / 10,
      daysSinceExposure: Math.round(daysSinceExposure * 10) / 10,
      priority: Math.round(priority * 1000) / 1000,
      intervention,
    };
  });

  return states.sort((a, b) => b.priority - a.priority).slice(0, limit);
}


// Re-exported from candidate-ranking.ts for backward compatibility with tests
export { buildDifficultyPlan, normalizeQuestionDifficulty, getEffectiveQuestionDifficulty };
