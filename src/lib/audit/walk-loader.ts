import { prisma } from '@/lib/prisma';
import type {
  ContentRatingEvent,
  Session,
  TrajectoryEvent,
  ResponseEvent,
  WalkMetadata,
} from './walk-types';
import { parseConceptThreadMetadata } from './concept-thread-telemetry';

const DAY_MS = 24 * 60 * 60 * 1000;

function comparePosition(left: TrajectoryEvent, right: TrajectoryEvent): number {
  const leftPosition = left.metadata.positionInSession;
  const rightPosition = right.metadata.positionInSession;
  if (Number.isFinite(leftPosition) && Number.isFinite(rightPosition)) {
    return leftPosition - rightPosition;
  }
  // Missing ranks follow known ranks in observed order; mixing a rank comparison
  // with a timestamp comparison for just one side would be non-transitive.
  if (Number.isFinite(leftPosition)) return -1;
  if (Number.isFinite(rightPosition)) return 1;
  return left.createdAt.getTime() - right.createdAt.getTime();
}

/**
 * positionInSession is the rank inside a returned batch, and restarts when a
 * session refills or retries. Sort batches by their first offer time, then keep
 * their own ranks together. These are offered orders, not viewport evidence.
 *
 * Entirely legacy sessions retain the old position ordering. In a mixed stream,
 * missing/null/empty batch IDs do not establish shared identity: only unbatched
 * events with the same timestamp are grouped, at that observed time.
 */
function orderTrajectory(trajectory: TrajectoryEvent[]): TrajectoryEvent[] {
  const batchId = (event: TrajectoryEvent): string | null => {
    const value = event.metadata.batchId;
    return typeof value === 'string' && value.trim() ? value : null;
  };
  if (!trajectory.some(event => batchId(event) !== null)) {
    return trajectory.sort(comparePosition);
  }
  const batches = new Map<string, { firstAt: number; events: TrajectoryEvent[] }>();
  for (const event of trajectory) {
    const id = batchId(event);
    const timestamp = event.createdAt.getTime();
    const key = id === null ? `unbatched:${timestamp}` : `batch:${id}`;
    const batch = batches.get(key) ?? { firstAt: timestamp, events: [] };
    batch.firstAt = Math.min(batch.firstAt, timestamp);
    batch.events.push(event);
    batches.set(key, batch);
  }
  return [...batches.values()]
    .sort((left, right) => left.firstAt - right.firstAt)
    .flatMap(batch => batch.events.sort(comparePosition));
}

export interface LoadSessionsOpts {
  userId: string | null;
  userLabel: string | 'all';
  days: number;
  rotation?: string;
  sessionId?: string;
}

export interface ResolvedUser {
  id: string;
  label: string;
}

export async function resolveUser(input: string): Promise<ResolvedUser | null> {
  if (input === 'all') return null;
  const where = input.includes('@') ? { email: input } : { id: input };
  const u = await prisma.user.findFirst({
    where,
    select: { id: true, email: true },
  });
  if (!u) throw new Error(`User not found: ${input}`);
  return { id: u.id, label: u.email ?? u.id };
}

