import 'server-only';

import { prisma } from '@/lib/prisma';
import { recordCardReview } from '@/lib/review/record-card-review';
import type { PostCommitScheduler } from '@/lib/review/post-commit';
import { COHORT_CARD_DECISION_PATH, COHORT_CARD_DELIVERY_CONTRACT } from './card-turn-contract';
import { loadCohortModuleCardCorpus } from './module-card-corpus.server';

/**
 * Grade one Cohort module card delivery (Increment 3 of
 * docs/designs/2026-09-23-cohort-mirror.md).
 *
 * The learner names only the opaque delivery; the server finds the card it
 * served and re-checks it against the release.
 *
 * CLAIM FIRST. One conditional update closes the delivery (answeredAt null →
 * set, with `isCorrect` = recalled, which the turn's Continue check needs), so
 * of two concurrent grades exactly one proceeds, and only that one records the
 * review. If the review then fails, the claim is released so a retry can
 * record it. A retry that finds its own grade already claimed replays it.
 *
 * The review is md3's own card review (FSRS progress, event, stats), run
 * `isolatedFromMd3` so no similarity or cluster work reaches md3's cards.
 *
 * A card that has left the release (or changed) is closed as skipped, with no
 * review: the journey can continue past it instead of being stuck behind it.
 *
 * The claim carries its request id and a state in the delivery payload
 * (`grade: pending | recorded | skipped`): only a recorded grade is replayed
 * as done. Another request's pending claim answers 409 grade_in_progress,
 * because it may yet be released; a retry of the SAME request resumes and
 * finishes recording (the review is idempotent on its request id).
 */

/** Same mapping as useGrading's CONFIDENCE_TO_QUALITY (a test pins them equal). */
export const COHORT_CONFIDENCE_TO_QUALITY: Readonly<Record<number, number>> = Object.freeze({ 1: 0, 2: 1, 3: 3, 4: 5 });

export interface CohortCardGradeInput {
  userId: string;
  deliveryId: string;
  confidence: number;
  clientRequestId: string;
  responseTimeMs?: number;
}

export type CohortCardGradeResult =
  | { status: 200; body: { ok: true; deduped: boolean; revoked?: true } }
  | { status: number; body: { error: string; code?: string } };

type GradeMark = { state: 'pending' | 'recorded' | 'skipped'; clientRequestId?: string };

function gradeMark(payload: unknown): GradeMark | null {
  const grade = payload && typeof payload === 'object' ? (payload as { grade?: unknown }).grade : undefined;
  if (!grade || typeof grade !== 'object') return null;
  const { state, clientRequestId } = grade as Record<string, unknown>;
  return state === 'pending' || state === 'recorded' || state === 'skipped'
    ? { state, ...(typeof clientRequestId === 'string' ? { clientRequestId } : {}) }
    : null;
}

