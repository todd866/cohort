import type { LoadedRotationContent } from '@/lib/study/rotation-content-map';
import type { CommitmentLevel } from '@/lib/commitment';
import type { ClientImageMeta, ResolvedImageAlternative } from '@/lib/figures/types';
import type { ReviewFilter } from '@/lib/review/review-intent';
import type { ServeConditioning } from '@/lib/review/serve-conditioning';
import type { RuntimeExamTargetContext } from '@/lib/exam-target/repository.server';
import type { ExamTargetAttemptDecisionPath } from '@/lib/exam-target/attempt-ledger.server';

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
  /** Reveal-gated teaching caption (names the finding, tells the student
   *  where to look). Required when imageUrl is set — the harness rule.
   *  See feedback_image_quality_floor + feedback_pedagogy_harness memories. */
  imageCaption?: string | null;
  /** 'prompt' means the image is required to answer and the item must fail closed. */
  imageRole?: string | null;
  /** Stable R2 key (or passthrough URL for non-/figures/ images). Set by resolveImage. */
  imageKey?: string | null;
  /** Client-safe sidecar metadata. Set by resolveImage. */
  imageMeta?: ClientImageMeta;
  /** Eligible after-reveal choices; the original primary fields remain intact. */
  imageAlternatives?: ResolvedImageAlternative[];
  // Operative video clip
  /** Resolved and signed by `resolveClipsForSession`. Null when the rights or
   *  tier gate withheld it — a `clipRole: 'prompt'` item with a null clip is
   *  dropped during hydration rather than served. */
  clip?: import('@/components/review/clip-role').ClipPromptData | null;
  /** 'prompt' means the clip is required to answer and the item must fail closed. */
  clipRole?: 'prompt' | null;
  /** Says where to look without saying what is there. Shown pre-reveal. */
  clipCaption?: string | null;
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
    | 'topic_probe'
    // A mature prior correct answer on the same specific clinical topic is
    // being revisited through a different facet (for example cause ->
    // presentation). The policy provenance below makes this auditable.
    | 'concept_followup'
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
  /**
   * Opaque public Step 1 delivery id. When set, Review grades through
   * `/api/usmle/step1/answer` and must not treat `id` as a raw question id.
   */
  deliveryId?: string;
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
  /** Grade-conditioner context built at serve time; carried on the
   *  ServeDecision payload and read back at grade time. Cards only. */
  conditioning?: ServeConditioning | null;
  predictedRecallModel?: string | null;
  predictedRecallSource?: 'empirical' | 'fallback' | null;
  predictedRecallStatus?: 'telemetry-only-unvalidated' | null;
  difficultyTier?: 'scaffolding' | 'standard' | 'stretch' | null;
  challengePolicyVersion?: string | null;
  challengeTargetTier?: 'scaffolding' | 'standard' | 'stretch' | null;
  challengeDistance?: number | null;
  challengePolicyApplied?: boolean | null;
  noveltyPolicyVersion?: string | null;
  recentNeighborSimilarity?: number | null;
  noveltyPenalty?: number | null;
  /** Cross-session same-topic/different-facet follow-up telemetry. */
  conceptThreadPolicyVersion?: string | null;
  conceptThreadPolicyApplied?: boolean | null;
  conceptThreadAnchorEventId?: string | null;
  conceptThreadAnchorItemId?: string | null;
  conceptThreadAnchorFacet?: string | null;
  conceptThreadTargetFacet?: string | null;
  conceptThreadSharedTopic?: string | null;
  conceptThreadAgeMs?: number | null;
  conceptThreadInterveningExposures?: number | null;
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
  imageCaption?: string | null;
  imageRole?: string | null;
  rotation: string;
  week: number | null;
  difficulty: string;
  questionType: string;
  format: string | null;
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
  /** Product surface resolved from the exact request host, never from rotation. */
  publicSurface?: 'cohort' | 'usmle-step1';
  /** Server-resolved, fail-closed exam-target activation for this request. */
  examTarget?: RuntimeExamTargetContext;
  /** Frozen identity returned by the pre-compute target-attempt admission gate. */
  examTargetAttempt?: Readonly<{
    id: string;
    decisionPath: ExamTargetAttemptDecisionPath;
  }>;
  /**
   * Server-authorized source partitions whose individual items may support the
   * current exam when their moduleNodes include `rotation`.
   */
  crossSourceRotations?: readonly string[];
  /**
   * Dessert seat budget for entitled other-source items in this request.
   * Omitted or 0 keeps the feed native-only.
   */
  maxCrossSourceItems?: number;
  /**
   * `adjacent` requires target moduleNodes; `open` also admits unmapped
   * entitled source cards once the dessert explore budget opens.
   */
  crossSourceMappingMode?: 'adjacent' | 'open';
  /**
   * Teaching week the student's course is in, or null for no signal. Derived
   * server-side from the authenticated user's track; drives curriculumPacingBoost.
   */
  currentTeachingWeek?: number | null;
  /**
   * Topic slug → the teaching week that introduces it, for this rotation.
   * Built server-side from the curriculum definition; drives the
   * teaching-cadence boost that floats what the course is lecturing on now.
   */
  topicTeachingWeeks?: ReadonlyMap<string, number>;
  /**
   * Figure URL → this user's showings of it, feeding the expanding
   * figure-spacing interval so one picture does not recur every day.
   */
  recentFigureExposures?: ReadonlyMap<string, { count: number; mostRecentMs: number }>;
  batchSize: number;
  weekFilter: number | null;
  sessionId: string;
  batchId: string;
  typeFilter: string | null;
  difficultyFilter: string | null;
  topicsFilter: string | null;
  /**
   * A manifold cluster to narrow the session to — set when the learner clicks
   * a square on the profile knowledge heatmap. Validated at the route edge
   * against the same id shape parseReviewIntent accepts. Optional because
   * absence is the overwhelmingly common case and every reader treats a
   * missing value exactly as it treats null.
   */
  clusterFilter?: string | null;
  modulesFilter: string | null;
  /** Raw validated mode before feed/filter precedence clears scheduler hints. */
  requestedMode?: 'crunch' | 'rereview';
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
  /** AU/US practice locale for discrepancy twins (default AU). */
  practiceLocale: 'au' | 'us';
  anonymousSessionId: string | undefined;
  t0: number;
  tAuthEnd: number;
  /**
   * How long `getRotationContent` took inside this request. The per-rotation
   * content map is a multi-MB generated module, dynamically imported once per
   * instance — a fresh instance pays seconds here. Reported as its own
   * `contentmap;dur` Server-Timing segment; before this existed the parse was
   * billed inside `auth;dur` (tAuthEnd was captured after the import) and
   * cold-instance content-map cost masqueraded as slow auth.
   */
  tContentMapMs: number;
  /**
   * How long `requireAuthOrGuest` took — the request's FIRST database touch,
   * and therefore where Neon connection acquisition is paid. Carved out of
   * `tAuthEnd - t0` because that span covers ~300 lines and several queries:
   * a 99s authMs alone cannot tell a stalled connection from a slow
   * entitlement gate, which is exactly the ambiguity that left the 2026-08-22
   * 107.9s cache HIT unattributable.
   */
  tIdentityMs: number;
  commitmentLevel: CommitmentLevel;
}
