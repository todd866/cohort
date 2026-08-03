import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { findCardsForQuestion } from '@/lib/manifold';
import { expandTopicSet, normalizeTopic } from '@/lib/topics';
import { updateUserStreak } from '@/lib/stats';
import {
  applyLearningEventDerivedState,
  createPreparedLearningEvent,
  recordLearningEvent,
  getConceptIdsForQuestion,
  prepareLearningEvent,
} from '@/lib/learning';
import { logger } from '@/lib/logger';
import { userIdCanAccessRequestedRotations } from '@/lib/personal-rotation-access';
import { prependCardsToQueue } from '@/lib/study-queue';
import { coerceScorableOptions, type ScorableOption } from '@/lib/question-validation';
import { mergeDecisionContext, type DecisionContext } from '@/lib/scheduler-observability';
import {
  buildRequestFingerprint,
  isRetryableReviewTransactionError,
  readOperationReplay,
  REVIEW_TRANSACTION_MAX_ATTEMPTS,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import type { ReviewWriteContext } from '@/lib/review/review-write-observability';
import { persistableConceptId } from '@/lib/knowledge/synthetic-concept';
import { isRawPublicUsmleQuestionIdentity } from '@/lib/usmle/raw-question-boundary';
import {
  PUBLIC_USMLE_STORED_QUESTION_SELECT,
  publicUsmleServingFingerprint,
  publicUsmleServingStateFailures,
} from '@/lib/usmle/public-serving-fingerprint';
import {
  CHECKED_IN_OPEN_USMLE_RELEASE,
  CHECKED_IN_OPEN_USMLE_RELEASE_IDS,
} from '@/lib/usmle/public-release-bundle';

/**
 * An in-process capability for the answer-safe Step 1 delivery contract.
 * Public-USMLE rows must never be graded through a generic question-id route.
 * A Symbol is intentionally not representable in JSON or forgeable from a
 * request body; the canonical Step 1 server path passes this exact identity.
 *
 * @internal
 */
export const PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY = Symbol(
  'public-usmle-delivery-write-capability',
);

export type RecordQuestionAttemptInput = {
  userId: string;
  questionId: string;
  clientRequestId: string;
  selectedOption: string | null; // null = skipped (didn't know)
  responseTimeMs?: number | null;
  /** Pre-reveal self-assessment: 1=guessing through 4=obvious. */
  confidence?: number | null;
  sessionType?: string | null;
  correctDisplayPosition?: number; // 0-indexed position correct answer was shown
  selectedDisplayPosition?: number | null; // 0-indexed position user clicked (null for skip)
  now?: Date;
  clientTimestampFingerprint?: string | null;
  metadata?: Record<string, unknown>;
  /** Server-authored concept selected for this exact delivery. Never trust a client value. */
  servedConceptId?: string | null;
  writeContext?: ReviewWriteContext;
  // Walk audit (Phase 1 of 2026-04-17-scheduler-walk-audit)
  sessionId?: string;
  batchId?: string;
  /** @internal Available only to the opaque public-USMLE delivery path. */
  publicUsmleDeliveryCapability?: typeof PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY;
  /** @internal Checked-in source fingerprint bound to the opaque delivery. */
  publicUsmleExpectedServingFingerprint?: string;
  /** @internal Original (unshuffled) correct label bound to the opaque delivery. */
  publicUsmleExpectedCorrectOption?: string;
  /** @internal Source-bound routing context for the immutable event. */
  publicUsmleExpectedRotation?: string;
  /** @internal Source-bound week; null is a deliberate value. */
  publicUsmleExpectedWeek?: number | null;
  /** @internal Source-bound explanation for the canonical receipt. */
  publicUsmleExpectedContext?: string;
};

type RecordQuestionAttemptBackgroundInput = Omit<RecordQuestionAttemptInput, 'clientRequestId'> & {
  isCorrect: boolean;
  /**
   * The fast path writes the canonical LearningEvent immediately so fresh
   * exclusion data is available before background work finishes.
   */
  skipLearningEvent?: boolean;
};

export type RecordQuestionAttemptOk = {
  ok: true;
  isCorrect: boolean;
  correctOption: string;
  attemptNumber: number;
  explanation: string | null;
  conceptMastery: Array<{
    conceptId: string;
    conceptName: string;
    mastery: number;
    confidence: number;
  }>;
  remediationCards: Array<{ cardId: string; front: string; similarity: number }>;
};

export type QuestionAttemptReceipt = Pick<
  RecordQuestionAttemptOk,
  'isCorrect' | 'correctOption' | 'attemptNumber' | 'explanation'
>;

export type RecordQuestionAttemptDuplicate = {
  ok: true;
  deduped: true;
  receipt: QuestionAttemptReceipt | null;
};

export type RecordQuestionAttemptResult =
  | RecordQuestionAttemptOk
  | RecordQuestionAttemptDuplicate
  | {
      ok: false;
      status: number;
      error: string;
      code?: 'question_content_changed';
    };

/**
 * Fast path: Grade the answer and record the response.
 * Does NOT compute concept mastery or remediation cards (those are deferred).
 */
export async function recordQuestionAttemptFast(
  input: RecordQuestionAttemptInput
): Promise<RecordQuestionAttemptResult> {
  const { userId, questionId, clientRequestId } = input;
  const selectedOption = input.selectedOption?.toUpperCase() ?? null; // null = skipped
  const now = input.now ?? new Date();
  const writeContext: ReviewWriteContext = input.writeContext ?? {
    deviceBucket: 'unknown',
    transport: 'server',
    receivedAt: new Date(),
    timestampSource: input.now ? 'client_action' : 'server_received',
  };
  const responseTimeMs = input.responseTimeMs ?? undefined;
  const confidence = input.confidence ?? undefined;
  const sessionType = input.sessionType ?? undefined;
  const isPublicUsmleDelivery =
    input.publicUsmleDeliveryCapability === PUBLIC_USMLE_DELIVERY_WRITE_CAPABILITY;

  if (!userId) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  if (!questionId) {
    return {
      ok: false,
      status: 400,
      error: 'questionId is required',
    };
  }

  if (!clientRequestId) {
    return { ok: false, status: 400, error: 'clientRequestId is required' };
  }

  if (
    confidence !== undefined
    && (!Number.isInteger(confidence) || confidence < 1 || confidence > 4)
  ) {
    return {
      ok: false,
      status: 400,
      error: 'confidence must be an integer from 1 to 4',
    };
  }

  const hasPublicUsmleBinding = input.publicUsmleDeliveryCapability !== undefined
    || input.publicUsmleExpectedServingFingerprint !== undefined
    || input.publicUsmleExpectedCorrectOption !== undefined
    || input.publicUsmleExpectedRotation !== undefined
    || input.publicUsmleExpectedWeek !== undefined
    || input.publicUsmleExpectedContext !== undefined;
  const expectedServingFingerprint = input.publicUsmleExpectedServingFingerprint;
  const expectedCorrectOption = input.publicUsmleExpectedCorrectOption?.trim().toUpperCase();
  const expectedRotation = input.publicUsmleExpectedRotation;
  const expectedWeek = input.publicUsmleExpectedWeek;
  const expectedContext = input.publicUsmleExpectedContext;
  if (
    hasPublicUsmleBinding
    && (
      !isPublicUsmleDelivery
      || !expectedServingFingerprint
      || !/^[a-f0-9]{64}$/.test(expectedServingFingerprint)
      || !expectedCorrectOption
      || !/^[A-Z]$/.test(expectedCorrectOption)
      || !expectedRotation
      || expectedWeek === undefined
      || !expectedContext
    )
  ) {
    return { ok: false, status: 400, error: 'Public USMLE delivery binding is invalid' };
  }
  if (CHECKED_IN_OPEN_USMLE_RELEASE_IDS.has(questionId) && !isPublicUsmleDelivery) {
    return { ok: false, status: 404, error: 'Question not found' };
  }
  if (
    isPublicUsmleDelivery
    && (
      !CHECKED_IN_OPEN_USMLE_RELEASE_IDS.has(questionId)
      || CHECKED_IN_OPEN_USMLE_RELEASE.questionFingerprints[questionId]
        !== expectedServingFingerprint
    )
  ) {
    return {
      ok: false,
      status: 409,
      code: 'question_content_changed',
      error: 'Question content changed after delivery',
    };
  }

  // Preserve the generic writer's established outer authorization/preparation
  // path. Protected Step 1 uses this read only for routing/event context; its
  // source-bound grade is revalidated under a row lock before any write.
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      options: true,
      context: true,
      rotation: true,
      week: true,
      moduleNodes: true,
    },
  });
  if (!question) {
    return isPublicUsmleDelivery
      ? {
          ok: false,
          status: 409,
          code: 'question_content_changed',
          error: 'Question content changed after delivery',
        }
      : { ok: false, status: 404, error: 'Question not found' };
  }
  if (!isPublicUsmleDelivery && isRawPublicUsmleQuestionIdentity(question)) {
    return { ok: false, status: 404, error: 'Question not found' };
  }
  const { context, rotation, week } = question;
  const authorizationRotation = isPublicUsmleDelivery
    ? expectedRotation!
    : rotation ?? '';
  if (!await userIdCanAccessRequestedRotations(userId, [authorizationRotation])) {
    return { ok: false, status: 404, error: 'Question not found' };
  }

  let isCorrect: boolean;
  let correctOption: string;
  if (isPublicUsmleDelivery) {
    correctOption = expectedCorrectOption!;
    isCorrect = selectedOption !== null && selectedOption === correctOption;
  } else {
    if (!Array.isArray(question.options)) {
      return { ok: false, status: 500, error: 'Question options are invalid' };
    }
    const options: ScorableOption[] = coerceScorableOptions(question.options);
    if (options.length < 4) {
      return { ok: false, status: 500, error: 'Question options are incomplete' };
    }
    if (options.filter((option) => option.isCorrect).length !== 1) {
      return { ok: false, status: 500, error: 'Question correct answer is invalid' };
    }
    correctOption = options.find((option) => option.isCorrect)!.label;
    const selectedOptionData = selectedOption === null
      ? null
      : options.find((option) => option.label.toUpperCase() === selectedOption);
    isCorrect = selectedOption === null ? false : (selectedOptionData?.isCorrect ?? false);
  }

  const requestFingerprint = buildRequestFingerprint('mcq_response', questionId, {
    selectedOption,
    responseTimeMs: responseTimeMs ?? null,
    sessionType: sessionType ?? null,
    // Preserve the pre-confidence fingerprint for existing callers that omit
    // the field, while binding every explicitly captured confidence value.
    ...(confidence !== undefined ? { confidence } : {}),
    correctDisplayPosition: input.correctDisplayPosition ?? null,
    selectedDisplayPosition: input.selectedDisplayPosition ?? null,
    clientTimestamp: input.clientTimestampFingerprint !== undefined
      ? input.clientTimestampFingerprint
      : input.now?.toISOString() ?? null,
    ...(isPublicUsmleDelivery ? {
      publicUsmleExpectedServingFingerprint: expectedServingFingerprint!,
      publicUsmleExpectedCorrectOption: expectedCorrectOption!,
    } : {}),
  });

  const walkContext: DecisionContext = {};
  if (input.sessionId) walkContext.sessionId = input.sessionId;
  if (input.batchId) walkContext.batchId = input.batchId;

  const servedConceptId = persistableConceptId(input.servedConceptId);
  let conceptIds: string[] = servedConceptId ? [servedConceptId] : [];
  if (conceptIds.length === 0) {
    try {
      conceptIds = await getConceptIdsForQuestion(questionId);
    } catch (error) {
      // Concept links are derived context; preserve the canonical attempt/event
      // pair even when enrichment is temporarily unavailable.
      logger.warn('Failed to resolve question concepts for learning event', {
        questionId,
        error: String(error),
      });
    }
  }
  // Prepare the immutable event before opening the short row-lock transaction.
  // For public Step 1, every mutable field comes from the signed delivery
  // binding and content version lookup is deliberately disabled. The locked
  // read below must match this complete snapshot before the first write.
  const preparedLearningEvent = await prepareLearningEvent({
    userId,
    eventType: 'mcq_attempted',
    sourceType: 'question',
    sourceId: questionId,
    isCorrect,
    responseMs: responseTimeMs,
    conceptIds,
    metadata: mergeDecisionContext(input.metadata, walkContext),
    clientOperationId: clientRequestId,
    deviceBucket: writeContext.deviceBucket,
    writeTransport: writeContext.transport,
    receivedAt: writeContext.receivedAt,
    timestampSource: writeContext.timestampSource,
    rotation: isPublicUsmleDelivery ? expectedRotation : rotation ?? undefined,
    week: isPublicUsmleDelivery ? expectedWeek ?? undefined : week ?? undefined,
    timestamp: now,
    ...(isPublicUsmleDelivery ? {
      contentHash: expectedServingFingerprint!,
      skipContentVersionResolution: true,
    } : {}),
  });
  let receipt: QuestionAttemptReceipt | null = null;
  let lastTransactionError: unknown;

  for (let transactionAttempt = 1; transactionAttempt <= REVIEW_TRANSACTION_MAX_ATTEMPTS; transactionAttempt++) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const transactionContext = isPublicUsmleDelivery ? expectedContext! : context;
        // Public Step 1 grading is delivery-bound. Lock before the full read so
        // no content update can cross the fingerprint check/write boundary.
        if (isPublicUsmleDelivery) {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "Question" WHERE "id" = ${questionId} FOR SHARE`,
          );
        }

        if (isPublicUsmleDelivery) {
          const lockedQuestion = await tx.question.findUnique({
            where: { id: questionId },
            select: PUBLIC_USMLE_STORED_QUESTION_SELECT,
          });
          if (
            !lockedQuestion
            || !isRawPublicUsmleQuestionIdentity(lockedQuestion)
            || publicUsmleServingStateFailures(lockedQuestion).length > 0
            || publicUsmleServingFingerprint(lockedQuestion) !== expectedServingFingerprint
            || lockedQuestion.rotation !== expectedRotation
            || lockedQuestion.week !== expectedWeek
            || lockedQuestion.context !== expectedContext
          ) {
            return {
              kind: 'failure' as const,
              result: {
                ok: false as const,
                status: 409,
                code: 'question_content_changed' as const,
                error: 'Question content changed after delivery',
              },
            };
          }
          if (!Array.isArray(lockedQuestion.options)) {
            return {
              kind: 'failure' as const,
              result: {
                ok: false as const,
                status: 409,
                code: 'question_content_changed' as const,
                error: 'Question content changed after delivery',
              },
            };
          }
          const lockedOptions: ScorableOption[] = coerceScorableOptions(
            lockedQuestion.options,
          );
          const lockedCorrectOptions = lockedOptions.filter((option) => option.isCorrect);
          const lockedCorrectOption = lockedCorrectOptions[0]?.label.trim().toUpperCase();
          const lockedSelected = selectedOption === null
            ? null
            : lockedOptions.find(
                (option) => option.label.trim().toUpperCase() === selectedOption,
              );
          const lockedIsCorrect = selectedOption === null
            ? false
            : (lockedSelected?.isCorrect ?? false);
          if (
            lockedOptions.length < 4
            || lockedCorrectOptions.length !== 1
            || lockedCorrectOption !== expectedCorrectOption
            || (selectedOption !== null && !lockedSelected)
            || lockedIsCorrect !== isCorrect
          ) {
            return {
              kind: 'failure' as const,
              result: {
                ok: false as const,
                status: 409,
                code: 'question_content_changed' as const,
                error: 'Question content changed after delivery',
              },
            };
          }
        }

        // Pending never commits independently: marker, response, and completed
        // receipt are one atomic unit.
        const operation = await tx.syncOperation.create({
          data: {
            userId,
            clientOperationId: clientRequestId,
            operationType: 'mcq_response',
            status: 'pending',
            requestFingerprint,
          },
          select: { id: true },
        });

        const previous = await tx.questionResponse.aggregate({
          where: { userId, questionId },
          _max: { attemptNumber: true },
        });
        const attemptNumber = (previous._max.attemptNumber ?? 0) + 1;

        await tx.questionResponse.create({
          data: {
            userId,
            questionId,
            selectedOption: selectedOption ?? 'SKIP', // Store SKIP for skipped questions
            isCorrect,
            responseTimeMs,
            confidence,
            sessionType,
            createdAt: now,
            attemptNumber,
            correctDisplayPosition: input.correctDisplayPosition,
            selectedDisplayPosition: input.selectedDisplayPosition,
          },
        });

        const day = new Date(now);
        day.setHours(0, 0, 0, 0);
        const stats = await tx.dailyStats.upsert({
          where: { userId_date: { userId, date: day } },
          update: {
            quizzesTaken: { increment: 1 },
            studyTimeMs: responseTimeMs ? { increment: responseTimeMs } : undefined,
          },
          create: {
            userId,
            date: day,
            quizzesTaken: 1,
            cardsReviewed: 0,
            cardsCorrect: 0,
            pagesViewed: 0,
            studyTimeMs: responseTimeMs ?? 0,
            studyTimeMin: 0,
          },
        });
        if (responseTimeMs) {
          await tx.dailyStats.update({
            where: { id: stats.id },
            data: { studyTimeMin: Math.ceil(stats.studyTimeMs / 60000) },
          });
        }

        // Mode A: the immutable event commits with the response and receipt.
        await createPreparedLearningEvent(tx, preparedLearningEvent);

        const completedReceipt: QuestionAttemptReceipt = {
          isCorrect,
          correctOption,
          attemptNumber,
          explanation: transactionContext,
        };
        await tx.syncOperation.update({
          where: { id: operation.id },
          data: { status: 'completed', result: completedReceipt },
        });
        return {
          kind: 'success' as const,
          receipt: completedReceipt,
        };
      }, SERIALIZABLE_REVIEW_TRANSACTION);
      if (outcome.kind === 'failure') return outcome.result;
      receipt = outcome.receipt;
      break;
    } catch (error) {
      lastTransactionError = error;
      if (!isRetryableReviewTransactionError(error)) throw error;

      const replay = await readOperationReplay<QuestionAttemptReceipt>({
        userId,
        clientRequestId,
        operationType: 'mcq_response',
        requestFingerprint,
      });
      if (replay.kind === 'completed') {
        return { ok: true, deduped: true, receipt: replay.result };
      }
      if (replay.kind === 'conflict') {
        return { ok: false, status: 409, error: 'clientRequestId was already used for a different response' };
      }
      if (replay.kind === 'incomplete') {
        return { ok: false, status: 503, error: 'Response is still being recorded; retry with the same clientRequestId' };
      }
      // No marker means this was an attempt-number/serialization race. Retry
      // the max+1 allocation; the unique constraint remains authoritative.
      if (transactionAttempt === REVIEW_TRANSACTION_MAX_ATTEMPTS) throw error;
    }
  }

  if (!receipt) {
    throw lastTransactionError ?? new Error('Question response transaction failed');
  }

  // Mode B derived state is rebuildable and best-effort after the immutable
  // event and canonical response have committed.
  try {
    await applyLearningEventDerivedState(preparedLearningEvent);
  } catch (err) {
    logger.error('Failed to update derived question learning state', {
      userId,
      questionId,
      error: String(err),
    });
  }

  return {
    ok: true,
    ...receipt,
    conceptMastery: [], // Computed in background
    remediationCards: [], // Computed in background
  };
}

/**
 * Background work: Update concept state, daily stats, and find remediation cards.
 * This runs after the response is sent to the user.
 */
export async function recordQuestionAttemptBackground(
  input: RecordQuestionAttemptBackgroundInput
): Promise<void> {
  const { userId, questionId, isCorrect } = input;
  const responseTimeMs = input.responseTimeMs ?? undefined;
  const now = input.now ?? new Date();

  try {
    // Fetch question for context
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      select: { id: true, rotation: true, week: true, topics: true },
    });

    if (!question) return;

    if (!input.skipLearningEvent) {
      // Snapshot predicted recall for observability before updating concept state
      const servedConceptId = persistableConceptId(input.servedConceptId);
      const conceptIds = servedConceptId
        ? [servedConceptId]
        : await getConceptIdsForQuestion(questionId);
      let predictedRecall: number | undefined;
      if (conceptIds.length > 0) {
        const conceptState = await prisma.conceptState.findFirst({
          where: { userId, conceptId: conceptIds[0] },
          select: { recallProbability: true },
        });
        predictedRecall = conceptState?.recallProbability ?? undefined;
      }

      // Update ConceptState via unified learning event (single write path)
      const bgWalkContext: DecisionContext = {};
      if (input.sessionId) bgWalkContext.sessionId = input.sessionId;
      if (input.batchId) bgWalkContext.batchId = input.batchId;

      await writeLearningEventForQuestion(
        userId,
        questionId,
        question.rotation,
        isCorrect,
        responseTimeMs,
        now,
        mergeDecisionContext({ ...input.metadata, predictedRecall }, bgWalkContext),
        { conceptIds },
      );
    }

    // DailyStats committed with the response/event/receipt in the fast path.
    // Streak is derived and can be recomputed, so it remains background work.
    await updateUserStreak(userId);

    // Queue related cards for reinforcement
    // Wrong answers: queue immediately for remediation
    if (!isCorrect) {
      const remediationCardIds = await findAndQueueRemediationCards(userId, question, now);
      if (remediationCardIds.length > 0 && question.rotation) {
        await prependCardsToQueue(userId, question.rotation, remediationCardIds);
      }
    }
  } catch (error) {
    logger.error('Background question attempt processing failed', { error: String(error), userId });
  }
}

/**
 * Find related cards and queue them for review.
 * Wrong answers: queue immediately for remediation
 */
async function findAndQueueRemediationCards(
  userId: string,
  question: {
    id: string;
    rotation: string;
    topics: string[];
  },
  now: Date
): Promise<string[]> {
  const dueAt = now;
  let remediationCardIds: string[] = [];

  try {
    // Try vector similarity first
    const similarCards = await findCardsForQuestion(question.id, 5, 0.4);
    remediationCardIds = similarCards.filter((c) => !!c.front).map((c) => c.cardId);

    if (remediationCardIds.length > 0) {
      const metas = await prisma.card.findMany({
        where: { id: { in: remediationCardIds }, deletedAt: null },
        select: { id: true, complexity: true },
      });
      const byId = new Map(metas.map((m) => [m.id, m.complexity]));

      // Prefer simpler cards. Cap at 1 (was 5) — every wrong question used
      // to bump 5 cards' nextDueAt to "now," polluting the next session's
      // top-of-queue with up to 5×wrong-count items and starving coverage.
      // One scaffold per wrong question is enough; if user gets it wrong again,
      // we'll spawn another on the next attempt.
      remediationCardIds = remediationCardIds
        .sort((a, b) => (byId.get(a) ?? 2) - (byId.get(b) ?? 2))
        .slice(0, 1);
    }

    // Fallback to topic matching
    if (remediationCardIds.length === 0) {
      const TOPIC_STOPLIST = new Set([
        'management',
        'diagnosis',
        'interpretation',
        'mechanism',
        'calculation',
        'monitoring',
      ]);

      const rawTopics = (question.topics ?? [])
        .filter((t) => typeof t === 'string')
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && !t.startsWith('_'));

      const questionTopics = rawTopics.filter((t) => !TOPIC_STOPLIST.has(normalizeTopic(t)));
      const queryTopics = questionTopics.length > 0 ? expandTopicSet(questionTopics) : [];

      if (questionTopics.length > 0) {
        const candidateCards = await prisma.card.findMany({
          where: {
            rotation: question.rotation,
            deletedAt: null,
            topics: { hasSome: queryTopics },
          },
          select: {
            id: true,
            topics: true,
            complexity: true,
          },
          take: 40,
        });

        const qTopicSet = new Set(questionTopics.map(normalizeTopic).filter(Boolean));

        const scored = candidateCards
          .map((c) => {
            const cTopics = Array.isArray(c.topics) ? c.topics : [];
            const cTopicSet = new Set(cTopics.map(normalizeTopic).filter(Boolean));
            const intersection = [...cTopicSet].filter((t) => qTopicSet.has(t));
            const union = new Set([...qTopicSet, ...cTopicSet]);
            const jaccard = union.size === 0 ? 0 : intersection.length / union.size;
            const complexityBoost = c.complexity <= 1 ? 0.18 : c.complexity === 2 ? 0.08 : 0;
            return { id: c.id, score: Math.min(1, jaccard + complexityBoost), complexity: c.complexity };
          })
          .filter((c) => c.score >= 0.25)
          .sort((a, b) => {
            if (a.complexity !== b.complexity) return a.complexity - b.complexity;
            return b.score - a.score;
          })
          .slice(0, 1);

        remediationCardIds = scored.map((c) => c.id);
      }
    }

    // Queue related cards
    if (remediationCardIds.length > 0) {
      await prisma.cardProgress.createMany({
        data: remediationCardIds.map((cardId) => ({ userId, cardId, nextDueAt: dueAt })),
        skipDuplicates: true,
      });

      await prisma.cardProgress.updateMany({
        where: {
          userId,
          cardId: { in: remediationCardIds },
          suppressed: false,
          status: { not: 'retired' },
        },
        data: { nextDueAt: dueAt },
      });
    }
    return remediationCardIds;
  } catch (error) {
    logger.warn('Failed to find remediation cards', { error: String(error) });
  }
  return [];
}

async function writeLearningEventForQuestion(
  userId: string,
  questionId: string,
  rotation: string | undefined,
  isCorrect: boolean,
  responseMs: number | undefined,
  timestamp: Date,
  externalMetadata?: Record<string, unknown>,
  opts?: { week?: number; skipDbLookup?: boolean; conceptIds?: string[] },
): Promise<void> {
  const conceptIds = opts?.conceptIds ?? await getConceptIdsForQuestion(questionId);

  let resolvedRotation = rotation;
  let resolvedWeek = opts?.week;

  // Fetch rotation/week from DB only when not already provided (background path passes these;
  // fast path passes skipDbLookup=true to avoid a redundant round-trip)
  if (!opts?.skipDbLookup && (resolvedRotation === undefined || resolvedWeek === undefined)) {
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      select: { week: true, rotation: true },
    });
    resolvedRotation = resolvedRotation ?? question?.rotation ?? undefined;
    resolvedWeek = resolvedWeek ?? question?.week ?? undefined;
  }

  await recordLearningEvent({
    userId,
    eventType: 'mcq_attempted',
    sourceType: 'question',
    sourceId: questionId,
    isCorrect,
    responseMs,
    conceptIds,
    rotation: resolvedRotation,
    week: resolvedWeek,
    metadata: externalMetadata,
    timestamp,
  });
}
