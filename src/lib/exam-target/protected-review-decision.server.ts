import 'server-only';

import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import {
  writeLiveExamTargetServeDecisions,
  writeLiveServeDecisions,
  type AtomicServeDecisionWriterClient,
  type LiveWriteCtx,
} from '@/lib/study/serve-decision-write';
import type { UnifiedItem } from '@/lib/study/unified-session-types';
import { hashExamTargetArtifact } from './artifact';
import { loadExamTargetDecisionTokenizer } from './decision-hmac.server';
import {
  buildExamTargetDecisionTelemetry,
  type ExamTargetDecisionCandidate,
} from './decision-set';
import type {
  ExamTargetDecisionPersistenceClient,
  ExamTargetDecisionTransaction,
  ExamTargetDecisionSetWriteInput,
  ExamTargetPersistedSourcePolicy,
  ExamTargetServeItemTelemetryInput,
  PersistExamTargetDecisionSetInput,
} from './decision-set-persistence.server';
import { persistExamTargetDecisionSet } from './decision-set-persistence.server';
import type { RuntimeExamTargetContext } from './repository.server';
import {
  YEAR3_EXAM_TARGET_ROTATIONS,
  type ExamTargetRotation,
} from './types';
import {
  terminalizeExamTargetDecisionAttempt,
  type ExamTargetAttemptFailureClass,
  type ExamTargetAttemptLedgerClient,
  type TerminalizeExamTargetAttemptInput,
} from './attempt-ledger.server';

const YEAR3_ROTATIONS = new Set<string>(YEAR3_EXAM_TARGET_ROTATIONS);
const OPAQUE_ID = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/;

export const PROTECTED_REVIEW_TARGET_BYPASS_REASON =
  'protected-lane-control-identical';

export interface ProtectedReviewDecisionContext {
  /** Identity returned by the fail-closed pre-compute admission gate. */
  attemptId: string;
  userId: string;
  sessionId: string;
  batchId: string | null;
  rotation: ExamTargetRotation;
  reviewFilter: 'due' | 'at-risk';
  requestedSize: number;
  sourcePolicy: ExamTargetPersistedSourcePolicy;
  examTarget: RuntimeExamTargetContext;
}

export interface ProtectedReviewDecisionScalarItem {
  itemKey: string;
  sourceRotation: string;
}

export interface BuildProtectedReviewDecisionSetInput {
  context: ProtectedReviewDecisionContext;
  items: readonly ProtectedReviewDecisionScalarItem[];
  tokenizeItemKey: (itemKey: string) => string;
  now: Date;
}

interface ProtectedReviewDecisionTransaction
  extends ExamTargetDecisionTransaction, AtomicServeDecisionWriterClient {}

export interface ProtectedReviewDecisionDependencies {
  client?: ExamTargetDecisionPersistenceClient<ProtectedReviewDecisionTransaction>;
  loadTokenizer?: () => (itemKey: string) => string;
  now?: () => Date;
  writeLegacy?: (
    items: UnifiedItem[],
    context: LiveWriteCtx,
  ) => Promise<UnifiedItem[]>;
  attemptClient?: ExamTargetAttemptLedgerClient;
  terminalizeAttempt?: typeof terminalizeExamTargetDecisionAttempt;
}

export interface WriteProtectedReviewServeDecisionsInput {
  context: ProtectedReviewDecisionContext;
  items: UnifiedItem[];
}

export function isProtectedReviewTargetContext(
  rotation: string,
  examTarget: RuntimeExamTargetContext | undefined,
): examTarget is RuntimeExamTargetContext {
  return YEAR3_ROTATIONS.has(rotation)
    && examTarget !== undefined
    && examTarget.resolved.effectiveMode !== 'off'
    && examTarget.snapshot !== null;
}

function requireTargetContext(context: ProtectedReviewDecisionContext) {
  const { examTarget, rotation } = context;
  const { assignment, effectiveMode } = examTarget.resolved;
  if (typeof context.attemptId !== 'string'
    || context.attemptId.length === 0
    || context.attemptId.length > 200
    || !OPAQUE_ID.test(context.attemptId)) {
    throw new TypeError('protected review admitted attempt identity is invalid');
  }
  if (
    !YEAR3_ROTATIONS.has(rotation)
    || effectiveMode === 'off'
    || examTarget.snapshot === null
    || examTarget.snapshot.rotation !== rotation
    || examTarget.activationRevision === null
    || examTarget.schedulerVersion === null
    || examTarget.policyDigest === null
  ) {
    throw new TypeError('protected review target context is unavailable');
  }
  return {
    assignment,
    effectiveMode,
    snapshot: examTarget.snapshot,
    activationRevision: examTarget.activationRevision,
    schedulerVersion: examTarget.schedulerVersion,
    policyDigest: examTarget.policyDigest,
  };
}

