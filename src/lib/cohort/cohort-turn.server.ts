import 'server-only';

import type { Prisma } from '@prisma/client';
import {
  buildRequestFingerprint,
  isRetryableReviewTransactionError,
  REVIEW_TRANSACTION_MAX_ATTEMPTS,
  SERIALIZABLE_REVIEW_TRANSACTION,
} from '@/lib/idempotency';
import { prisma } from '@/lib/prisma';
import { isOpenFigurePath } from '@/lib/figures/open-figure-access';
import { questionSuppressionKey } from '@/lib/knowledge/variant-suppression';
import {
  cohortPromptMediaForQuestion,
  computeStep1QuestionContentHash,
  createStep1Session,
  isDeliverableStep1Question,
  Step1ApiError,
  type Step1DeliveryPayload,
  type Step1DeliveryRow,
  type Step1HistoryRow,
  type Step1SessionResult,
} from '@/lib/usmle/step1-session.server';
import {
  loadPublicUsmleQuestionCorpus,
  type PublicUsmleQuestion,
  type PublicUsmleQuestionCorpus,
} from '@/lib/usmle/public-question-corpus.server';
import { DIFFICULTY_TIERS, nextTier, normaliseDifficulty } from '@/lib/usmle/step1-adaptive';
import { COHORT_HOOK_V1_IDS } from './hook-playlist';
import { parseCohortFeedProfile, type CohortFeedProfile } from './feed-profile';
import { publicSessionPlan } from './public-session-plan';
import {
  questionMatchesCohortSearchTopic,
  resolveCohortSearchTopic,
  type CohortSearchTopicRegistryEntry,
} from './search-topic-registry.server';

const COHORT_SERVE_OPERATION = 'cohort_serve' as const;
const COHORT_DELIVERY_CONTRACT = 'usmle-step1-delivery-v3';
const COHORT_FOCUS_RECENT_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1_000;
const STEP1_MEDIA_MODALITIES = new Set([
  'photo', 'cxr', 'ct', 'mri', 'ecg', 'us',
  'otoscopy', 'fundoscopy', 'derm', 'histology', 'other',
]);

function isBoundedHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CohortTurnRequest {
  serveRequestId: string;
  journeyId: string;
  nextDrawOrdinal: number;
  previousDeliveryId?: string;
  timezone?: string;
  searchTopicId?: string;
}

export interface ServeCohortTurnInput extends CohortTurnRequest {
  userId: string;
  /** Test/transaction clock only; excluded from the immutable client fingerprint. */
  now?: Date;
}

export type CohortTurnAuthorization =
  | { ok: true }
  | { ok: false; retryAfterMs: number };

export type CohortTurnAuthorizationKind = 'new' | 'replay';

export interface ServeCohortTurnOptions {
  /**
   * Select a bounded new-turn or replay budget before opening the serializable
   * transaction. This avoids nested Prisma I/O while preserving a dedicated
   * retry allowance for lost-response recovery.
   */
  authorizeRequest?: (
    kind: CohortTurnAuthorizationKind,
  ) => CohortTurnAuthorization | Promise<CohortTurnAuthorization>;
}

export class CohortTurnError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CohortTurnError';
  }
}

