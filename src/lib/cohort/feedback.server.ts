import { createHash } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { isRetryableReviewTransactionError, SERIALIZABLE_REVIEW_TRANSACTION } from '@/lib/idempotency';
import { loadCohortModuleCardCorpus } from '@/lib/cohort/module-card-corpus.server';
import { COHORT_CARD_DECISION_PATH, COHORT_CARD_DELIVERY_CONTRACT } from '@/lib/cohort/card-turn-contract';
import { loadCohortServableCorpus } from '@/lib/cohort/module-question-corpus.server';
import { computeStep1QuestionContentHash, isDeliverableStep1Question } from '@/lib/usmle/step1-session.server';

export const COHORT_FEEDBACK_RATINGS = ['good', 'bad', 'clear'] as const;
export type CohortFeedbackRating = typeof COHORT_FEEDBACK_RATINGS[number];
export const COHORT_FEEDBACK_REASONS = ['Context', 'Formatting', 'Needs Image', 'Giveaway', 'Rewrite', 'Length Bias', 'Acronym', 'Too Long', 'Other'] as const;
export type CohortFeedbackReason = typeof COHORT_FEEDBACK_REASONS[number];

const RATING_EVENT: Record<CohortFeedbackRating, { action: string; result: string }> = {
  good: { action: 'vote_up', result: 'good' },
  bad: { action: 'vote_down', result: 'bad' },
  clear: { action: 'clear_vote', result: 'cleared' },
};
const REASON_TO_ISSUE_TYPE: Record<CohortFeedbackReason, string> = {
  Context: 'context', Formatting: 'formatting', 'Needs Image': 'needs-image', Giveaway: 'too-easy',
  Rewrite: 'rewrite', 'Length Bias': 'length-bias', Acronym: 'tla', 'Too Long': 'too-long', Other: 'other',
};

type Input = {
  userId: string; deliveryId: string; clientRequestId: string;
  kind: 'rating' | 'flag'; rating?: CohortFeedbackRating; reason?: CohortFeedbackReason; message?: string;
};
type Result = { status: number; body: Record<string, unknown> };

