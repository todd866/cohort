/**
 * Unified scheduler: types
 *
 * Session option, item, result and exam-target trace types, plus the two small
 * helpers that sat under the same banner (parseSimilarLinks and
 * conceptThreadPolicyReceipt). Moved out of unified-scheduler.ts unchanged;
 * that module re-exports the public names, so importers need no edits.
 */

import type { QuestionVariantSelectionDeterminism } from '@/lib/question-variants';
import { CONCEPT_THREAD_POLICY_VERSION } from './concept-thread-policy';
import type { CommitmentLevel } from '@/lib/commitment';
import type { RecentQuestionFailureSnapshot } from './scheduler-attribution';
import type { RuntimeExamTargetContext } from '@/lib/exam-target/repository.server';
import type { ServeConditioning } from '@/lib/review/serve-conditioning';
import type { ExamTargetWorkload } from '@/lib/exam-target/workload';
import type { ExamTargetMasteryStage } from '@/lib/exam-target/mastery';
import type { UnifiedSchedulerSharedReadContext } from './unified-scheduler-shared-reads';
import type { ReviewChallengeLevel } from '@/lib/study/review-challenge';

// =============================================================================
// Types
// =============================================================================

type SimilarLink = { cardId: string; similarity: number };

export function parseSimilarLinks(value: unknown): SimilarLink[] {
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
    // The probe lane: one card per topic per day at the rung that best locates
    // the learner. Registered ahead of wiring so serve-concentration budgets it
    // from day one (an unrecognised lane gets the default budget).
    | 'topic_probe'
    // Concept-boost labels (D failure-escalation, E strong-pristine).
    // Resolved by resolveInterventionReason at picking time so analytics
    // can observe when these boosts drove a serve. Kept in sync with the
    // unions in unified-session-types.ts and teaching-dynamics.ts.
    | 'failure_escalation'
    | 'strong_pristine'
    // A successful response opened a mature, same-condition,
    // different-clinical-facet follow-up (for example cause -> presentation).
    | 'concept_followup'
    // A scaffold for a statement missed in an exam-only module, admitted at
    // the session boundary (statement-scaffold-delivery.ts), never by the walk.
    | 'statement_scaffold';
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
  /** Self-rating reliability context for the grade conditioner: the learner's
   *  precomputed verdict plus this card's neighbourhood evidence. Built here in
   *  the background, carried on the ServeDecision payload, read back at grade
   *  time so nothing on the grade path touches history. Cards only. */
  conditioning?: ServeConditioning;
  /** Shadow substitute for a due card last answered correctly. Does not change `id`. */
  repetitionSlot?: import('@/lib/study/repetition-slot-shadow').RepetitionSlotShadow;
  /** Version/source carried into ServeDecision and labeled outcome telemetry. */
  predictedRecallModel?: string;
  predictedRecallSource?: 'empirical' | 'fallback';
  predictedRecallStatus?: 'telemetry-only-unvalidated';
  /** Actual authored/effective challenge rung at selection time. */
  difficultyTier?: 'scaffolding' | 'standard' | 'stretch' | null;
  /** Descriptive fit between decayed concept recall and the delivered rung. */
  challengePolicyVersion?: string;
  challengeTargetTier?: 'scaffolding' | 'standard' | 'stretch';
  challengeDistance?: number;
  /** True for the card ladder; false means a shadow observation for MCQs. */
  challengePolicyApplied?: boolean;
  /** Cross-session semantic-repeat telemetry for discretionary unseen cards. */
  noveltyPolicyVersion?: string;
  recentNeighborSimilarity?: number | null;
  noveltyPenalty?: number;
  /** Never-reviewed card or never-delivered/answered question at selection. */
  firstSightAtSelection?: boolean;
  /** Same-condition, different-facet progression selected after a cadence gap. */
  conceptThreadPolicyVersion?: string;
  conceptThreadPolicyApplied?: boolean;
  conceptThreadAnchorEventId?: string | null;
  conceptThreadAnchorItemId?: string | null;
  conceptThreadAnchorFacet?: string | null;
  conceptThreadTargetFacet?: string | null;
  conceptThreadSharedTopic?: string | null;
  conceptThreadAgeMs?: number | null;
  conceptThreadInterveningExposures?: number | null;
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
  /** Server-only curriculum stage used to preserve the mastery-first queue. */
  examTargetMasteryStage?: ExamTargetMasteryStage;
  /** Server-only stable fact/application identity; never source text. */
  examTargetMasteryUnitId?: string;
}

