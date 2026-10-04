/**
 * Unified scheduler: types shared by the phase modules
 *
 * constructUnifiedSessionImpl builds one session in phases. The phases used to
 * share local variables; they now share three objects with a clear owner each:
 *
 *   SchedulerInputs      read-only. Everything phases 1 to 3 settle: the request,
 *                        the exam horizon, the exclusions, the concepts, and every
 *                        read the session needs from the database. Nothing after
 *                        phase 3 may change it.
 *   ConceptPlan          read-only once phase 6 returns. The concept states with
 *                        their priorities, the weak set the session works, and the
 *                        indexes over the candidate pool that selection consults.
 *   SessionBuildState    the one mutable object (unified-scheduler-phase-state.ts):
 *                        the items picked so far, their id sets, counts and budgets.
 *
 * Every field below used to be a local of that function, with the same name and
 * the same value; the types were read off the compiler, not invented.
 */

import type { ConceptState as ConceptStateRecord } from '@prisma/client';

import type { ExamTargetLearnerPolicy } from '@/lib/exam-target/learner-policy';
import type { LoadedExamTargetMasteryEvidence } from '@/lib/exam-target/mastery-evidence.server';
import type {
  LoadedConceptExamTargetScores,
  RuntimeExamTargetContext,
  RuntimeExamTargetSnapshot,
} from '@/lib/exam-target/repository.server';
import type { ExamTargetInfluencePolicy } from '@/lib/exam-target/types';
import type { ExamTargetWorkload } from '@/lib/exam-target/workload';
import type { FlowAxisResult } from '@/lib/manifold/flow-axis';
import type { RatingReliabilityRecord } from '@/lib/review/rating-reliability-record';
import type { BulkCandidates } from './bulk-candidates';
import type { ClinicalThreadAnchor } from './concept-thread-policy';
import type { RecentFormatsByConcept } from './format-history';
import type { BudgetSummary } from './throughput';
import type {
  ConceptState,
  UnifiedSessionOptions,
  UnifiedSessionSelectionDeterminism,
} from './unified-scheduler-types';

/** The columns of a `Concept` row that the scheduler reads. */
export interface SchedulerConcept {
  id: string;
  name: string;
  week: number | null;
  examWeight: number | null;
  prerequisiteIds: string[];
  topics: string[];
}

/** Recent-exposure context the card ranker uses to cool repeated topics and cards. */
export interface SchedulerPenaltyContext {
  recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>;
  recentCardIds: ReadonlySet<string>;
  recentFailureConceptIds?: ReadonlySet<string>;
  nowMs: number;
}

/** Per-card metadata phase 9 copies onto the ordered items; phase 10 reads it again. */
export interface SessionCardMeta {
  stableId: string | null;
  topics: string[];
  complexity: number;
  clusterId: string | null;
  variantGroupId: string | null;
  facilityIndex: number | null;
  sampleSize: number | null;
  similarCards: unknown;
}

/**
 * What phases 1 and 2 settle before any read that depends on the concepts: the
 * request, the clock and seeds, the exam horizon, the exclusions and the concepts.
 * Phase 3 builds the SchedulerInputs from it.
 */
export interface SchedulerSetup {
  readonly userId: string;
  readonly options: UnifiedSessionOptions;
  readonly rotation: string;
  readonly week: number | undefined;
  readonly size: number;
  readonly interferenceThreshold: number;
  readonly includeVideos: boolean;
  readonly selectionDeterminism: UnifiedSessionSelectionDeterminism | null;
  readonly servingRotationSeed: string;
  readonly nowMs: number;
  readonly selectionNowMs: () => number;
  /** Runs a pre-selection read through the request's shared-read context, when it has one. */
  readonly readPreselection: <T>(slot: string, loader: () => Promise<T>) => Promise<T>;
  readonly ratingReliability: RatingReliabilityRecord | null;
  readonly examDate: Date | null;
  readonly concepts: SchedulerConcept[];
  readonly excludedCardIds: Set<string>;
  readonly excludedQuestionIds: Set<string>;
  readonly excludedVideoIds: Set<string>;
  readonly penaltyContext: SchedulerPenaltyContext | undefined;
  readonly recentClusterExposures: Map<string, number> | undefined;
  /** Days to the exam, or null when no date is known. */
  readonly knownDaysToExam: number | null;
  readonly daysToExam: number;
  readonly examPressure: number;
  readonly cardRatio: number;
  /** New (unseen) cards the request allows; Infinity when unbounded, 0 in crunch mode. */
  readonly effectiveMaxNewCards: number;
}

export interface SchedulerInputs {
  // ---- the request ---------------------------------------------------------
  readonly userId: string;
  readonly options: UnifiedSessionOptions;
  readonly rotation: string;
  readonly size: number;
  readonly interferenceThreshold: number;
  readonly includeVideos: boolean;
  readonly selectionDeterminism: UnifiedSessionSelectionDeterminism | null;
  /** Seed for every lane that injects an item chosen from a candidate pool. */
  readonly servingRotationSeed: string;
  /** The selection clock, frozen when the request carries a determinism seed. */
  readonly nowMs: number;
  readonly selectionNowMs: () => number;

  // ---- exam horizon and card/question blend --------------------------------
  /** Days to the exam, 45 when no date is known (ranking pressure and projection). */
  readonly daysToExam: number;
  readonly examPressure: number;
  /** The card ratio before the D_eff maintenance shift of phase 6. */
  readonly cardRatio: number;
  /** New (unseen) cards the request allows; Infinity when unbounded, 0 in crunch mode. */
  readonly effectiveMaxNewCards: number;