export async function gradeCohortCard(
  input: CohortCardGradeInput,
  options: { schedulePostCommit?: PostCommitScheduler; now?: Date } = {},
): Promise<CohortCardGradeResult> {
  const quality = COHORT_CONFIDENCE_TO_QUALITY[input.confidence];
  if (quality === undefined) return { status: 400, body: { error: 'Invalid confidence', code: 'invalid_confidence' } };

  const findDelivery = () => prisma.serveDecision.findFirst({
    where: {
      id: input.deliveryId,
      userId: input.userId,
      itemType: 'card',
      decisionPath: COHORT_CARD_DECISION_PATH,
      deliveryPath: 'live',
    },
    select: { itemId: true, sessionId: true, answeredAt: true, quality: true, payload: true },
  });

  const delivery = await findDelivery();
  if (!delivery) return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
  const payload = (delivery.payload ?? {}) as Record<string, unknown>;
  const basePayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'grade'));

  /**
   * An answered delivery. Only a RECORDED grade (or a skip) is reported done;
   * another request's pending claim is still in flight and may yet be
   * released, so the caller must retry rather than move on.
   */
  const answered = (row: { quality: number | null; payload: unknown }): CohortCardGradeResult | 'resume' => {
    const mark = gradeMark(row.payload);
    if (mark?.state === 'skipped') return { status: 200, body: { ok: true, deduped: true, revoked: true } };
    if (mark?.state === 'pending') {
      if (mark.clientRequestId === input.clientRequestId && row.quality === quality) return 'resume';
      return { status: 409, body: { error: 'This card is still being graded; retry', code: 'grade_in_progress' } };
    }
    return row.quality === quality
      ? { status: 200, body: { ok: true, deduped: true } }
      : { status: 409, body: { error: 'This card was already graded', code: 'already_graded' } };
  };

  const now = options.now ?? new Date();
  const discipline = payload.contract === COHORT_CARD_DELIVERY_CONTRACT && typeof payload.discipline === 'string'
    ? payload.discipline : null;
  const loadCard = async () => (discipline
    ? (await loadCohortModuleCardCorpus(prisma, discipline)).cards.find((c) => c.id === delivery.itemId)
    : undefined);

  let resume = false;
  if (delivery.answeredAt) {
    const outcome = answered(delivery);
    if (outcome !== 'resume') return outcome;
    resume = true;
  }

  const card = await loadCard();
  if (!card || payload.contentHash !== card.contentHash || payload.servingFingerprint !== card.releaseFingerprint) {
    if (resume) return { status: 409, body: { error: 'This card is still being graded; retry', code: 'grade_in_progress' } };
    const skipped = await prisma.serveDecision.updateMany({
      where: { id: input.deliveryId, userId: input.userId, answeredAt: null },
      data: {
        answeredAt: now, isCorrect: false, quality: null, responseTimeMs: input.responseTimeMs ?? null,
        payload: { ...basePayload, grade: { state: 'skipped' } },
      },
    });
    if (skipped.count === 0) {
      const current = await findDelivery();
      const outcome = current?.answeredAt ? answered(current) : null;
      if (outcome && outcome !== 'resume') return outcome;
      return { status: 409, body: { error: 'Delivery changed; retry', code: 'delivery_conflict' } };
    }
    return { status: 200, body: { ok: true, deduped: false, revoked: true } };
  }

  if (!resume) {
    const claimed = await prisma.serveDecision.updateMany({
      where: { id: input.deliveryId, userId: input.userId, answeredAt: null },
      data: {
        answeredAt: now, isCorrect: quality >= 3, quality, responseTimeMs: input.responseTimeMs ?? null,
        payload: { ...basePayload, grade: { state: 'pending', clientRequestId: input.clientRequestId } },
      },
    });
    if (claimed.count === 0) {
      const current = await findDelivery();
      const outcome = current?.answeredAt ? answered(current) : null;
      if (outcome === 'resume') resume = true;
      else return outcome ?? { status: 409, body: { error: 'Delivery changed; retry', code: 'delivery_conflict' } };
    }
  }
  const release = () => prisma.serveDecision.updateMany({
    // Only this request's own pending claim: never another grade or a recorded one.
    where: {
      id: input.deliveryId,
      userId: input.userId,
      quality,
      AND: [
        { payload: { path: ['grade', 'state'], equals: 'pending' } },
        { payload: { path: ['grade', 'clientRequestId'], equals: input.clientRequestId } },
      ],
    },
    data: { answeredAt: null, isCorrect: null, quality: null, responseTimeMs: null, payload: basePayload as never },
  });

  let review: Awaited<ReturnType<typeof recordCardReview>>;
  try {
    review = await recordCardReview({
      userId: input.userId,
      cardId: card.id,
      clientRequestId: input.clientRequestId,
      quality,
      responseTimeMs: input.responseTimeMs ?? null,
      metadata: { surface: 'cohort', deliveryId: input.deliveryId },
      sessionId: delivery.sessionId ?? undefined,
      now: options.now,
      schedulePostCommit: options.schedulePostCommit,
      isolatedFromMd3: true,
    });
  } catch (error) {
    await release();
    throw error;
  }
  if (!review.ok) {
    await release();
    return { status: review.status, body: { error: review.error } };
  }
  await prisma.serveDecision.updateMany({
    where: { id: input.deliveryId, userId: input.userId },
    data: { payload: { ...basePayload, grade: { state: 'recorded', clientRequestId: input.clientRequestId } } },
  });
  return { status: 200, body: { ok: true, deduped: false } };
}
