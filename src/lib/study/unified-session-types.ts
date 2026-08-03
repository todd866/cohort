import type { LoadedRotationContent } from '@/lib/study/rotation-content-map';
import type { CommitmentLevel } from '@/lib/commitment';
import type { ClientImageMeta } from '@/lib/figures/types';
import type { ReviewFilter } from '@/lib/review/review-intent';

export interface UnifiedItem {
  type: 'card' | 'question' | 'group' | 'video';
  id: string;
  // Card fields
  front?: string;
  back?: string;
  backs?: string[] | null;
  context?: string | null;
  sourceComponent?: string;
  crosslinks?: {
    primary?: string;
    related?: string[];
    concepts?: string[];
  } | null;
  // Question fields
  stem?: string;
  options?: Array<{ label: string; text: string; isCorrect?: boolean; originalIndex?: number; explanation?: string }>;
  explanation?: string | null; // Preloaded for instant feedback
  imageUrl?: string | null;
  /** Always-visible teaching caption (names the finding, tells the student
   *  where to look). Required when imageUrl is set — the harness rule.
   *  See feedback_image_quality_floor + feedback_pedagogy_harness memories. */
  imageCaption?: string | null;
  /** Stable R2 key (or passthrough URL for non-/figures/ images). Set by resolveImage. */
  imageKey?: string | null;
  /** Client-safe sidecar metadata. Set by resolveImage. */
  imageMeta?: ClientImageMeta;
  // Group fields (linked question groups - ECG, ABG, etc.)
  groupType?: string;
  contextImageUrl?: string | null;
  contextText?: string | null;
  steps?: unknown[];
  diagnosisSummary?: string | null;
  difficulty?: string;
  topics?: string[];
  // Video fields
  videoTitle?: string;
  /** Short-lived private delivery URL. Added only at final API egress. */
  videoUrl?: string;
  videoThumbnailUrl?: string | null;
  videoDuration?: number;
  /** Server/cache-only stable key. Must be stripped before API delivery. */
  videoR2Key?: string;
  creatorName?: string;
  // Shared
  rotation: string;
  week: number | null;
  liked?: boolean;
  flagged?: boolean;
  clusterId?: string | null;
  priority?: number;
  complexity?: number;
  // Cloze variant fields (2026-05-08): siblings share variantGroupId.
  // See docs/superpowers/specs/2026-05-08-cloze-variants-design.md
  variantGroupId?: string | null;
  variantIndex?: number | null;
  variantType?: string | null;
  // Concept scheduler fields
  conceptName?: string;
  /** Concept the scheduler picked this item from. Populated by hydration
   *  from UnifiedSessionItem.conceptId. Threaded through to ServeDecision
   *  so per-concept analytics (teaching cap respected? naive pre-teach
   *  firing? failure escalation working?) are computable. */
  conceptId?: string;
  interventionReason?:
    | 'low_confidence'
    | 'weak_recall'
    | 'needs_retest'
    | 'reinforcement'
    | 'stuck_intervention'
    | 'pre_teach'
    | 'pre_teach_naive'
    | 'chronic_stuck_mcq'
    | 'mcq_bridge_card'
    | 'preemptive_scaffold'
    // Set when the concept was boosted by D failure-escalation (+0.25 on
    // concepts the user graded q<3 in the last 2h). Overrides the
    // teaching-state label so analytics can see when D drives a serve.
    | 'failure_escalation'
    // Set when the concept was un-starved by E (strong but still has unseen
    // cards — recallOnExamDay ≥ targetRecall AND conceptHasPristine).
    // Without this label, strong-pristine serves are indistinguishable
    // from regular reinforcement in analytics.
    | 'strong_pristine';
  /** Teaching signal ID for prediction/outcome tracking */
  signalId?: string;
  /** ServeDecision row id; threaded through cache JSON and echoed back on /record. */
  serveDecisionId?: string;
  /** Decision context for scheduler observability */
  decisionContext?: Record<string, unknown>;
  // Walk decision context (Phase 1 of scheduler-walk-audit)
  // Set by the session-construction path that produced this item.
  //
  // Narrowing note: intentionally narrower than DecisionContext.servedBy, which
  // includes 'feed-score' | 'weekly-review' | 'content-page'. Session paths
  // produce only 5 of the 8 variants — those are the only values valid here.
  servedBy?: 'manifold-walk' | 'starter' | 'cached' | 'instant' | 'rereview' | 'focused';
  /** Pre-serve item outcome proxy; not validated item correctness. */
  predictedRecall?: number | null;
  predictedRecallModel?: string | null;
  predictedRecallSource?: 'empirical' | 'fallback' | null;
  predictedRecallStatus?: 'telemetry-only-unvalidated' | null;
  difficultyTier?: 'scaffolding' | 'standard' | 'stretch' | null;
  poolSize?: number;
  // Populated by enrichItemsWithWalkMetadata just before emission:
  positionInSession?: number;
  similarityToPrior?: number | null;
  // Embedding is used for similarityToPrior computation; typically already loaded
  // by the scheduler. Optional — if null, similarityToPrior will be null.
  embedding?: number[] | null;
}

export type InstantQuestionCandidate = {
  id: string;
  stem: string;
  imageUrl?: string | null;
  rotation: string;
  week: number | null;
  difficulty: string;
  context: string | null;
  topics: string[];
  options: unknown;
  variantGroupId?: string | null;
  variantType?: string | null;
  combinations?: unknown;
  correctVariants?: unknown;
};

/** Counts surfaced when feedMode is active so the UI can show "X new remaining". */
export interface NewRemainingCounts {
  cards: number;
  questions: number;
}

export const DEFAULT_BATCH_SIZE = 50;
export const MAX_BATCH_SIZE = 100;

/** Shared context passed from the orchestrator to each session path. */
export interface SessionContext {
  rotation: string;
  batchSize: number;
  weekFilter: number | null;
  sessionId: string;
  batchId: string;
  typeFilter: string | null;
  difficultyFilter: string | null;
  topicsFilter: string | null;
  modulesFilter: string | null;
  mode: 'crunch' | 'rereview' | undefined;
  /** Explicit root review intent. due/at-risk use the filtered-card lane. */
  reviewFilter?: ReviewFilter;
  /** When 'new-only', restrict to items the user has never queued/answered. */
  feedMode?: 'new-only';
  clientExcludeCards: string[];
  clientExcludeQuestions: string[];
  clientExcludeCardSet: Set<string>;
  clientExcludeQuestionSet: Set<string>;
  hasClientExclusions: boolean;
  hasFilters: boolean;
  noCache: boolean;
  rotationContent: LoadedRotationContent;
  userId: string;
  isGuest: boolean;
  /** Copyright image tier — gates image-as-prompt cards (S1) to trusted users. */
  imageTier: 'standard' | 'copyright';
  anonymousSessionId: string | undefined;
  t0: number;
  tAuthEnd: number;
  commitmentLevel: CommitmentLevel;
}
