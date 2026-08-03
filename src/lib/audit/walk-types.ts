/**
 * Types for Phase 2 scheduler walk-audit analysis.
 * See docs/designs/2026-04-17-scheduler-walk-audit.md.
 */

export type ServedBy =
  | 'manifold-walk'
  | 'starter'
  | 'cached'
  | 'instant'
  | 'rereview'
  | 'focused';

export type DifficultyTier = 'scaffolding' | 'standard' | 'stretch';

/**
 * Session-level feed mode. Drives audit pathology gating: 'new-only' sessions
 * are pool-constrained (only never-seen items, often within a single concept
 * the user is exploring), so several pathologies that assume mixed-feed
 * variety are intentionally suppressed for these sessions.
 */
export type FeedMode = 'mixed' | 'new-only';

export interface WalkMetadata {
  sessionId: string;
  batchId?: string;
  positionInSession: number;
  servedBy?: ServedBy;
  clusterId?: string | null;
  similarityToPrior: number | null;
  predictedRecall?: number | null;
  difficultyTier?: DifficultyTier | null;
  poolSize?: number;
  feedMode?: FeedMode;
  /**
   * Cloze-variant group id (2026-05-08). Cards split from a single multi-blank
   * source share a `variantGroupId`. The unified scheduler suppresses sibling
   * duplicates in a session, so any session with two same-`variantGroupId`
   * cards is a regression — flagged as `variant-sibling-repeat`.
   * Optional: older events (pre-2026-05-08) lack the field.
   */
  variantGroupId?: string | null;
}

export interface TrajectoryEvent {
  eventType: 'content_exposed';
  sourceType: 'card' | 'question' | 'group';
  sourceId: string;
  createdAt: Date;
  rotation: string | null;
  metadata: WalkMetadata;
}

export interface ResponseEvent {
  eventType: 'card_reviewed' | 'mcq_attempted';
  sourceType: 'card' | 'question';
  sourceId: string;
  createdAt: Date;
  quality: number | null;
  isCorrect: boolean | null;
  rotation: string | null;
  metadata: { sessionId?: string; batchId?: string } & Record<string, unknown>;
}

export interface Session {
  sessionId: string;
  userId: string;
  userLabel: string;
  rotation: string | null;
  startedAt: Date;
  endedAt: Date;
  trajectory: TrajectoryEvent[];
  responses: ResponseEvent[];
  /**
   * Inferred from trajectory metadata. 'new-only' if any item carries
   * `feedMode='new-only'` (a session can't be partially new-only — the flag
   * is set at session-start). Defaults to 'mixed' when no item is tagged
   * (older events or paths that don't yet emit the field).
   */
  feedMode: FeedMode;
}

export interface SessionMetrics {
  itemCount: number;
  accuracy: number | null;
  avgSimilarityConsecutive: number | null;
  similarityStddev: number | null;
  clustersVisited: number;
  clustersToItemsRatio: number;
  maxConsecutiveSameCluster: number;
  avgPredictedRecall: number | null;
  difficultyMix: Record<'scaffolding' | 'standard' | 'stretch' | 'unknown', number>;
  scaffoldingRateAfterMiss: number | null;
  postMissDifficultyDelta: number | null;
  timeToFirstCorrectMs: number | null;
}

export interface Pathology {
  kind:
    | 'stuck-in-cluster'
    | 'thrashing'
    | 'over-tight'
    | 'no-scaffolding-on-fail'
    | 'calibration-too-easy'
    | 'calibration-too-hard'
    | 'modality-monotony'
    | 'dropout'
    | 'variant-sibling-repeat';
  severity: 'warn' | 'critical';
  detail: string;
}

export interface RollupMetrics {
  sessionCount: number;
  itemCount: number;
  avgCoherence: number | null;
  clusterCoverage: number;
  topServedClusters: Array<{ clusterId: string; count: number; pct: number }>;
  pathologyCounts: Record<Pathology['kind'], number>;
  /** Breakdown of sessions by feed mode (sums to sessionCount). */
  feedModeCounts: Record<FeedMode, number>;
}

export interface WalkAuditReport {
  window: { days: number; from: Date; to: Date };
  userLabel: string | 'all';
  sessions: Array<{
    session: Session;
    metrics: SessionMetrics;
    pathologies: Pathology[];
  }>;
  rollup: RollupMetrics;
}