export async function loadSessions(opts: LoadSessionsOpts): Promise<Session[]> {
  const windowStart = new Date(Date.now() - opts.days * DAY_MS);

  const where: Record<string, unknown> = {
    timestamp: { gte: windowStart },
    eventType: { in: ['content_exposed', 'card_reviewed', 'mcq_attempted'] },
  };
  if (opts.userId) where.userId = opts.userId;
  if (opts.rotation) where.rotation = opts.rotation;

  const ratingWhere: Record<string, unknown> = {
    timestamp: { gte: windowStart },
    eventType: 'content_rating',
  };
  if (opts.userId) ratingWhere.userId = opts.userId;

  const [rows, ratingRows] = await Promise.all([
    prisma.learningEvent.findMany({
      where,
      orderBy: { timestamp: 'asc' },
    }),
    prisma.feedEvent.findMany({
      where: ratingWhere,
      orderBy: { timestamp: 'asc' },
    }),
  ]);

  const bySessionTrajectory = new Map<string, TrajectoryEvent[]>();
  const bySessionResponses = new Map<string, ResponseEvent[]>();
  const bySessionUserId = new Map<string, string>();
  const bySessionRotation = new Map<string, string | null>();
  const bySessionRatings = new Map<string, ContentRatingEvent[]>();

  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null;
    if (!sessionId) continue;
    if (opts.sessionId && sessionId !== opts.sessionId) continue;

    bySessionUserId.set(sessionId, row.userId);
    bySessionRotation.set(sessionId, (row.rotation as string | null) ?? null);

    if (row.eventType === 'content_exposed') {
      const list = bySessionTrajectory.get(sessionId) ?? [];
      list.push({
        eventType: 'content_exposed',
        sourceType: (row.sourceType as 'card' | 'question' | 'group'),
        sourceId: row.sourceId,
        createdAt: row.timestamp,
        rotation: (row.rotation as string | null) ?? null,
        metadata: {
          ...meta,
          ...parseConceptThreadMetadata(meta),
        } as unknown as WalkMetadata,
      });
      bySessionTrajectory.set(sessionId, list);
    } else if (row.eventType === 'card_reviewed' || row.eventType === 'mcq_attempted') {
      const list = bySessionResponses.get(sessionId) ?? [];
      list.push({
        eventType: row.eventType,
        sourceType: (row.sourceType as 'card' | 'question'),
        sourceId: row.sourceId,
        createdAt: row.timestamp,
        quality: (row.quality as number | null) ?? null,
        isCorrect: (row.isCorrect as boolean | null) ?? null,
        rotation: (row.rotation as string | null) ?? null,
        metadata: meta as ResponseEvent['metadata'],
      });
      bySessionResponses.set(sessionId, list);
    }
  }

  for (const row of ratingRows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null;
    const serveDecisionId = typeof meta.serveDecisionId === 'string'
      ? meta.serveDecisionId
      : null;
    if (!sessionId || !serveDecisionId) continue;
    if (opts.sessionId && sessionId !== opts.sessionId) continue;
    if (row.itemType !== 'card' && row.itemType !== 'question') continue;
    if (!row.itemId) continue;
    const rating = row.result === 'good'
      ? 'good'
      : row.result === 'bad'
        ? 'bad'
        : row.result === 'cleared' || row.action === 'clear_vote'
          ? 'clear'
          : null;
    if (!rating) continue;
    const list = bySessionRatings.get(sessionId) ?? [];
    list.push({
      eventType: 'content_rating',
      sourceType: row.itemType,
      sourceId: row.itemId,
      serveDecisionId,
      createdAt: row.timestamp,
      rating,
    });
    bySessionRatings.set(sessionId, list);
  }

  const sessions: Session[] = [];
  for (const [sessionId, unorderedTrajectory] of bySessionTrajectory) {
    const trajectory = orderTrajectory(unorderedTrajectory);
    const responses = bySessionResponses.get(sessionId) ?? [];
    responses.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const contentRatings = bySessionRatings.get(sessionId) ?? [];
    contentRatings.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const userId = bySessionUserId.get(sessionId)!;
    const rotation = bySessionRotation.get(sessionId) ?? null;
    // Feed mode is set at session-start, so any tagged item infers the whole
    // session. Defaults to 'mixed' for older events that pre-date the field.
    const feedMode = trajectory.some((t) => t.metadata.feedMode === 'new-only')
      ? 'new-only'
      : 'mixed';
    sessions.push({
      sessionId,
      userId,
      userLabel: opts.userLabel === 'all' ? userId : opts.userLabel,
      rotation,
      startedAt: trajectory[0]?.createdAt ?? new Date(),
      endedAt: trajectory[trajectory.length - 1]?.createdAt ?? new Date(),
      trajectory,
      responses,
      contentRatings,
      feedMode,
    });
  }
  sessions.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return sessions;
}