export interface CohortSelectionPlan {
  stage: 'hook' | 'remediation' | 'search-focus' | 'discovery';
  questions: PublicUsmleQuestion[];
  turnSize: number;
  prependQuestionIds: string[];
  allowedDifficulties?: ReturnType<typeof publicSessionPlan>['allowedDifficulties'];
  adaptiveCandidatePreference?: ReturnType<typeof publicSessionPlan>['adaptiveCandidatePreference'];
  queueReason?: 'hook-v1' | 'same-concept-remediation' | 'search-focus';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ladderId(question: PublicUsmleQuestion | undefined): string | null {
  const tag = question?.topics.find((topic) => topic.startsWith('ladder:'));
  return tag?.slice('ladder:'.length) || null;
}

function latestHistory(history: readonly Step1HistoryRow[]): Step1HistoryRow | null {
  if (history.length === 0) return null;
  return history.reduce((current, candidate) => (
    candidate.createdAt >= current.createdAt ? candidate : current
  ));
}

/**
 * Apply the non-negotiable Cohort ordering before the shared Step 1 ranker:
 * fixed hook, then exact same-ladder remediation, then checked-in hard focus.
 */
export function buildCohortSelectionPlan(input: {
  questions: readonly PublicUsmleQuestion[];
  history: readonly Step1HistoryRow[];
  profile: CohortFeedProfile;
  searchTopic: CohortSearchTopicRegistryEntry | null;
  /** Exact answered predecessor wins over unrelated concurrent history. */
  previousOutcome?: { questionId: string; isCorrect: boolean };
  now?: Date;
}): CohortSelectionPlan {
  const questions = input.questions.filter(isDeliverableStep1Question);
  const profilePlan = publicSessionPlan(input.profile);

  if (!input.profile.hookCompletedAt) {
    const byId = new Set(questions.map((question) => question.id));
    if (COHORT_HOOK_V1_IDS.some((id) => !byId.has(id))) {
      throw new CohortTurnError(
        409,
        'hook_not_ready',
        'The fixed Cohort introduction is not currently available',
      );
    }
    return {
      stage: 'hook',
      questions,
      turnSize: COHORT_HOOK_V1_IDS.length,
      prependQuestionIds: [...COHORT_HOOK_V1_IDS],
      queueReason: 'hook-v1',
    };
  }

  const questionById = new Map(questions.map((question) => [question.id, question]));
  const latest = input.previousOutcome ?? latestHistory(input.history);
  const missed = latest?.isCorrect === false ? questionById.get(latest.questionId) : undefined;
  const missedLadder = ladderId(missed);
  if (missed && missedLadder) {
    const answered = new Set(input.history.map((row) => row.questionId));
    if (input.previousOutcome) answered.add(input.previousOutcome.questionId);
    const missedTier = normaliseDifficulty(missed.difficulty);
    const missedTierIndex = DIFFICULTY_TIERS.indexOf(missedTier);
    const target = nextTier(missedTier, false);
    const targetIndex = DIFFICULTY_TIERS.indexOf(target);
    const remediation = questions
      .filter((question) => (
        !answered.has(question.id)
        && ladderId(question) === missedLadder
        && DIFFICULTY_TIERS.indexOf(normaliseDifficulty(question.difficulty)) <= missedTierIndex
      ))
      .sort((a, b) => (
        Math.abs(DIFFICULTY_TIERS.indexOf(normaliseDifficulty(a.difficulty)) - targetIndex)
        - Math.abs(DIFFICULTY_TIERS.indexOf(normaliseDifficulty(b.difficulty)) - targetIndex)
        || a.id.localeCompare(b.id)
      ))[0];
    if (remediation) {
      return {
        stage: 'remediation',
        questions: [remediation],
        turnSize: 1,
        prependQuestionIds: [remediation.id],
        queueReason: 'same-concept-remediation',
      };
    }
  }

  if (input.searchTopic) {
    const allowed = new Set(profilePlan.allowedDifficulties);
    const recentAfter = (input.now ?? new Date()).getTime()
      - COHORT_FOCUS_RECENT_SUPPRESSION_MS;
    const recentIds = new Set<string>();
    const recentFamilies = new Set<string>();
    for (const row of input.history) {
      if (row.createdAt.getTime() < recentAfter) continue;
      recentIds.add(row.questionId);
      const recentQuestion = questionById.get(row.questionId);
      const family = recentQuestion
        ? questionSuppressionKey({
            variantGroupId: recentQuestion.variantGroupId,
            variantType: recentQuestion.variantType,
          })
        : null;
      if (family) recentFamilies.add(family);
    }
    if (input.previousOutcome) {
      recentIds.add(input.previousOutcome.questionId);
      const previousQuestion = questionById.get(input.previousOutcome.questionId);
      const previousFamily = previousQuestion
        ? questionSuppressionKey({
            variantGroupId: previousQuestion.variantGroupId,
            variantType: previousQuestion.variantType,
          })
        : null;
      if (previousFamily) recentFamilies.add(previousFamily);
    }
    const focused = questions.filter((question) => (
      questionMatchesCohortSearchTopic(question.topics, input.searchTopic!)
      && allowed.has(normaliseDifficulty(question.difficulty))
      && !recentIds.has(question.id)
      && !recentFamilies.has(questionSuppressionKey({
        variantGroupId: question.variantGroupId,
        variantType: question.variantType,
      }) ?? '')
    ));
    if (focused.length === 0) {
      throw new CohortTurnError(
        409,
        'topic_exhausted',
        'No eligible questions remain for this topic',
      );
    }
    return {
      stage: 'search-focus',
      questions: focused,
      turnSize: 1,
      prependQuestionIds: [],
      allowedDifficulties: profilePlan.allowedDifficulties,
      queueReason: 'search-focus',
    };
  }

  return {
    stage: 'discovery',
    questions,
    turnSize: 1,
    prependQuestionIds: [],
    allowedDifficulties: profilePlan.allowedDifficulties,
    adaptiveCandidatePreference: profilePlan.adaptiveCandidatePreference,
  };
}

export function buildCohortTurnFingerprint(
  input: CohortTurnRequest | ServeCohortTurnInput,
): string {
  return buildRequestFingerprint(COHORT_SERVE_OPERATION, `journey:${input.journeyId}`, {
    serveRequestId: input.serveRequestId,
    journeyId: input.journeyId,
    nextDrawOrdinal: input.nextDrawOrdinal,
    previousDeliveryId: input.previousDeliveryId ?? null,
    timezone: input.timezone ?? null,
    searchTopicId: input.searchTopicId ?? null,
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => key === actual[index]);
}

function parseFrozenSession(value: unknown): Step1SessionResult | null {
  if (!isRecord(value) || !exactKeys(value, [
    'sessionId', 'mode', 'requestedSize', 'deliveredSize', 'items',
  ])) return null;
  if (
    typeof value.sessionId !== 'string'
    || value.mode !== 'daily'
    || !Number.isSafeInteger(value.requestedSize)
    || !Number.isSafeInteger(value.deliveredSize)
    || !Array.isArray(value.items)
    || (value.requestedSize !== 1 && value.requestedSize !== COHORT_HOOK_V1_IDS.length)
    || value.deliveredSize !== value.requestedSize
    || value.deliveredSize !== value.items.length
  ) return null;

  for (const item of value.items) {
    if (!isRecord(item)) return null;
    const itemKeys = [
      'deliveryId', 'stem', 'options', 'domain', 'difficulty', 'questionType', 'attribution',
      ...('media' in item ? ['media'] : []),
    ];
    if (!exactKeys(item, itemKeys)) return null;
    if (
      typeof item.deliveryId !== 'string'
      || typeof item.stem !== 'string' || item.stem.length === 0
      || typeof item.domain !== 'string' || item.domain.length === 0
      || typeof item.difficulty !== 'string' || item.difficulty.length === 0
      || typeof item.questionType !== 'string' || item.questionType.length === 0
      || !Array.isArray(item.options)
      || item.options.length < 4
      || item.options.length > 26
      || !isRecord(item.attribution)
      || !exactKeys(item.attribution, ['text', 'licence'])
      || typeof item.attribution.text !== 'string'
      || typeof item.attribution.licence !== 'string'
    ) return null;
    for (let optionIndex = 0; optionIndex < item.options.length; optionIndex += 1) {
      const option = item.options[optionIndex];
      if (
        !isRecord(option)
        || !exactKeys(option, ['label', 'text'])
        || option.label !== String.fromCharCode(65 + optionIndex)
        || typeof option.text !== 'string'
        || option.text.length === 0
      ) return null;
    }
    if ('media' in item) {
      const media = item.media;
      if (!isRecord(media)) return null;
      const mediaKeys = [
        'imageUrl', 'preAnswerAlt', 'class', 'showWhen',
        'attributionText', 'licenseUrl',
        ...('sourcePageUrl' in media ? ['sourcePageUrl'] : []),
        ...('modality' in media ? ['modality'] : []),
      ];
      if (
        !exactKeys(media, mediaKeys)
        || typeof media.imageUrl !== 'string'
        || !isOpenFigurePath(media.imageUrl)
        || typeof media.preAnswerAlt !== 'string'
        || media.preAnswerAlt.trim().length === 0
        || (media.class !== 'diagnostic' && media.class !== 'diagram')
        || media.showWhen !== 'always'
        || typeof media.attributionText !== 'string'
        || media.attributionText.trim().length === 0
        || !isBoundedHttpsUrl(media.licenseUrl)
        || ('sourcePageUrl' in media && !isBoundedHttpsUrl(media.sourcePageUrl))
        || ('modality' in media && (
          typeof media.modality !== 'string' || !STEP1_MEDIA_MODALITIES.has(media.modality)
        ))
      ) return null;
    }
  }
  return value as unknown as Step1SessionResult;
}

function parseCohortDeliveryPayload(value: unknown): Pick<
  Step1DeliveryPayload,
  'contentHash' | 'servingFingerprint' | 'surface'
> | null {
  if (
    !isRecord(value)
    || value.contract !== COHORT_DELIVERY_CONTRACT
    || value.surface !== 'cohort'
    || typeof value.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value.servingFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.servingFingerprint)
  ) return null;
  return {
    surface: 'cohort',
    contentHash: value.contentHash,
    servingFingerprint: value.servingFingerprint,
  };
}

async function loadCorpusInTransaction(tx: Prisma.TransactionClient) {
  return loadPublicUsmleQuestionCorpus(tx as never);
}

async function assertReplayStillEligible(
  tx: Prisma.TransactionClient,
  userId: string,
  response: Step1SessionResult,
  now: Date,
): Promise<void> {
  const deliveryIds = response.items.map((item) => item.deliveryId);
  if (new Set(deliveryIds).size !== deliveryIds.length || deliveryIds.length === 0) {
    throw new CohortTurnError(503, 'serve_receipt_unavailable', 'Saved turn receipt is unavailable');
  }
  const deliveries = await tx.serveDecision.findMany({
    where: {
      id: { in: deliveryIds },
      userId,
      sessionId: response.sessionId,
      itemType: 'question',
      deliveryPath: 'live',
    },
    select: { id: true, itemId: true, payload: true },
  });
  if (deliveries.length !== deliveryIds.length) {
    throw new CohortTurnError(410, 'delivery_revoked', 'This delivery is no longer eligible');
  }

  const corpus = await loadCorpusInTransaction(tx);
  const currentById = new Map(
    corpus.questions
      .filter(isDeliverableStep1Question)
      .map((question) => [question.id, question]),
  );
  const frozenItemByDeliveryId = new Map(
    response.items.map((item) => [item.deliveryId, item]),
  );
  for (const delivery of deliveries) {
    const payload = parseCohortDeliveryPayload(delivery.payload);
    const question = currentById.get(delivery.itemId);
    const frozenItem = frozenItemByDeliveryId.get(delivery.id);
    const currentMedia = question
      ? cohortPromptMediaForQuestion(question, now)
      : undefined;
    if (
      !payload
      || !question
      || !frozenItem
      || payload.contentHash !== computeStep1QuestionContentHash(question)
      || payload.servingFingerprint !== question.releaseFingerprint
      || JSON.stringify(frozenItem.media ?? null) !== JSON.stringify(currentMedia ?? null)
    ) {
      throw new CohortTurnError(410, 'delivery_revoked', 'This delivery is no longer eligible');
    }
  }
}

function cohortSurfaceWhere(): Prisma.ServeDecisionWhereInput {
  return {
    itemType: 'question',
    deliveryPath: 'live',
    decisionPath: { in: ['usmle-step1-baseline-v1', 'usmle-step1-daily-v1'] },
    payload: { path: ['surface'], equals: 'cohort' },
  };
}

async function transactCohortTurn(
  tx: Prisma.TransactionClient,
  input: ServeCohortTurnInput,
  requestFingerprint: string,
): Promise<{ response: Step1SessionResult; deduped: boolean }> {
  const now = input.now ?? new Date();
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE
  `;
  if (locked.length === 0) {
    throw new CohortTurnError(404, 'cohort_identity_not_found', 'Cohort identity not found');
  }

  const existing = await tx.syncOperation.findUnique({
    where: {
      userId_clientOperationId: {
        userId: input.userId,
        clientOperationId: input.serveRequestId,
      },
    },
    select: {
      operationType: true,
      status: true,
      requestFingerprint: true,
      result: true,
    },
  });
  if (existing) {
    if (
      existing.operationType !== COHORT_SERVE_OPERATION
      || existing.requestFingerprint !== requestFingerprint
    ) {
      throw new CohortTurnError(
        409,
        'serve_request_conflict',
        'serveRequestId was already used for a different request',
      );
    }
    if (existing.status !== 'completed') {
      throw new CohortTurnError(
        503,
        'serve_request_pending',
        'This turn is still being recorded; retry with the same serveRequestId',
      );
    }
    const response = parseFrozenSession(existing.result);
    if (!response || response.sessionId !== input.journeyId) {
      throw new CohortTurnError(503, 'serve_receipt_unavailable', 'Saved turn receipt is unavailable');
    }
    await assertReplayStillEligible(tx, input.userId, response, now);
    return { response, deduped: true };
  }

  const searchTopic = input.searchTopicId
    ? resolveCohortSearchTopic(input.searchTopicId)
    : null;
  // A matching frozen replay above is independent of current policy/registry
  // state. An idempotency miss must still resolve before any delivery write.
  if (input.searchTopicId && !searchTopic) {
    throw new CohortTurnError(400, 'invalid_search_topic', 'Search topic is invalid');
  }

  const operation = await tx.syncOperation.create({
    data: {
      userId: input.userId,
      clientOperationId: input.serveRequestId,
      operationType: COHORT_SERVE_OPERATION,
      status: 'pending',
      requestFingerprint,
    },
    select: { id: true },
  });

  const lastDelivery = await tx.serveDecision.findFirst({
    where: {
      userId: input.userId,
      sessionId: input.journeyId,
      ...cohortSurfaceWhere(),
    },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const currentOrdinal = lastDelivery == null
    ? 0
    : Number.isSafeInteger(lastDelivery.position) && lastDelivery.position! >= 0
      ? lastDelivery.position! + 1
      : null;
  if (currentOrdinal == null) {
    throw new CohortTurnError(503, 'journey_receipt_unavailable', 'Journey receipt is unavailable');
  }
  if (input.nextDrawOrdinal !== currentOrdinal) {
    throw new CohortTurnError(
      409,
      'journey_ordinal_conflict',
      'Journey ordinal is stale',
      { currentOrdinal },
    );
  }

  let previousOutcome: { questionId: string; isCorrect: boolean } | undefined;
  if (input.nextDrawOrdinal === 0 && input.previousDeliveryId) {
    throw new CohortTurnError(
      409,
      'invalid_previous_delivery',
      'The first journey turn cannot have a previous delivery',
    );
  }
  if (input.nextDrawOrdinal > 0) {
    if (!input.previousDeliveryId) {
      throw new CohortTurnError(
        409,
        'invalid_previous_delivery',
        'A continued journey requires its previous delivery',
      );
    }
    const previous = await tx.serveDecision.findFirst({
      where: { id: input.previousDeliveryId, userId: input.userId },
      select: {
        id: true,
        userId: true,
        sessionId: true,
        position: true,
        itemId: true,
        answeredAt: true,
        isCorrect: true,
        payload: true,
      },
    });
    if (
      !previous
      || previous.sessionId !== input.journeyId
      || previous.position !== input.nextDrawOrdinal - 1
      || !previous.answeredAt
      || typeof previous.isCorrect !== 'boolean'
      || !parseCohortDeliveryPayload(previous.payload)
    ) {
      throw new CohortTurnError(
        409,
        'invalid_previous_delivery',
        'Previous delivery is not the answered prior draw in this journey',
      );
    }
    const unansweredEarlierDeliveries = await tx.serveDecision.count({
      where: {
        userId: input.userId,
        sessionId: input.journeyId,
        position: { gte: 0, lt: input.nextDrawOrdinal },
        answeredAt: null,
        ...cohortSurfaceWhere(),
      },
    });
    if (unansweredEarlierDeliveries > 0) {
      throw new CohortTurnError(
        409,
        'incomplete_previous_deliveries',
        'Every earlier delivery in this journey must be answered before continuing',
      );
    }
    previousOutcome = {
      questionId: previous.itemId,
      isCorrect: previous.isCorrect,
    };
  }

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { feedProfile: true },
  });
  if (!user) {
    throw new CohortTurnError(404, 'cohort_identity_not_found', 'Cohort identity not found');
  }
  const profile = parseCohortFeedProfile(user.feedProfile);
  const corpus = await loadCorpusInTransaction(tx);
  const questionIds = corpus.questions.map((question) => question.id);
  const history = questionIds.length === 0
    ? []
    : await tx.questionResponse.findMany({
        where: { userId: input.userId, questionId: { in: questionIds } },
        select: {
          questionId: true,
          isCorrect: true,
          createdAt: true,
          sessionType: true,
        },
        orderBy: { createdAt: 'asc' },
      });
  const selection = buildCohortSelectionPlan({
    questions: corpus.questions,
    history,
    profile,
    searchTopic,
    previousOutcome,
    now,
  });
  const selectedIds = new Set(selection.questions.map((question) => question.id));
  const selectedHistory = history.filter((row) => selectedIds.has(row.questionId));
  const selectedCorpus: PublicUsmleQuestionCorpus = {
    questions: selection.questions,
    decisions: corpus.decisions,
  };

  let created;
  try {
    created = await createStep1Session({
      userId: input.userId,
      mode: 'daily',
      size: selection.turnSize,
      now,
      surface: 'cohort',
      sessionId: input.journeyId,
      positionOffset: input.nextDrawOrdinal,
      prependQuestionIds: selection.prependQuestionIds,
      ...(selection.queueReason === 'same-concept-remediation'
        ? { prependQueueReason: 'same-concept-remediation' as const }
        : {}),
      ...(selection.queueReason === 'search-focus'
        ? { queueReasonOverride: 'search-focus' as const }
        : {}),
      ...(selection.allowedDifficulties
        ? { allowedDifficulties: selection.allowedDifficulties }
        : {}),
      ...(selection.adaptiveCandidatePreference
        ? { adaptiveCandidatePreference: selection.adaptiveCandidatePreference }
        : {}),
      preferAdaptiveUnseen: true,
    }, {
      loadCorpus: async () => selectedCorpus,
      loadHistory: async (_userId, ids) => {
        const allowedIds = new Set(ids);
        return selectedHistory.filter((row) => allowedIds.has(row.questionId));
      },
      persistDeliveries: async (rows: Step1DeliveryRow[]) => {
        const persistedRows = selection.stage === 'search-focus' && input.searchTopicId
          ? rows.map((row) => ({
              ...row,
              payload: {
                ...row.payload,
                searchTopicId: input.searchTopicId,
              },
            }))
          : rows;
        const written = await tx.serveDecision.createMany({ data: persistedRows });
        if (written.count !== rows.length) {
          throw new Error(`ServeDecision batch mismatch: expected ${rows.length}, wrote ${written.count}`);
        }
        return written.count;
      },
    });
  } catch (error) {
    if (error instanceof Step1ApiError) {
      if (selection.stage === 'search-focus' && (
        error.code === 'corpus_not_ready' || error.code === 'baseline_not_ready'
      )) {
        throw new CohortTurnError(
          409,
          'topic_exhausted',
          'No eligible questions remain for this topic',
        );
      }
      throw new CohortTurnError(error.status, error.code, error.message);
    }
    throw error;
  }

  const response: Step1SessionResult = {
    sessionId: created.sessionId,
    mode: created.mode,
    requestedSize: created.requestedSize,
    deliveredSize: created.deliveredSize,
    items: created.items,
  };
  if (
    response.sessionId !== input.journeyId
    || response.deliveredSize !== selection.turnSize
    || response.items.length !== selection.turnSize
  ) {
    throw new CohortTurnError(
      503,
      'delivery_persistence_failed',
      'Could not safely record this delivery; please retry',
    );
  }
  if (input.previousDeliveryId) {
    await tx.learningEvent.create({
      data: {
        userId: input.userId,
        eventType: 'cohort_continue',
        sourceType: 'delivery',
        sourceId: input.previousDeliveryId,
        clientOperationId: `cohort:${input.previousDeliveryId}:continue-fulfilled:v1`,
        conceptIds: [],
        metadata: {
          schemaVersion: 1,
          surface: 'cohort',
          journeyId: input.journeyId,
          previousDrawOrdinal: input.nextDrawOrdinal - 1,
          nextDrawOrdinal: input.nextDrawOrdinal,
        },
        timestamp: now,
        receivedAt: now,
      },
      select: { id: true },
    });
  }
  await tx.syncOperation.update({
    where: { id: operation.id },
    data: {
      status: 'completed',
      result: response as unknown as Prisma.InputJsonValue,
    },
  });
  return { response, deduped: false };
}

export async function serveCohortTurn(
  input: ServeCohortTurnInput,
  options: ServeCohortTurnOptions = {},
): Promise<{ response: Step1SessionResult; deduped: boolean }> {
  const requestFingerprint = buildCohortTurnFingerprint(input);
  if (options.authorizeRequest) {
    const operation = await prisma.syncOperation.findUnique({
      where: {
        userId_clientOperationId: {
          userId: input.userId,
          clientOperationId: input.serveRequestId,
        },
      },
      select: {
        operationType: true,
        status: true,
        requestFingerprint: true,
      },
    });
    let authorizationKind: CohortTurnAuthorizationKind = operation
      && operation.operationType === COHORT_SERVE_OPERATION
      && operation.status === 'completed'
      && operation.requestFingerprint === requestFingerprint
      ? 'replay'
      : 'new';
    let authorization = await options.authorizeRequest(authorizationKind);
    // Close the narrow race where a request becomes a completed replay after
    // the preflight read but before a depleted new-turn budget responds.
    if (!authorization.ok && authorizationKind === 'new') {
      const completed = await prisma.syncOperation.findUnique({
        where: {
          userId_clientOperationId: {
            userId: input.userId,
            clientOperationId: input.serveRequestId,
          },
        },
        select: {
          operationType: true,
          status: true,
          requestFingerprint: true,
        },
      });
      if (
        completed?.operationType === COHORT_SERVE_OPERATION
        && completed.status === 'completed'
        && completed.requestFingerprint === requestFingerprint
      ) {
        authorizationKind = 'replay';
        authorization = await options.authorizeRequest(authorizationKind);
      }
    }
    if (!authorization.ok) {
      throw new CohortTurnError(
        429,
        'rate_limited',
        'Too many requests',
        { retryAfterMs: authorization.retryAfterMs },
      );
    }
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= REVIEW_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        (tx) => transactCohortTurn(
          tx as unknown as Prisma.TransactionClient,
          input,
          requestFingerprint,
        ),
        SERIALIZABLE_REVIEW_TRANSACTION,
      );
    } catch (error) {
      lastError = error;
      if (error instanceof CohortTurnError || !isRetryableReviewTransactionError(error)) {
        throw error;
      }
      if (attempt === REVIEW_TRANSACTION_MAX_ATTEMPTS) throw error;
    }
  }
  throw lastError ?? new Error('Cohort turn transaction failed');
}
