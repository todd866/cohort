import { prisma } from '@/lib/prisma';
import type { Session, TrajectoryEvent, ResponseEvent, WalkMetadata } from './walk-types';

const DAY_MS = 24 * 60 * 60 * 1000;

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

  const rows = await prisma.learningEvent.findMany({
    where,
    orderBy: { timestamp: 'asc' },
  });

  const bySessionTrajectory = new Map<string, TrajectoryEvent[]>();
  const bySessionResponses = new Map<string, ResponseEvent[]>();
  const bySessionUserId = new Map<string, string>();
  const bySessionRotation = new Map<string, string | null>();

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
        metadata: meta as unknown as WalkMetadata,
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

  const sessions: Session[] = [];
  for (const [sessionId, trajectory] of bySessionTrajectory) {
    trajectory.sort(
      (a, b) => a.metadata.positionInSession - b.metadata.positionInSession,
    );
    const responses = bySessionResponses.get(sessionId) ?? [];
    responses.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
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
      feedMode,
    });
  }
  sessions.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  return sessions;
}