export function conceptThreadPolicyReceipt(): Pick<
  UnifiedSessionItem,
  'conceptThreadPolicyVersion' | 'conceptThreadPolicyApplied'
> {
  return {
    conceptThreadPolicyVersion: CONCEPT_THREAD_POLICY_VERSION,
    conceptThreadPolicyApplied: false,
  };
}

export type SessionMode = 'normal' | 'crunch' | 'rereview';

export type UnifiedSessionSelectionDeterminism = QuestionVariantSelectionDeterminism;

export interface UnifiedSessionOptions {
  /** Learner-controlled challenge preference for discretionary material. */
  reviewChallenge?: ReviewChallengeLevel;
  rotation: string;
  /** Server-resolved immutable target activation; never accepted from a client. */
  examTarget?: RuntimeExamTargetContext;
  /** Server-authorized source partitions; mapping mode controls target membership. */
  crossSourceRotations?: readonly string[];
  /** Per-session ceiling for items drawn from those sources. */
  maxCrossSourceItems?: number;
  /** Adjacent = target-mapped only; open = entitled source without mapping. */
  crossSourceMappingMode?: 'adjacent' | 'open';
  /**
   * One manifold cluster, from a square on the profile heatmap. A hard
   * promise, not a preference: it narrows the candidate QUERIES rather than
   * filtering their results, so a scoped session is cheaper than an unscoped
   * one instead of far more expensive. Cards only — questions have no cluster.
   */
  clusterFilter?: string | null;
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
  /** Minimum first-sight cards/questions to preserve in the discretionary batch. */
  minFirstSightItems?: number;
  /** Whether to include video "pre-teach" items for weak concepts. Default false. */
  includeVideos?: boolean;
  /** Recent topic exposures (from LearningEvents) for cross-session topic cooldown. */
  recentTopicExposures?: Map<string, { count: number; mostRecentMs: number }>;
  /** Exact cards delivered recently, used only as semantic-neighbour anchors. */
  recentCardIds?: ReadonlySet<string>;
  /** Recent cluster exposures (from LearningEvents) for inter-session cluster dampening. */
  recentClusterExposures?: Map<string, number>;
  /** Commitment level for difficulty rhythm modulation. Default 'browser'. */
  commitmentLevel?: CommitmentLevel;
  /** Copyright image tier — when 'copyright', image-as-prompt cards are eligible (S1). */
  imageTier?: 'standard' | 'copyright';
  /**
   * AU/US practice locale for discrepancy twins. Defaults to AU when omitted.
   * See docs/superpowers/specs/2026-08-10-au-us-practice-locale-twins-design.md
   */
  practiceLocale?: 'au' | 'us';
  /**
   * Teaching week the student's course is currently in, so not-yet-taught
   * material sinks. Supplied by the caller: resolving it needs the student's
   * track and their institution's block calendar, neither of which this
   * module can see. Omit for "no signal" — the boost is then inert.
   */
  currentTeachingWeek?: number | null;
  /**
   * Topic slug → the teaching week that introduces it, for this rotation.
   * Supplied by the same caller and for the same reason as
   * `currentTeachingWeek`: a map of neutral strings to numbers crosses this
   * boundary, the institution's timetable does not. Omit for "no signal".
   */
  topicTeachingWeeks?: ReadonlyMap<string, number>;
  /**
   * Figure URL → how often this user has been shown it, and when. Drives the
   * expanding figure-spacing interval so the same picture does not reappear
   * every day. Omit for "no signal" — the boost is then inert.
   */
  recentFigureExposures?: ReadonlyMap<string, { count: number; mostRecentMs: number }>;
  /** Background-only replacement for the legacy question-failure read. */
  recentQuestionFailures?: RecentQuestionFailureSnapshot;
  /** Seats already reserved by protected lanes outside this selector. */
  protectedSeatCount?: number | null;
  /** Protected seats known to satisfy the current target. Unknown earns no credit. */
  protectedTargetSeatCount?: number | null;
  /** Gross request size when `size` has already had protected seats removed. */
  requestedBatchSize?: number;
  /** Privacy-safe digest used to make paired control/treatment jitter exact. */
  examTargetTieBreakSeed?: string;
  /**
   * Request-frozen clock/entropy for paired membership and ordering. This does
   * not freeze DB reads, so it is not an exact replay contract.
   */
  selectionDeterminism?: UnifiedSessionSelectionDeterminism;
  /**
   * Server-only paired counterfactual marker. It may compile a prospective
   * policy for a shadow-authority target, but the caller must serve control.
   */
  examTargetEvaluationOnly?: boolean;
  /** Suppresses duplicate authoring-gap writes during a paired shadow pass. */
  suppressSchedulerSideEffects?: boolean;
  /**
   * Request-scoped single-flight reads for paired control/treatment evaluation.
   * This bounded phase ends after mastery evidence. Selection-dependent top-up,
   * struggle-intervention and final item-embedding reads remain per branch.
   */
  sharedReadContext?: UnifiedSchedulerSharedReadContext;
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
  examTargetComputed?: boolean;
  examTargetApplied?: boolean;
  examTargetVersion?: string | null;
  examTargetBypassReason?: string | null;
  examTargetCoreSeatsRequired?: number;
  examTargetCoreSeatsSelected?: number;
  examTargetCoreSeatShortfall?: number;
  examTargetSurplusSeats?: number;
  examTargetRemainingWork?: number | null;
  examTargetWorkloadShortfall?: number | null;
}

