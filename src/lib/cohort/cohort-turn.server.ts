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
} from '@/lib/usmle/step1-session.server';
import {
  type PublicUsmleQuestion,
  type PublicUsmleQuestionCorpus,
} from '@/lib/usmle/public-question-corpus.server';
import { randomUUID } from 'node:crypto';
import { COHORT_MODULE_ROTATION } from '@/lib/content/cohort-mirror';
import { loadCohortServableCorpus } from './module-question-corpus.server';
import {
  COHORT_CARD_DECISION_PATH,
  COHORT_CARD_DELIVERY_CONTRACT,
  isCohortCardSessionItem,
  parseCohortCardSessionItem,
  type CohortCardSessionItem,
  type CohortTurnResult,
} from './card-turn-contract';
import {
  loadCohortModuleCardCorpus,
  selectCohortModuleCard,
  COHORT_CARD_RELEASE_LOADABLE,
  type CohortServableCard,
} from './module-card-corpus.server';
import { DIFFICULTY_TIERS, nextTier, normaliseDifficulty } from '@/lib/usmle/step1-adaptive';
import { COHORT_HOOK_V1_IDS } from './hook-playlist';
import { parseCohortFeedProfile, type CohortFeedProfile } from './feed-profile';
import { publicSessionPlan } from './public-session-plan';
import {
  demonstratedCohortGapTopics,
  isCohortHardGapQuestion,
  type CohortReviewChallengeLevel,
} from './cohort-review-challenge';
import {
  questionMatchesCohortSearchTopic,
  resolveCohortSearchTopic,
  type CohortSearchTopicRegistryEntry,
  COHORT_SEARCH_TOPIC_REGISTRY,
} from './search-topic-registry.server';
import { parseCohortChallengeExhaustion } from './card-turn-contract';
import { reviewChallengePreference } from '@/lib/study/review-challenge-preference';

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
  reviewChallengeLevel?: CohortReviewChallengeLevel;
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
  reviewChallengeLevel?: CohortReviewChallengeLevel;
  servedQuestionIds?: ReadonlySet<string>;
}): CohortSelectionPlan {
  const deliverable = input.questions.filter(isDeliverableStep1Question);
  // The mirrored md3 modules are served only when their topic is chosen: never
  // in the Step 1 feed, never under a Step 1 tag that happens to overlap.
  const moduleNode = input.searchTopic && 'moduleNode' in input.searchTopic
    ? input.searchTopic.moduleNode
    : null;
  const step1Questions = deliverable.filter((question) => question.rotation !== COHORT_MODULE_ROTATION);
  const questions = moduleNode
    ? deliverable.filter((question) => questionMatchesCohortSearchTopic(question, input.searchTopic!))
    : step1Questions;
  const profilePlan = publicSessionPlan(input.profile);
  const challengeLevel = input.reviewChallengeLevel ?? 0;
  const challengeAllowed: typeof profilePlan.allowedDifficulties = challengeLevel === -1
    ? ['easy']
    : challengeLevel === 1
      ? ['medium', 'hard']
      : profilePlan.allowedDifficulties;
  const answeredIds = new Set(input.history.map((row) => row.questionId));
  for (const id of input.servedQuestionIds ?? []) answeredIds.add(id);
  const challengeQuestions = input.searchTopic
    ? questions.filter((question) => questionMatchesCohortSearchTopic(question, input.searchTopic!))
    : questions;
  const gapTopics = demonstratedCohortGapTopics({ questions: challengeQuestions, history: input.history, now: input.now ?? new Date() });
  if (challengeLevel === 2 && input.profile.hookCompletedAt) {
    const hardGap = challengeQuestions.filter((question) => isCohortHardGapQuestion({ question, gapTopics, answeredIds }));
    if (hardGap.length === 0) {
      throw new CohortTurnError(409, 'review_challenge_exhausted', 'No eligible hard questions remain', {
        reviewChallengeLevel: 2,
      });
    }
    return {
      stage: 'discovery', questions: hardGap, turnSize: 1, prependQuestionIds: [],
      allowedDifficulties: ['hard'], reviewChallengeLevel: 2,
    };
  }

  if (!input.profile.hookCompletedAt) {
    const byId = new Set(step1Questions.map((question) => question.id));
    if (COHORT_HOOK_V1_IDS.some((id) => !byId.has(id))) {
      throw new CohortTurnError(
        409,
        'hook_not_ready',
        'The fixed Cohort introduction is not currently available',
      );
    }
    return {
      stage: 'hook',
      questions: step1Questions,
      turnSize: COHORT_HOOK_V1_IDS.length,
      prependQuestionIds: [...COHORT_HOOK_V1_IDS],
      queueReason: 'hook-v1',
      reviewChallengeLevel: challengeLevel,
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
        reviewChallengeLevel: challengeLevel,
      };
    }
  }

  if (input.searchTopic) {
    const allowed = new Set(challengeAllowed);
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
      questionMatchesCohortSearchTopic(question, input.searchTopic!)
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
      allowedDifficulties: challengeAllowed,
      queueReason: 'search-focus',
      reviewChallengeLevel: challengeLevel,
    };
  }

  return {
    stage: 'discovery',
    questions,
    turnSize: 1,
    prependQuestionIds: [],
    allowedDifficulties: challengeAllowed,
    adaptiveCandidatePreference: profilePlan.adaptiveCandidatePreference,
    reviewChallengeLevel: challengeLevel,
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

function parseFrozenSession(value: unknown): CohortTurnResult | null {
  if (!isRecord(value) || !exactKeys(value, [
    'sessionId', 'mode', 'requestedSize', 'deliveredSize', 'items',
    ...('reviewChallengeExhausted' in value ? ['reviewChallengeExhausted'] : []),
  ])) return null;
  if (
    typeof value.sessionId !== 'string'
    || value.mode !== 'daily'
    || !Number.isSafeInteger(value.requestedSize)
    || !Number.isSafeInteger(value.deliveredSize)
    || !Array.isArray(value.items)
    || (value.requestedSize !== 1 && value.requestedSize !== COHORT_HOOK_V1_IDS.length)
    || (value.deliveredSize !== value.requestedSize
      && !(value.requestedSize === 1 && value.deliveredSize === 0
        && parseCohortChallengeExhaustion(value.reviewChallengeExhausted)))
    || ('reviewChallengeExhausted' in value && (value.deliveredSize !== 0
      || !parseCohortChallengeExhaustion(value.reviewChallengeExhausted)))
    || value.deliveredSize !== value.items.length
  ) return null;

  if (value.deliveredSize === 0) return value as unknown as CohortTurnResult;
  for (const item of value.items) {
    if (!isRecord(item)) return null;
    if (isCohortCardSessionItem(item)) {
      if (!parseCohortCardSessionItem(item)) return null;
      continue;
    }
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
  return value as unknown as CohortTurnResult;
}

type CohortDeliveryKind = 'question' | 'card';

function parseCohortDeliveryPayload(value: unknown): (Pick<
  Step1DeliveryPayload,
  'contentHash' | 'servingFingerprint' | 'surface'
> & { kind: CohortDeliveryKind; discipline?: string }) | null {
  const kind: CohortDeliveryKind | null = isRecord(value)
    ? value.contract === COHORT_DELIVERY_CONTRACT ? 'question'
      : value.contract === COHORT_CARD_DELIVERY_CONTRACT ? 'card' : null
    : null;
  if (
    !isRecord(value)
    || !kind
    || (kind === 'card' && (typeof value.discipline !== 'string' || !/^[a-z-]+$/.test(value.discipline)))
    || value.surface !== 'cohort'
    || typeof value.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.contentHash)
    || typeof value.servingFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.servingFingerprint)
  ) return null;
  return {
    kind,
    surface: 'cohort',
    contentHash: value.contentHash,
    servingFingerprint: value.servingFingerprint,
    ...(kind === 'card' ? { discipline: value.discipline as string } : {}),
  };
}

