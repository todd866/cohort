/**
 * The one read behind the `learner-item-v1` delivery prediction
 * (learner-item-prediction.ts), arranged so a serve never waits for it.
 *
 *   - The learner's rate is one bounded read: their most recent graded
 *     answers (LEARNER_ITEM_WINDOW rows on the (userId, timestamp) index). It
 *     is started when the request's predictor is created and is not awaited
 *     there, so it runs beside the lane's own work.
 *   - Item facility costs no read at all. The lanes already read the current
 *     Card and Question rows of a batch by id (current-session-content.ts);
 *     that read now selects the two facility columns and hands them here.
 *     An item that never passed through that read gets the labelled fallback
 *     prior.
 *
 * `predict()` is called where the ServeDecision rows are written and waits at
 * most LEARNER_ITEM_DEADLINE_MS for the learner read if it has not finished.
 * A read that failed or is still running yields no prediction. Nothing here
 * throws to its caller.
 */
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { ServePrediction } from './serve-prediction';
import {
  LEARNER_ITEM_WINDOW,
  learnerItemServePrediction,
  predictLearnerItem,
  tallyLearnerAnswers,
  type ItemFacility,
  type LearnerAnswerTallies,
} from './learner-item-prediction';

/** Longest `predict()` waits for a read that has not finished. */
export const LEARNER_ITEM_DEADLINE_MS = 25;

type ItemRef = { type: string; id: string };

export const learnerItemKey = (item: ItemRef) => `${item.type}:${item.id}`;

export interface LearnerItemPredictor {
  /** Facility already read for these items (`type:id` keys). Returns at once. */
  provideFacility(entries: Iterable<readonly [string, ItemFacility]>): void;
  /**
   * Predictions keyed by `type:id` for the cards and questions given, or null
   * when the learner's rate is unavailable. Never rejects.
   */
  predict(items: readonly ItemRef[], now: Date): Promise<Map<string, ServePrediction> | null>;
}

interface Settled<T> {
  done: boolean;
  value: T | null;
  promise: Promise<void>;
}

function settle<T>(work: () => Promise<T>, label: string, userId: string): Settled<T> {
  const state: Settled<T> = { done: false, value: null, promise: Promise.resolve() };
  let started: Promise<T>;
  try {
    started = work();
  } catch (error) {
    started = Promise.reject(error);
  }
  state.promise = started.then(
    (value) => { state.value = value; state.done = true; },
    (error) => {
      state.done = true;
      logger.warn(`learner-item prediction: ${label} read failed; recording without it`, {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
  return state;
}

function deadline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold a serverless function open for a telemetry timer.
    (timer as { unref?: () => void }).unref?.();
  });
}

export function beginLearnerItemPrediction(userId: string): LearnerItemPredictor {
  const learner = settle<LearnerAnswerTallies>(async () => tallyLearnerAnswers(
    await prisma.learningEvent.findMany({
      where: {
        userId,
        eventType: { in: ['card_reviewed', 'mcq_attempted'] },
        sourceType: { in: ['card', 'question'] },
      },
      orderBy: { timestamp: 'desc' },
      take: LEARNER_ITEM_WINDOW,
      select: { sourceType: true, isCorrect: true, quality: true },
    }),
  ), 'learner rate', userId);

  const facility = new Map<string, ItemFacility>();

  function provideFacility(entries: Iterable<readonly [string, ItemFacility]>): void {
    try {
      for (const [key, value] of entries) facility.set(key, value);
    } catch (error) {
      logger.warn('learner-item prediction: facility hand-off failed', { userId, error: String(error) });
    }
  }

  async function predict(
    items: readonly ItemRef[],
    now: Date,
  ): Promise<Map<string, ServePrediction> | null> {
    try {
      const predictable = items.filter((item) => item.type === 'card' || item.type === 'question');
      if (predictable.length === 0) return null;
      if (!learner.done) {
        await Promise.race([learner.promise, deadline(LEARNER_ITEM_DEADLINE_MS)]);
      }
      if (!learner.done || !learner.value) return null;
      const predictions = new Map<string, ServePrediction>();
      for (const item of predictable) {
        const itemType = item.type as 'card' | 'question';
        const key = learnerItemKey(item);
        predictions.set(key, learnerItemServePrediction(predictLearnerItem({
          itemType,
          learner: learner.value[itemType],
          facility: facility.get(key) ?? null,
        }), now));
      }
      return predictions;
    } catch (error) {
      logger.warn('learner-item prediction failed; no prediction recorded', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return { provideFacility, predict };
}

/**
 * The request's predictor, created on first use and kept on the context so
 * every lane the request tries shares one learner read.
 */
export function learnerItemPredictionFor(ctx: {
  userId: string;
  learnerItemPrediction?: LearnerItemPredictor | null;
}): LearnerItemPredictor {
  if (!ctx.learnerItemPrediction) {
    ctx.learnerItemPrediction = beginLearnerItemPrediction(ctx.userId);
  }
  return ctx.learnerItemPrediction;
}
