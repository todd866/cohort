import type { Prisma } from '@prisma/client';
import {
  buildRequestFingerprint,
  isRetryableReviewTransactionError,
  readOperationReplay,
  REVIEW_TRANSACTION_MAX_ATTEMPTS,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import { prisma } from '@/lib/prisma';

export type AssessmentType = 'table' | 'image-occlusion';

type AssessmentJsonScalar = string | number | boolean | null;
export type AssessmentJsonValue =
  | AssessmentJsonScalar
  | AssessmentJsonValue[]
  | { [key: string]: AssessmentJsonValue };

export type AssessmentAttemptReceipt = {
  assessmentType: AssessmentType;
  attemptId: string;
  score: number;
  correct: number;
  total: number;
};

export type RecordAssessmentAttemptInput = {
  userId: string;
  clientRequestId: string;
  attemptType: AssessmentType;
  targetId: string;
  rotation?: string;
  topics: string[];
  score: number;
  correct: number;
  total: number;
  data: AssessmentJsonValue;
  now?: Date;
};

export type RecordAssessmentAttemptResult =
  | { ok: true; deduped: boolean; receipt: AssessmentAttemptReceipt }
  | { ok: false; status: number; error: string };

/**
 * Atomically records an assessment, its daily counter, and an immutable replay
 * receipt. A distinct operation namespace prevents an assessment client key
 * from colliding with an unrelated group-attempt key for the same user.
 */
export async function recordAssessmentAttempt(
  input: RecordAssessmentAttemptInput,
): Promise<RecordAssessmentAttemptResult> {
  const now = input.now ?? new Date();
  const resourceId = `assessment:${input.attemptType}:${input.targetId}`;
  const requestFingerprint = buildRequestFingerprint('assessment_attempt', resourceId, {
    assessmentType: input.attemptType,
    rotation: input.rotation ?? null,
    topics: input.topics,
    score: input.score,
    correct: input.correct,
    total: input.total,
    data: input.data,
  });

  const day = new Date(now);
  day.setHours(0, 0, 0, 0);

  let receipt: AssessmentAttemptReceipt | null = null;
  let lastTransactionError: unknown;

  for (
    let transactionAttempt = 1;
    transactionAttempt <= REVIEW_TRANSACTION_MAX_ATTEMPTS;
    transactionAttempt += 1
  ) {
    try {
      receipt = await prisma.$transaction(async (tx) => {
        const operation = await tx.syncOperation.create({
          data: {
            userId: input.userId,
            clientOperationId: input.clientRequestId,
            operationType: 'assessment_attempt',
            status: 'pending',
            requestFingerprint,
          },
          select: { id: true },
        });

        const attempt = await tx.assessmentAttempt.create({
          data: {
            userId: input.userId,
            attemptType: input.attemptType,
            targetId: input.targetId,
            rotation: input.rotation,
            topics: input.topics,
            score: input.score,
            data: input.data as Prisma.InputJsonValue,
            completedAt: now,
          },
          select: { id: true },
        });

        await tx.dailyStats.upsert({
          where: {
            userId_date: {
              userId: input.userId,
              date: day,
            },
          },
          update: { quizzesTaken: { increment: 1 } },
          create: {
            userId: input.userId,
            date: day,
            quizzesTaken: 1,
          },
        });

        const completedReceipt: AssessmentAttemptReceipt = {
          assessmentType: input.attemptType,
          attemptId: attempt.id,
          score: input.score,
          correct: input.correct,
          total: input.total,
        };

        await tx.syncOperation.update({
          where: { id: operation.id },
          data: {
            status: 'completed',
            result: completedReceipt,
          },
        });

        return completedReceipt;
      }, SERIALIZABLE_REVIEW_TRANSACTION);
      break;
    } catch (error) {
      lastTransactionError = error;
      if (!isRetryableReviewTransactionError(error)) throw error;

      const replay = await readOperationReplay<AssessmentAttemptReceipt>({
        userId: input.userId,
        clientRequestId: input.clientRequestId,
        operationType: 'assessment_attempt',
        requestFingerprint,
      });

      if (replay.kind === 'completed' && replay.result) {
        return { ok: true, deduped: true, receipt: replay.result };
      }
      if (replay.kind === 'conflict') {
        return {
          ok: false,
          status: 409,
          error: 'clientRequestId was already used for a different assessment attempt',
        };
      }
      if (replay.kind === 'incomplete') {
        return {
          ok: false,
          status: 503,
          error: 'Assessment attempt is still being recorded; retry with the same clientRequestId',
        };
      }
      if (replay.kind === 'completed') {
        // A completed marker without its immutable receipt is corrupt. Do not
        // acknowledge it as a successful assessment or create another attempt.
        return {
          ok: false,
          status: 503,
          error: 'Assessment receipt is unavailable; retry with the same clientRequestId',
        };
      }

      if (transactionAttempt === REVIEW_TRANSACTION_MAX_ATTEMPTS) throw error;
    }
  }

  if (!receipt) {
    throw lastTransactionError ?? new Error('Assessment attempt transaction failed');
  }

  return { ok: true, deduped: false, receipt };
}