async function loadCorpusInTransaction(tx: Prisma.TransactionClient) {
  return loadCohortServableCorpus(tx as never);
}

async function assertReplayStillEligible(
  tx: Prisma.TransactionClient,
  userId: string,
  response: CohortTurnResult,
  now: Date,
): Promise<void> {
  if (response.items.length === 0) {
    if (response.requestedSize !== 1 || response.deliveredSize !== 0
      || !parseCohortChallengeExhaustion(response.reviewChallengeExhausted)) {
      throw new CohortTurnError(503, 'serve_receipt_unavailable', 'Saved turn receipt is unavailable');
    }
    return;
  }
  const deliveryIds = response.items.map((item) => item.deliveryId);
  if (new Set(deliveryIds).size !== deliveryIds.length || deliveryIds.length === 0) {
    throw new CohortTurnError(503, 'serve_receipt_unavailable', 'Saved turn receipt is unavailable');
  }
  const deliveries = await tx.serveDecision.findMany({
    where: {
      id: { in: deliveryIds },
      userId,
      sessionId: response.sessionId,
      itemType: { in: ['question', 'card'] },
      deliveryPath: 'live',
    },
    select: { id: true, itemId: true, itemType: true, payload: true },
  });
  if (deliveries.length !== deliveryIds.length) {
    throw new CohortTurnError(410, 'delivery_revoked', 'This delivery is no longer eligible');
  }

  const frozenById = new Map(response.items.map((item) => [item.deliveryId, item]));
  const cardDeliveries = deliveries.filter((delivery) => delivery.itemType === 'card');
  for (const delivery of cardDeliveries) {
    const payload = parseCohortDeliveryPayload(delivery.payload);
    const frozen = frozenById.get(delivery.id);
    const card = payload?.kind === 'card' && payload.discipline
      ? (await loadCohortModuleCardCorpus(tx as never, payload.discipline)).cards.find((c) => c.id === delivery.itemId)
      : undefined;
    if (
      !payload || payload.kind !== 'card' || !card || !frozen || !isCohortCardSessionItem(frozen)
      || payload.contentHash !== card.contentHash
      || payload.servingFingerprint !== card.releaseFingerprint
    ) {
      throw new CohortTurnError(410, 'delivery_revoked', 'This delivery is no longer eligible');
    }
  }
  const questionDeliveries = deliveries.filter((delivery) => delivery.itemType !== 'card');
  if (questionDeliveries.length === 0) return;

  const corpus = await loadCorpusInTransaction(tx);
  const currentById = new Map(
    corpus.questions
      .filter(isDeliverableStep1Question)
      .map((question) => [question.id, question]),
  );
  for (const delivery of questionDeliveries) {
    const payload = parseCohortDeliveryPayload(delivery.payload);
    const question = currentById.get(delivery.itemId);
    const frozen = frozenById.get(delivery.id);
    const frozenItem = frozen && !isCohortCardSessionItem(frozen) ? frozen : undefined;
    const currentMedia = question
      ? cohortPromptMediaForQuestion(question, now)
      : undefined;
    if (
      !payload
      || payload.kind !== 'question'
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
    itemType: { in: ['question', 'card'] },
    deliveryPath: 'live',
    decisionPath: { in: ['usmle-step1-baseline-v1', 'usmle-step1-daily-v1', COHORT_CARD_DECISION_PATH] },
    payload: { path: ['surface'], equals: 'cohort' },
  };
}

async function transactCohortTurn(
  tx: Prisma.TransactionClient,
  input: ServeCohortTurnInput,
  requestFingerprint: string,
): Promise<{ response: CohortTurnResult; deduped: boolean }> {
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
  let previousKind: CohortDeliveryKind | undefined;
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
    previousKind = parseCohortDeliveryPayload(previous.payload)!.kind;
    // A card's outcome is self-rated recall; only a question drives remediation.
    if (previousKind === 'question') {
      previousOutcome = {
        questionId: previous.itemId,
        isCorrect: previous.isCorrect,
      };
    }
  }

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { feedProfile: true, reviewChallenge: true, reviewChallengeRevision: true },
  });
  if (!user) {
    throw new CohortTurnError(404, 'cohort_identity_not_found', 'Cohort identity not found');
  }
  const profile = parseCohortFeedProfile(user.feedProfile);
  const preference = reviewChallengePreference(user);
  const reviewChallengeLevel = preference.level;

  // A chosen module alternates its questions with its cards: a card after a
  // question, a question after a card, each falling back to the other when its
  // pool is spent. The fixed hook always comes first.
  const moduleNode = searchTopic && 'moduleNode' in searchTopic ? searchTopic.moduleNode : null;
  if (reviewChallengeLevel === -2 && searchTopic && !moduleNode && profile.hookCompletedAt) {
    throw new CohortTurnError(409, 'review_challenge_exhausted', 'No scaffold cards match this focus', {
      reviewChallengeLevel: -2,
    });
  }
  const cardTurn = profile.hookCompletedAt && reviewChallengeLevel !== 2 && (moduleNode || reviewChallengeLevel === -2)
    ? () => pickModuleCard(tx, input, moduleNode ?? undefined, now, reviewChallengeLevel)
    : null;
  const pickedCardTopic = (card: CohortServableCard) => searchTopic ?? topicForDiscipline(card.discipline);
  if (cardTurn && (previousKind === 'question' || reviewChallengeLevel === -2)) {
    const picked = await cardTurn();
    if (picked) {
      const topic = pickedCardTopic(picked);
      if (!topic) throw new CohortTurnError(503, 'cohort_card_topic_unavailable', 'Card topic is unavailable');
      const response = await deliverModuleCard(tx, input, picked, topic, now);
      return finishCohortTurn(tx, input, operation.id, response, now);
    }
    if (reviewChallengeLevel === -2) {
      throw new CohortTurnError(409, 'review_challenge_exhausted', 'No eligible scaffold cards remain', {
        reviewChallengeLevel: -2,
      });
    }
  } else if (reviewChallengeLevel === -2 && profile.hookCompletedAt) {
    throw new CohortTurnError(409, 'review_challenge_exhausted', 'No eligible scaffold cards remain', {
      reviewChallengeLevel: -2,
    });
  }

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
  // The public selector already has its answer history. Only the hard lane
  // needs the additional delivered-but-unanswered exclusion; fail closed if
  // that bounded read cannot represent the complete released pool.
  const servedQuestionRows = reviewChallengeLevel === 2 && questionIds.length > 0
    ? await tx.serveDecision.findMany({
        where: { userId: input.userId, ...cohortSurfaceWhere(), itemType: 'question', itemId: { in: questionIds } },
        select: { itemId: true },
        orderBy: { id: 'asc' },
        take: 20_001,
      })
    : [];
  if (servedQuestionRows.length > 20_000) {
    throw new CohortTurnError(503, 'cohort_challenge_unavailable', 'Hard-question history is temporarily unavailable');
  }
  let selection: CohortSelectionPlan;
  try {
    selection = buildCohortSelectionPlan({
      questions: corpus.questions,
      history,
      profile,
      searchTopic,
      previousOutcome,
      now,
      reviewChallengeLevel,
      servedQuestionIds: new Set(servedQuestionRows.map((row) => row.itemId)),
    });
  } catch (error) {
    if (error instanceof CohortTurnError && error.code === 'review_challenge_exhausted'
      && reviewChallengeLevel === 2) {
      const response: CohortTurnResult = {
        sessionId: input.journeyId,
        mode: 'daily',
        requestedSize: 1,
        deliveredSize: 0,
        items: [],
        reviewChallengeExhausted: preference,
      };
      const demandQuestions = corpus.questions.filter((question) => isDeliverableStep1Question(question)
        && (searchTopic ? questionMatchesCohortSearchTopic(question, searchTopic) : question.rotation !== COHORT_MODULE_ROTATION));
      const gapTopics = demonstratedCohortGapTopics({ questions: demandQuestions, history, now });
      if (gapTopics.size > 0) {
        const answered = new Set([...history.map((row) => row.questionId), ...servedQuestionRows.map((row) => row.itemId)]);
        const counts = new Map<string, number>();
        for (const question of demandQuestions) {
          if (question.difficulty !== 'hard' || answered.has(question.id)) continue;
          for (const topic of question.topics) {
            if (gapTopics.has(topic)) counts.set(topic, (counts.get(topic) ?? 0) + 1);
          }
        }
        const demandTopics = [...gapTopics].map((topic) => ({
          topic,
          unseenHard: counts.get(topic) ?? 0,
          targetUnseenHard: 15,
          deficit: Math.max(0, 15 - (counts.get(topic) ?? 0)),
        })).filter((entry) => entry.deficit > 0);
        // Bound each marker to the consumer's validated envelope. Chunking
        // preserves every topic instead of silently dropping a large gap set.
        for (let start = 0; start < demandTopics.length; start += 32) await tx.feedEvent.create({
          data: {
            userId: input.userId,
            eventType: 'content_demand',
            itemId: 'cohort-review-challenge-v1',
            itemType: 'review-challenge',
            metadata: {
              schemaVersion: 1,
              surface: 'cohort',
              topics: demandTopics.slice(start, start + 32),
            },
            timestamp: now,
          },
          select: { id: true },
        });
      }
      return finishCohortTurn(tx, input, operation.id, response, now);
    }
    const picked = error instanceof CohortTurnError && error.code === 'topic_exhausted' && reviewChallengeLevel !== 2 && cardTurn
      ? await cardTurn()
      : null;
    if (!picked) throw error;
    const topic = pickedCardTopic(picked);
    if (!topic) throw new CohortTurnError(503, 'cohort_card_topic_unavailable', 'Card topic is unavailable');
    const response = await deliverModuleCard(tx, input, picked, topic, now);
    return finishCohortTurn(tx, input, operation.id, response, now);
  }
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
        const picked = cardTurn ? await cardTurn() : null;
        if (picked) {
          const topic = pickedCardTopic(picked);
          if (!topic) throw new CohortTurnError(503, 'cohort_card_topic_unavailable', 'Card topic is unavailable');
          const response = await deliverModuleCard(tx, input, picked, topic, now);
          return finishCohortTurn(tx, input, operation.id, response, now);
        }
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

  const response: CohortTurnResult = {
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
  return finishCohortTurn(tx, input, operation.id, response, now);
}