export interface ScheduledExamTargetItemTrace {
  targetDomainCode: string;
  sourceRotation: string;
  embeddingHash: string;
  examRelevancePct: number | null;
  examDomainWeight: number;
  userDomainGap: number;
  contentTargetScore: number;
  personalizedTargetScore: number;
  targetWeightProvenance: string;
}

export interface ScheduledExamTargetCandidateTrace {
  itemKey: string;
  sourceRotation: string;
  baseRank: number;
  targetEligible: boolean;
  targetDomainCode: string | null;
  embeddingHash: string | null;
  examRelevancePct: number | null;
  examDomainWeight: number | null;
  userDomainGap: number | null;
  contentTargetScore: number | null;
  personalizedTargetScore: number | null;
  targetWeightProvenance: string | null;
}

export interface UnifiedSessionExamTargetDecision {
  targetSnapshotId: string;
  targetVersion: string;
  targetBasis: string;
  targetScorerVersion: string;
  schedulerVersion: string;
  policyDigest: string;
  activationRevision: number;
  mode: 'shadow' | 'active';
  assignment: 'control' | 'treatment';
  applied: boolean;
  bypassReason: string | null;
  maxItemRankMove: number;
  unmappedDomainCodes: string[];
  masteryPolicyVersion: string | null;
  workload: ExamTargetWorkload | null;
  coreTargetSeatsSelected: number;
  coreTargetSeatShortfall: number;
  surplusTargetSeatsSelected?: number;
  allocationChangedConceptMembershipCount?: number;
  allocationCoverageDebtDomainCodes?: string[];
  /** Total-variation error for target-treated discretionary output. */
  targetAllocationError?: number | null;
  evaluationOnly?: boolean;
  /** Privacy-safe count; null distinguishes an unavailable mastery ledger. */
  curriculumCoverageDebtCount?: number | null;
  masteryLoadWarnings: string[];
  daysToExam: number;
  pressureBucket: 'far' | 'building' | 'near' | 'crunch';
  learnerStateVersion: string;
  candidatePool: readonly ScheduledExamTargetCandidateTrace[];
  itemTraces: Readonly<Record<string, ScheduledExamTargetItemTrace>>;
}

export interface UnifiedSessionResult {
  items: UnifiedSessionItem[];
  stats: SessionStats;
  noveltyQuota?: { required: number; selected: number };
  /** Server-only scalar provenance consumed by hydration/decision telemetry. */
  examTargetDecision?: UnifiedSessionExamTargetDecision;
  /** In-memory shadow context for due cards pinned after this build. */
  repetitionSlotContext?: import('@/lib/study/repetition-slot-shadow').RepetitionSlotContext | null;
}