/**
 * Builds scalar-only telemetry after the explicit review-filter membership and
 * order have already been finalized. No target score is invented: both arms
 * contain the same protected selection and every item is target-ineligible.
 */
export function buildProtectedReviewDecisionSet(
  input: BuildProtectedReviewDecisionSetInput,
): PersistExamTargetDecisionSetInput {
  const target = requireTargetContext(input.context);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new TypeError('protected review decision timestamp is invalid');
  }

  const itemKeys = input.items.map((item) => item.itemKey);
  const itemTokens = itemKeys.map(input.tokenizeItemKey);
  const seedEnvelope = {
    schema: 'md3.exam-target-protected-review-seed/v1',
    sessionId: input.context.sessionId,
    batchId: input.context.batchId,
    rotation: input.context.rotation,
    reviewFilter: input.context.reviewFilter,
    requestedSize: input.context.requestedSize,
    targetVersion: target.snapshot.targetVersion,
    itemTokens,
  } as const;
  const tieBreakSeed = hashExamTargetArtifact(seedEnvelope);
  const decisionKey = hashExamTargetArtifact({
    ...seedEnvelope,
    schema: 'md3.exam-target-protected-review-decision-key/v1',
  });
  const candidates: ExamTargetDecisionCandidate[] = input.items.map((item, baseRank) => ({
    itemKey: item.itemKey,
    slotClass: 'protected_due',
    domainCode: null,
    baseRank,
    targetEligible: false,
    targetScore: null,
  }));
  const telemetry = buildExamTargetDecisionTelemetry({
    candidates,
    controlSelectionKeys: itemKeys,
    targetSelectionKeys: itemKeys,
    requestedSize: input.context.requestedSize,
    policyDigest: target.policyDigest,
    deterministicSeed: tieBreakSeed,
    captureReplay: false,
    tokenizeItemKey: input.tokenizeItemKey,
  });
  const decidedAt = new Date(input.now.getTime());
  const snapshot = target.snapshot;
  const sourcePolicy = {
    allowed: [...new Set(input.context.sourcePolicy.allowed)].sort(),
    max: input.context.sourcePolicy.max,
  };
  const decision: ExamTargetDecisionSetWriteInput = {
    decisionKey,
    attemptId: input.context.attemptId,
    userId: input.context.userId,
    sessionId: input.context.sessionId,
    batchId: input.context.batchId,
    rotation: input.context.rotation,
    decisionPath: 'review-filter',
    decidedAt,
    schedulerVersion: target.schedulerVersion,
    mode: target.effectiveMode,
    assignment: target.assignment,
    targetPolicyVersion: snapshot.definition.scoringPolicyVersion,
    activationRevision: target.activationRevision,
    targetSnapshotId: snapshot.id,
    targetId: snapshot.targetId,
    targetRevision: snapshot.revision,
    targetBasis: snapshot.targetBasis,
    targetScorerVersion: snapshot.scorerVersion,
    daysToExam: null,
    pressureBucket: null,
    learnerStateVersion: null,
    sourcePolicy,
    masteryTelemetry: null,
    tieBreakSeed,
    requestedSize: input.context.requestedSize,
    candidateCount: candidates.length,
    eligibleCount: candidates.length,
    targetEligibleCount: 0,
    controlSelectedCount: itemKeys.length,
    targetSelectedCount: itemKeys.length,
    controlAllocationError: null,
    targetAllocationError: null,
    targetComputeMs: null,
    fallbackReason: PROTECTED_REVIEW_TARGET_BYPASS_REASON,
    traceVersion: 1,
    replayCapturedAt: null,
    replayExpiresAt: null,
  };
  const items: ExamTargetServeItemTelemetryInput[] = input.items.map((item, rank) => ({
    itemKey: item.itemKey,
    itemToken: itemTokens[rank]!,
    sourceRotation: item.sourceRotation,
    slotClass: 'protected_due',
    targetEligible: false,
    targetApplied: false,
    targetBypassReason: PROTECTED_REVIEW_TARGET_BYPASS_REASON,
    targetEmbeddingHash: null,
    targetDomainCode: null,
    examRelevancePct: null,
    examDomainWeight: null,
    userDomainGap: null,
    contentTargetScore: null,
    personalizedTargetScore: null,
    targetWeightProvenance: null,
    targetBoostDelta: null,
    baseRankInPool: rank,
    targetRankInPool: rank,
    finalRankInPool: rank,
    targetChangedMembership: false,
    targetCacheAgeMs: null,
    constraintCodes: [
      'protected_due',
      item.sourceRotation === input.context.rotation
        ? 'source_native'
        : 'source_cross_mapped',
    ],
  }));

  return { decision, telemetry, items };
}

/**
 * Persists the protected paired trace and served-item target fields atomically.
 * Any unavailable HMAC, invalid scalar input, or transaction failure falls
 * back to the unchanged protected selection through the legacy writer.
 */
