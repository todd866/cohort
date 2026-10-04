import { prisma } from '@/lib/prisma';
import type { SessionContext } from './unified-session-types';

/** Bounded, request-local evidence used by the learner-controlled hard lane. */
export interface ReviewLearningGap {
  conceptIds: Set<string>;
  topics: Set<string>;
  questionIds: Set<string>;
  /** False means the evidence read failed; callers must not treat it as empty. */
  available: boolean;
}

const GAP_LIMIT = 1000;
const RECENT_PROBE_MS = 24 * 60 * 60 * 1000;

export async function loadReviewLearningGap(
  userId: string,
  rotation: string,
  now = new Date(),
): Promise<ReviewLearningGap> {
  try {
    const states = await prisma.conceptState.findMany({
      where: {
        userId,
        probeCount: { gt: 0 },
        concept: { rotation },
        OR: [
          { recallProbability: { lt: 0.6 } },
          {
            recentFailRate: { gt: 0 },
            lastProbeAt: { gte: new Date(now.getTime() - RECENT_PROBE_MS) },
          },
        ],
      },
      select: { conceptId: true, concept: { select: { topics: true } } },
      orderBy: { lastProbeAt: 'desc' },
      take: GAP_LIMIT + 1,
    });
    if (states.length > GAP_LIMIT) throw new Error('Learning gap evidence exceeded its bounded read');
    const conceptIds = new Set(states.map((state) => state.conceptId));
    const topics = new Set(states.flatMap((state) => state.concept.topics));
    if (conceptIds.size === 0) return { conceptIds, topics, questionIds: new Set(), available: true };

    const questions = await prisma.question.findMany({
      where: {
        rotation,
        difficulty: 'hard',
        concepts: { some: { conceptId: { in: [...conceptIds] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: GAP_LIMIT * 20 + 1,
    });
    if (questions.length > GAP_LIMIT * 20) throw new Error('Learning gap question evidence exceeded its bounded read');
    return {
      conceptIds,
      topics,
      questionIds: new Set(questions.map((question) => question.id)),
      available: true,
    };
  } catch {
    return { conceptIds: new Set(), topics: new Set(), questionIds: new Set(), available: false };
  }
}

const requestGaps = new WeakMap<SessionContext, Promise<ReviewLearningGap>>();

/** One materialized-state read per request, shared by its candidate and egress gates. */
export function getReviewLearningGap(ctx: SessionContext): Promise<ReviewLearningGap> {
  let pending = requestGaps.get(ctx);
  if (!pending) {
    pending = loadReviewLearningGap(ctx.userId, ctx.rotation);
    requestGaps.set(ctx, pending);
  }
  return pending;
}