/** The shared tail of every new turn: the Continue event, then the frozen receipt. */
async function finishCohortTurn(
  tx: Prisma.TransactionClient,
  input: ServeCohortTurnInput,
  operationId: string,
  response: CohortTurnResult,
  now: Date,
): Promise<{ response: CohortTurnResult; deduped: boolean }> {
  if (input.previousDeliveryId && response.deliveredSize > 0) {
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
    where: { id: operationId },
    data: {
      status: 'completed',
      result: response as unknown as Prisma.InputJsonValue,
    },
  });
  return { response, deduped: false };
}

/** The module's display name, without the guideline suffix the topic label carries. */
function moduleDomain(topic: CohortSearchTopicRegistryEntry): string {
  return topic.label.replace(/\s*\(Australian guidelines\)$/, '');
}

function topicForDiscipline(discipline: string): CohortSearchTopicRegistryEntry | null {
  return COHORT_SEARCH_TOPIC_REGISTRY.find((topic) => 'moduleNode' in topic && topic.moduleNode === `cohort/${discipline}`) ?? null;
}

/**
 * The next card for this learner in this module, or null. Reads one
 * discipline's released cards and this learner's progress on exactly those
 * cards, both indexed; the cards served in this journey's last few draws are
 * held back so a just-failed card or its sibling never comes straight back.
 */