function messageFingerprint(message: string | undefined): string | null {
  return message == null ? null : createHash('sha256').update(message.slice(0, 1000), 'utf8').digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export async function recordCohortFeedback(input: Input, db: typeof prisma = prisma): Promise<Result> {
  const delivery = await db.serveDecision.findFirst({
    where: { id: input.deliveryId, userId: input.userId, itemType: { in: ['card', 'question'] }, decisionPath: { in: [COHORT_CARD_DECISION_PATH, 'usmle-step1-baseline-v1', 'usmle-step1-daily-v1'] }, deliveryPath: { not: null } },
    select: { id: true, itemId: true, itemType: true, sessionId: true, payload: true, rotation: true },
  });
  if (!delivery || !record(delivery.payload) || delivery.payload.surface !== 'cohort') return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
  const payload = delivery.payload;
  const contract = payload.contract;
  let snapshot: string | undefined;
  if (delivery.itemType === 'card') {
    if (contract !== COHORT_CARD_DELIVERY_CONTRACT || typeof payload.discipline !== 'string' || typeof payload.contentHash !== 'string' || typeof payload.servingFingerprint !== 'string') return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
    const card = (await loadCohortModuleCardCorpus(db, payload.discipline)).cards.find((row) => row.id === delivery.itemId);
    if (!card || card.contentHash !== payload.contentHash || card.releaseFingerprint !== payload.servingFingerprint) return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
    snapshot = card.front.slice(0, 200);
  } else {
    if (contract !== 'usmle-step1-delivery-v3') return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
    const corpus = await loadCohortServableCorpus(db);
    const question = corpus.questions.find((row) => row.id === delivery.itemId);
    if (!question || !isDeliverableStep1Question(question)
      || typeof payload.contentHash !== 'string'
      || computeStep1QuestionContentHash(question) !== payload.contentHash
      || question.releaseFingerprint !== payload.servingFingerprint) {
      return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
    }
    snapshot = question.stem.slice(0, 200);
  }
  if (input.kind === 'rating') {
    if (!input.rating) return { status: 400, body: { error: 'Invalid rating' } };
    const event = RATING_EVENT[input.rating];
    const write = async (tx: typeof db) => {
      const existing = await tx.feedEvent.findFirst({ where: { userId: input.userId, eventType: 'content_rating', itemId: delivery.itemId, metadata: { path: ['clientRequestId'], equals: input.clientRequestId } }, select: { result: true } });
      if (existing) return existing.result === event.result
        ? { status: 200, body: { success: true, rating: input.rating, deduped: true } }
        : { status: 409, body: { error: 'Client request id already used for different feedback', code: 'idempotency_conflict' } };
      await tx.feedEvent.create({ data: { userId: input.userId, eventType: 'content_rating', itemId: delivery.itemId, itemType: delivery.itemType, action: event.action, result: event.result, metadata: { version: 'content-rating-v1', clientRequestId: input.clientRequestId, deliveryId: input.deliveryId, serveDecisionId: input.deliveryId, sessionId: delivery.sessionId, surface: 'cohort', canonicalItemId: delivery.itemId } } });
      return { status: 200, body: { success: true, rating: input.rating, deduped: false } };
    };
    const transaction = (db as typeof db & { $transaction: (fn: (tx: typeof db) => Promise<Result>, options: unknown) => Promise<Result> }).$transaction;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await transaction.call(db, write, SERIALIZABLE_REVIEW_TRANSACTION); }
      catch (error) {
        if (!isRetryableReviewTransactionError(error) || attempt === 2) throw error;
      }
    }
    throw new Error('Feedback transaction did not complete');
  }
  if (!input.reason) return { status: 400, body: { error: 'Invalid feedback reason' } };
  const existing = await db.contentIssue.findFirst({ where: { clientRequestId: input.clientRequestId }, select: { id: true, targetId: true, targetType: true, metadata: true, reportCount: true } });
  if (existing) {
    const meta = record(existing.metadata) ? existing.metadata : {};
    if (meta.userId !== input.userId || meta.deliveryId !== input.deliveryId) return { status: 404, body: { error: 'Delivery not found', code: 'delivery_not_found' } };
    if (meta.reason !== input.reason || meta.messageFingerprint !== messageFingerprint(input.message)) return { status: 409, body: { error: 'Client request id already used for different feedback', code: 'idempotency_conflict' } };
    return { status: 200, body: { success: true, issueId: existing.id, reportCount: existing.reportCount, deduped: true } };
  }
  let issue;
  try { issue = await db.contentIssue.create({ data: { targetType: delivery.itemType, targetId: delivery.itemId, issueType: REASON_TO_ISSUE_TYPE[input.reason], status: 'open', priority: 'normal', reportCount: 1, contentSnapshot: snapshot, clientRequestId: input.clientRequestId, quarantinedMessage: input.message?.slice(0, 1000) ?? null, metadata: { reporterType: 'user', reporterAccountType: 'cohort', userId: input.userId, deliveryId: input.deliveryId, surface: 'cohort', reason: input.reason, messageFingerprint: messageFingerprint(input.message) } } });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
    const winner = await db.contentIssue.findFirst({ where: { clientRequestId: input.clientRequestId }, select: { id: true, reportCount: true, metadata: true } });
    const meta = record(winner?.metadata) ? winner.metadata : {};
    if (!winner || meta.userId !== input.userId || meta.deliveryId !== input.deliveryId || meta.reason !== input.reason || meta.messageFingerprint !== messageFingerprint(input.message)) return { status: 409, body: { error: 'Client request id already used for different feedback', code: 'idempotency_conflict' } };
    return { status: 200, body: { success: true, issueId: winner.id, reportCount: winner.reportCount, deduped: true } };
  }
  return { status: 200, body: { success: true, issueId: issue.id, reportCount: issue.reportCount, deduped: false } };
}