export async function writeProtectedReviewServeDecisions(
  input: WriteProtectedReviewServeDecisionsInput,
  dependencies: ProtectedReviewDecisionDependencies = {},
): Promise<UnifiedItem[]> {
  const writeContext: LiveWriteCtx = {
    userId: input.context.userId,
    sessionId: input.context.sessionId,
    batchId: input.context.batchId ?? undefined,
    rotation: input.context.rotation,
    decisionPath: 'review-filter',
    queueReason: input.context.reviewFilter,
  };
  const writeLegacy = dependencies.writeLegacy ?? writeLiveServeDecisions;
  let attemptFinalized = false;
  const settleAttempt = async (
    terminal: Omit<TerminalizeExamTargetAttemptInput, 'attemptId' | 'userId'>,
  ): Promise<void> => {
    if (attemptFinalized) return;
    attemptFinalized = true;
    try {
      await (dependencies.terminalizeAttempt ?? terminalizeExamTargetDecisionAttempt)(
        dependencies.attemptClient
          ?? (prisma as unknown as ExamTargetAttemptLedgerClient),
        {
          attemptId: input.context.attemptId,
          userId: input.context.userId,
          ...terminal,
        },
      );
    } catch {
      logger.warn('protected review attempt terminalization unavailable', {
        code: 'terminalization-failed',
        rotation: input.context.rotation,
        reviewFilter: input.context.reviewFilter,
        outcome: terminal.outcome,
      });
    }
  };

  const serveControl = async (
    failureClass: ExamTargetAttemptFailureClass | null,
  ): Promise<UnifiedItem[]> => {
    try {
      const controlItems = await writeLegacy(input.items, writeContext);
      await settleAttempt(controlItems.length > 0
        ? {
            outcome: 'control_fallback',
            failureClass: failureClass ?? 'unclassified_runtime_failed',
            servedDisposition: 'control',
            servedItemCount: controlItems.length,
            fallbackTracePersisted: false,
          }
        : {
            outcome: 'no_items',
            failureClass,
            servedDisposition: 'none',
            servedItemCount: 0,
            fallbackTracePersisted: null,
          });
      return controlItems;
    } catch (error) {
      await settleAttempt({
        outcome: 'request_failed',
        failureClass: failureClass ?? 'unclassified_runtime_failed',
        servedDisposition: 'none',
        servedItemCount: 0,
        fallbackTracePersisted: null,
      });
      throw error;
    }
  };

  if (input.items.length === 0) return serveControl(null);

  let failureClass: ExamTargetAttemptFailureClass = 'decision_build_failed';
  try {
    const tokenizeItemKey = (
      dependencies.loadTokenizer ?? loadExamTargetDecisionTokenizer
    )();
    const decisionInput = buildProtectedReviewDecisionSet({
      context: input.context,
      items: input.items.map((item) => ({
        itemKey: `${item.type}:${item.id}`,
        sourceRotation: item.rotation,
      })),
      tokenizeItemKey,
      now: (dependencies.now ?? (() => new Date()))(),
    });
    let atomicallyWrittenItems: UnifiedItem[] | null = null;
    failureClass = 'telemetry_validation_failed';
    const result = await persistExamTargetDecisionSet(decisionInput, {
      client: dependencies.client
        ?? (prisma as unknown as ExamTargetDecisionPersistenceClient<
          ProtectedReviewDecisionTransaction
        >),
      tokenizeItemKey,
      writeServeDecisionTargets: async ({ transaction, receipt }) => {
        const written = await writeLiveExamTargetServeDecisions(
          transaction,
          input.items,
          writeContext,
          receipt,
        );
        if (
          written.length !== input.items.length
          || written.some((item, index) => (
            item.type !== input.items[index]?.type
            || item.id !== input.items[index]?.id
          ))
        ) {
          throw new Error('protected review target write changed selection');
        }
        atomicallyWrittenItems = written;
      },
      reportPersistenceFailure: report => {
        failureClass = report.failureReason === 'transaction_failed'
          ? 'persistence_transaction_failed'
          : 'telemetry_validation_failed';
      },
    });
    if (result.status === 'persisted' && atomicallyWrittenItems !== null) {
      attemptFinalized = true;
      return atomicallyWrittenItems;
    }
    if (result.status === 'not-persisted') {
      failureClass = result.failureReason === 'transaction_failed'
        ? 'persistence_transaction_failed'
        : 'telemetry_validation_failed';
    }
  } catch {
    // The protected control selection remains safe to serve. Never log item
    // identifiers, HMAC material, content, paths, vectors, or raw DB errors.
    logger.warn('protected review target telemetry unavailable; serving control', {
      rotation: input.context.rotation,
      reviewFilter: input.context.reviewFilter,
      mode: input.context.examTarget.resolved.effectiveMode,
      assignment: input.context.examTarget.resolved.assignment,
    });
  }

  return serveControl(failureClass);
}