  // ---- exclusions ----------------------------------------------------------
  readonly excludedCardIds: Set<string>;
  readonly excludedQuestionIds: Set<string>;
  readonly excludedVideoIds: Set<string>;
  readonly penaltyContext: SchedulerPenaltyContext | undefined;
  readonly recentClusterExposures: Map<string, number> | undefined;

  // ---- concepts ------------------------------------------------------------
  readonly concepts: readonly SchedulerConcept[];
  readonly conceptMap: ReadonlyMap<string, SchedulerConcept>;

  // ---- exam target ---------------------------------------------------------
  readonly runtimeExamTarget: RuntimeExamTargetContext | undefined;
  readonly runtimeTargetSnapshot: RuntimeExamTargetSnapshot | null;
  readonly examTargetEvaluationOnly: boolean;
  readonly effectiveTargetInfluence: ExamTargetInfluencePolicy | null;
  readonly targetComputeRequested: boolean;
  readonly targetSidecarsValid: boolean;
  /** True only for a validated treatment whose allocator is not shadow-only. */
  readonly applyExamTarget: boolean;
  readonly conceptTargetScores: LoadedConceptExamTargetScores;
  readonly observedExamTargetDomainCounts: ReadonlyMap<string, number>;
  readonly masteryEvidence: LoadedExamTargetMasteryEvidence | null;
  /** Units the mastery plan currently allows, by stage. Empty without evidence. */
  readonly eligibleCoreUnitIds: ReadonlySet<string>;
  readonly eligibleAppliedUnitIds: ReadonlySet<string>;
  readonly targetWorkload: ExamTargetWorkload | null;

  // ---- what the learner has done -------------------------------------------
  readonly stateMap: ReadonlyMap<string, ConceptStateRecord>;
  readonly conceptEmbeddings: ReadonlyMap<string, number[]>;
  /** Direction from the learner's knowledge toward the exam target, when both exist. */
  readonly gapDirection: number[] | null;
  readonly likedConceptIds: ReadonlySet<string>;
  readonly chronicFailureConceptIds: ReadonlySet<string>;
  readonly practiceMissConceptIds: ReadonlySet<string>;
  readonly recentFailureConceptIds: Set<string>;
  readonly recentFormatsByConcept: RecentFormatsByConcept;
  readonly conceptThreadAnchors: readonly ClinicalThreadAnchor[];
  readonly ratingReliability: RatingReliabilityRecord | null;
  readonly budget: BudgetSummary;

  // ---- the candidate pool --------------------------------------------------
  readonly bulk: BulkCandidates;
  /** Started in phase 3, awaited by the manifold ordering of phase 9. */
  readonly flowAxisPromise: Promise<FlowAxisResult | null>;
}

/** Phase 4: the concepts ranked by priority, and the indexes over the candidate pool. */
export interface ConceptRanking {
  /** Priority-sorted. Phase 5 jitters the priorities and sorts this array in place. */
  readonly conceptStates: ConceptState[];
  readonly statesById: ReadonlyMap<string, ConceptState>;
  readonly learnerTargetPolicy: ExamTargetLearnerPolicy | null;
  readonly activeCardTargetScores: ReadonlyMap<string, number>;
  readonly activeQuestionTargetScores: ReadonlyMap<string, number>;
  readonly activeTargetRankMove: number;
  readonly getConceptCluster: (concept: ConceptState) => string;

  // ---- indexes over the candidate pool -------------------------------------
  readonly unseenCardIds: ReadonlySet<string>;
  /** New (unseen) cards allowed in the session; Infinity when unbounded. */
  readonly maxNewCards: number;
  readonly cardRotationById: ReadonlyMap<string, string>;
  readonly cardSourceFileById: ReadonlyMap<string, string | null>;
  readonly questionRotationById: ReadonlyMap<string, string>;
  readonly crossSourceCardIds: ReadonlySet<string>;
  readonly crossSourceQuestionIds: ReadonlySet<string>;
  readonly maxCrossSourceItems: number;
  readonly unknownItemRotation: string;
}

/** Phase 6: which concepts the session works, and the card ratio it works them at. */
export interface ConceptSelection {
  /** The concepts the session works, in the order the round-robin takes them. */
  readonly weakConcepts: ConceptState[];
  readonly allocatedConceptRanks: ReadonlyMap<string, number> | null;
  readonly allocationChangedConceptMembershipCount: number;
  readonly allocationCoverageDebtDomainCodes: readonly string[];
  /** The card ratio after the D_eff maintenance shift. */
  readonly cardRatio: number;
}

/** Phase 6, last step: how many cards and questions the session wants. */
export interface CardQuota {
  /** Cards the session wants: the ratio of the plan, raised to cover the exam-target core. */
  readonly targetCardCount: number;
  readonly targetQuestionCount: number;
  /** Card seats the coverage lane (7d) holds for pristine cards of concepts the main loops would not reach. */
  readonly coverageReservation: number;
  /** Cards the weak-concept loop (7c) fills: the card target less the coverage reservation. */
  readonly targetWeakCardCount: number;
}

export interface ConceptPlan extends ConceptRanking, ConceptSelection, CardQuota {
  /** Concepts with at least one unseen card in the candidate pool. */
  readonly conceptHasPristine: Set<string>;
}
