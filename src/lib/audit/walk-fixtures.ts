/**
 * Test-only fixture builders for walk-audit trajectories.
 * Not used in production code.
 */
import type {
  TrajectoryEvent,
  ResponseEvent,
  Session,
  ServedBy,
  DifficultyTier,
  WalkMetadata,
} from './walk-types';

export function makeTrajectoryEvent(opts: {
  sessionId: string;
  position: number;
  servedBy?: ServedBy;
  sourceId?: string;
  sourceType?: 'card' | 'question' | 'group';
  rotation?: string | null;
  clusterId?: string | null;
  similarityToPrior?: number | null;
  predictedRecall?: number | null;
  difficultyTier?: DifficultyTier | null;
  poolSize?: number;
  variantGroupId?: string | null;
  createdAt?: Date;
}): TrajectoryEvent {
  const metadata: WalkMetadata = {
    sessionId: opts.sessionId,
    positionInSession: opts.position,
    servedBy: opts.servedBy,
    clusterId: opts.clusterId ?? null,
    similarityToPrior: opts.position === 0 ? null : (opts.similarityToPrior ?? null),
    predictedRecall: opts.predictedRecall ?? null,
    difficultyTier: opts.difficultyTier ?? null,
    poolSize: opts.poolSize,
    variantGroupId: opts.variantGroupId ?? null,
  };
  return {
    eventType: 'content_exposed',
    sourceType: opts.sourceType ?? 'card',
    sourceId: opts.sourceId ?? `item-${opts.sessionId}-${opts.position}`,
    createdAt: opts.createdAt ?? new Date('2026-04-18T10:00:00Z'),
    rotation: opts.rotation ?? 'paam',
    metadata,
  };
}

export function makeResponseEvent(opts: {
  sessionId?: string;
  sourceId: string;
  sourceType: 'card' | 'question';
  quality?: number | null;
  isCorrect?: boolean | null;
  createdAt?: Date;
  rotation?: string | null;
}): ResponseEvent {
  return {
    eventType: opts.sourceType === 'card' ? 'card_reviewed' : 'mcq_attempted',
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    createdAt: opts.createdAt ?? new Date('2026-04-18T10:01:00Z'),
    quality: opts.quality ?? null,
    isCorrect: opts.isCorrect ?? null,
    rotation: opts.rotation ?? 'paam',
    metadata: opts.sessionId ? { sessionId: opts.sessionId } : {},
  };
}

export function makeSession(opts: {
  sessionId: string;
  servedBy?: ServedBy;
  userId?: string;
  userLabel?: string;
  rotation?: string | null;
  eventCount: number;
  responses?: ResponseEvent[];
  clusterIds?: Array<string | null>;
  similarities?: Array<number | null>;
  feedMode?: 'mixed' | 'new-only';
  variantGroupIds?: Array<string | null>;
}): Session {
  const trajectory: TrajectoryEvent[] = Array.from({ length: opts.eventCount }, (_, i) =>
    makeTrajectoryEvent({
      sessionId: opts.sessionId,
      position: i,
      servedBy: opts.servedBy,
      rotation: opts.rotation ?? 'paam',
      clusterId: opts.clusterIds?.[i] ?? null,
      similarityToPrior: opts.similarities?.[i] ?? null,
      variantGroupId: opts.variantGroupIds?.[i] ?? null,
    }),
  );
  if (opts.feedMode) {
    for (const t of trajectory) t.metadata.feedMode = opts.feedMode;
  }
  const start = trajectory[0]?.createdAt ?? new Date();
  const end = trajectory[trajectory.length - 1]?.createdAt ?? new Date();
  return {
    sessionId: opts.sessionId,
    userId: opts.userId ?? 'user-1',
    userLabel: opts.userLabel ?? 'user-1',
    rotation: opts.rotation ?? 'paam',
    startedAt: start,
    endedAt: end,
    trajectory,
    responses: opts.responses ?? [],
    feedMode: opts.feedMode ?? 'mixed',
  };
}