async function pickModuleCard(
  tx: Prisma.TransactionClient,
  input: ServeCohortTurnInput,
  moduleNode: string | undefined,
  now: Date,
  challengeLevel: CohortReviewChallengeLevel,
): Promise<CohortServableCard | null> {
  if (!COHORT_CARD_RELEASE_LOADABLE) {
    throw new CohortTurnError(503, 'cohort_scaffold_unavailable', 'Scaffold release is unavailable');
  }
  const discipline = moduleNode?.slice('cohort/'.length);
  const safeDisciplines = new Set(COHORT_SEARCH_TOPIC_REGISTRY.flatMap((topic) => (
    'moduleNode' in topic ? [topic.moduleNode.slice('cohort/'.length)] : []
  )));
  const loaded = await loadCohortModuleCardCorpus(tx as never, discipline);
  const cards = discipline ? loaded.cards : loaded.cards.filter((card) => safeDisciplines.has(card.discipline));
  if (cards.length === 0) return null;
  const [progress, recent] = await Promise.all([
    tx.cardProgress.findMany({
      where: { userId: input.userId, cardId: { in: cards.map((card) => card.id) } },
      select: { cardId: true, nextDueAt: true },
    }),
    tx.serveDecision.findMany({
      where: {
        userId: input.userId,
        sessionId: input.journeyId,
        itemType: 'card',
        decisionPath: COHORT_CARD_DECISION_PATH,
      },
      orderBy: { position: 'desc' },
      take: 5,
      select: { itemId: true },
    }),
  ]);
  const recentCardIds = recent.map((row) => row.itemId);
  const recentGroups = new Set(cards
    .filter((card) => recentCardIds.includes(card.id) && card.variantGroupId)
    .map((card) => card.variantGroupId!));
  return selectCohortModuleCard({
    cards, progress, recentCardIds, recentGroups, now,
    challengeLevel,
  })?.card ?? null;
}


async function deliverModuleCard(
  tx: Prisma.TransactionClient,
  input: ServeCohortTurnInput,
  card: CohortServableCard,
  topic: CohortSearchTopicRegistryEntry,
  now: Date,
): Promise<CohortTurnResult> {
  const deliveryId = randomUUID();
  const written = await tx.serveDecision.createMany({
    data: [{
      id: deliveryId,
      userId: input.userId,
      sessionId: input.journeyId,
      batchId: input.journeyId,
      itemType: 'card',
      itemId: card.id,
      rotation: COHORT_MODULE_ROTATION,
      week: null,
      decidedAt: now,
      exposedAt: now,
      decisionPath: COHORT_CARD_DECISION_PATH,
      deliveryPath: 'live',
      queueReason: 'search-focus',
      position: input.nextDrawOrdinal,
      rankInPool: 0,
      poolSize: 1,
      difficultyTier: null,
      variantGroupId: card.variantGroupId,
      variantType: card.variantGroupId ? 'cloze-blank' : null,
      summary: 'Cohort module card delivery',
      payload: {
        contract: COHORT_CARD_DELIVERY_CONTRACT,
        surface: 'cohort',
        discipline: card.discipline,
        contentHash: card.contentHash,
        servingFingerprint: card.releaseFingerprint,
        ...(input.searchTopicId ? { searchTopicId: input.searchTopicId } : {}),
      },
    }],
  });
  if (written.count !== 1) {
    throw new CohortTurnError(503, 'delivery_persistence_failed', 'Could not safely record this delivery; please retry');
  }
  const item: CohortCardSessionItem = {
    deliveryId,
    kind: 'card',
    front: card.front,
    back: card.back,
    context: card.context,
    domain: moduleDomain(topic),
    attribution: { text: 'MD3 contributors', licence: 'CC-BY-4.0' },
  };
  return { sessionId: input.journeyId, mode: 'daily', requestedSize: 1, deliveredSize: 1, items: [item] };
}

export async function serveCohortTurn(
  input: ServeCohortTurnInput,
  options: ServeCohortTurnOptions = {},
): Promise<{ response: CohortTurnResult; deduped: boolean }> {
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
