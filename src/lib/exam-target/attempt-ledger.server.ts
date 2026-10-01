import 'server-only';

import {
  YEAR3_EXAM_TARGET_ROTATIONS,
  type ExamTargetRotation,
} from './types';

export const EXAM_TARGET_ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const EXAM_TARGET_ATTEMPT_STALE_AFTER_MS_DEFAULT = 5 * 60 * 1_000;
export const EXAM_TARGET_ATTEMPT_PRUNE_BATCH_SIZE_DEFAULT = 500;
export const EXAM_TARGET_ATTEMPT_PRUNE_BATCHES_DEFAULT = 20;
export const MAX_EXAM_TARGET_ATTEMPT_PRUNE_BATCH_SIZE = 5_000;
export const MAX_EXAM_TARGET_ATTEMPT_PRUNE_BATCHES = 200;

export type ExamTargetAttemptDecisionPath = 'manifold-walk' | 'review-filter';
export type ExamTargetAttemptMode = 'shadow' | 'active';
export type ExamTargetAttemptAssignment = 'control' | 'treatment';
export type ExamTargetAttemptOutcome =
  | 'started'
  | 'decision_persisted'
  | 'control_fallback'
  | 'no_items'
  | 'request_failed';
export type ExamTargetAttemptFailureClass =
  | 'precompute_failed'
  | 'scheduler_compute_failed'
  | 'postprocess_failed'
  | 'decision_build_failed'
  | 'telemetry_validation_failed'
  | 'persistence_transaction_failed'
  | 'unclassified_runtime_failed';
export type ExamTargetAttemptServedDisposition = 'control' | 'treatment' | 'none';

export interface ExamTargetAttemptAdmissionInput {
  userId: string;
  sessionId: string;
  batchId: string;
  rotation: ExamTargetRotation;
  decisionPath: ExamTargetAttemptDecisionPath;
  targetSnapshotId: string;
  activationRevision: number;
  schedulerVersion: string;
  policyDigest: string;
  mode: ExamTargetAttemptMode;
  assignment: ExamTargetAttemptAssignment;
  requestedSize: number;
}

export interface ExamTargetAttemptRecord extends ExamTargetAttemptAdmissionInput {
  id: string;
  outcome: ExamTargetAttemptOutcome;
  failureClass: ExamTargetAttemptFailureClass | null;
  servedDisposition: ExamTargetAttemptServedDisposition | null;
  servedItemCount: number | null;
  fallbackTracePersisted: boolean | null;
  startedAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

type ExamTargetAttemptDatabaseRecord = Omit<
  ExamTargetAttemptRecord,
  | 'rotation'
  | 'decisionPath'
  | 'mode'
  | 'assignment'
  | 'outcome'
  | 'failureClass'
  | 'servedDisposition'
> & {
  rotation: string;
  decisionPath: string;
  mode: string;
  assignment: string;
  outcome: string;
  failureClass: string | null;
  servedDisposition: string | null;
};

interface CreateAttemptArgs {
  data: Omit<ExamTargetAttemptRecord, 'id'> & {
    outcome: 'started';
    failureClass: null;
    servedDisposition: null;
    servedItemCount: null;
    fallbackTracePersisted: null;
    completedAt: null;
  };
  select: typeof ATTEMPT_SELECT;
}

interface UpdateAttemptArgs {
  where: {
    id: string;
    userId: string;
    outcome: 'started';
    completedAt: null;
  };
  data: {
    outcome: Exclude<ExamTargetAttemptOutcome, 'started'>;
    failureClass: ExamTargetAttemptFailureClass | null;
    servedDisposition: ExamTargetAttemptServedDisposition;
    servedItemCount: number;
    fallbackTracePersisted: boolean | null;
    completedAt: Date;
  };
}

interface FindAttemptArgs {
  where: { id: string; userId: string };
  select: typeof ATTEMPT_SELECT;
}

interface AttemptExpiryWhere {
  expiresAt: { lte: Date };
}

interface FindExpiredAttemptsArgs {
  where: AttemptExpiryWhere;
  select: { id: true };
  orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }];
  take: number;
}

interface DeleteExpiredAttemptsArgs {
  where: {
    id: { in: string[] };
    expiresAt: { lte: Date };
  };
}

export interface ExamTargetAttemptLedgerClient {
  examTargetDecisionAttempt: {
    create(args: CreateAttemptArgs): Promise<ExamTargetAttemptDatabaseRecord>;
    updateMany(args: UpdateAttemptArgs): Promise<{ count: number }>;
    findFirst(args: FindAttemptArgs): Promise<ExamTargetAttemptDatabaseRecord | null>;
    count(args: { where: AttemptExpiryWhere }): Promise<number>;
    findMany(args: FindExpiredAttemptsArgs): Promise<Array<{ id: string }>>;
    deleteMany(args: DeleteExpiredAttemptsArgs): Promise<{ count: number }>;
  };
}

export interface AdmitExamTargetAttemptOptions {
  now?: Date;
}

export interface TerminalizeExamTargetAttemptInput {
  attemptId: string;
  userId: string;
  outcome: Exclude<ExamTargetAttemptOutcome, 'started'>;
  failureClass: ExamTargetAttemptFailureClass | null;
  servedDisposition: ExamTargetAttemptServedDisposition;
  servedItemCount: number;
  fallbackTracePersisted: boolean | null;
}

export interface TerminalizeExamTargetAttemptOptions {
  now?: Date;
}

export interface TerminalizeExamTargetAttemptResult {
  status: 'transitioned' | 'already-terminal';
  attempt: ExamTargetAttemptRecord;
}

export type ExamTargetAttemptStateClassification =
  | 'pending'
  | 'stale-started'
  | 'terminal';

export interface ClassifyExamTargetAttemptStateInput {
  outcome: ExamTargetAttemptOutcome;
  startedAt: Date;
  completedAt: Date | null;
}

export interface ClassifyExamTargetAttemptStateOptions {
  now?: Date;
  staleAfterMs?: number;
}

export type ExamTargetAttemptPruneMode = 'dry-run' | 'apply';

export interface PruneExpiredExamTargetAttemptsOptions {
  /** Defaults to dry-run; deletion requires an explicit apply mode. */
  mode?: ExamTargetAttemptPruneMode;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface PruneExpiredExamTargetAttemptsResult {
  mode: ExamTargetAttemptPruneMode;
  asOf: Date;
  eligible: number;
  deleted: number;
  batches: number;
  batchSize: number;
  maxBatches: number;
  maxRows: number;
  cappedOut: boolean;
}

const ADMISSION_FIELDS = [
  'userId',
  'sessionId',
  'batchId',
  'rotation',
  'decisionPath',
  'targetSnapshotId',
  'activationRevision',
  'schedulerVersion',
  'policyDigest',
  'mode',
  'assignment',
  'requestedSize',
] as const;

const TERMINAL_FIELDS = [
  'attemptId',
  'userId',
  'outcome',
  'failureClass',
  'servedDisposition',
  'servedItemCount',
  'fallbackTracePersisted',
] as const;

const ATTEMPT_SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  batchId: true,
  rotation: true,
  decisionPath: true,
  targetSnapshotId: true,
  activationRevision: true,
  schedulerVersion: true,
  policyDigest: true,
  mode: true,
  assignment: true,
  requestedSize: true,
  outcome: true,
  failureClass: true,
  servedDisposition: true,
  servedItemCount: true,
  fallbackTracePersisted: true,
  startedAt: true,
  completedAt: true,
  expiresAt: true,
} as const;
const ATTEMPT_FIELDS = Object.keys(ATTEMPT_SELECT);

const OPAQUE_ID = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const STABLE_CODE = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const ROTATIONS = new Set<ExamTargetRotation>(YEAR3_EXAM_TARGET_ROTATIONS);
const DECISION_PATHS = new Set<ExamTargetAttemptDecisionPath>([
  'manifold-walk',
  'review-filter',
]);
const MODES = new Set<ExamTargetAttemptMode>(['shadow', 'active']);
const ASSIGNMENTS = new Set<ExamTargetAttemptAssignment>(['control', 'treatment']);
const TERMINAL_OUTCOMES = new Set<Exclude<ExamTargetAttemptOutcome, 'started'>>([
  'decision_persisted',
  'control_fallback',
  'no_items',
  'request_failed',
]);
const FAILURE_CLASSES = new Set<ExamTargetAttemptFailureClass>([
  'precompute_failed',
  'scheduler_compute_failed',
  'postprocess_failed',
  'decision_build_failed',
  'telemetry_validation_failed',
  'persistence_transaction_failed',
  'unclassified_runtime_failed',
]);
const SERVED_DISPOSITIONS = new Set<ExamTargetAttemptServedDisposition>([
  'control',
  'treatment',
  'none',
]);

/** Converts arbitrary caught values into a bounded, non-sensitive code. */
export function sanitizeExamTargetAttemptFailureClass(
  value: unknown,
): ExamTargetAttemptFailureClass {
  return typeof value === 'string'
    && FAILURE_CLASSES.has(value as ExamTargetAttemptFailureClass)
    ? value as ExamTargetAttemptFailureClass
    : 'unclassified_runtime_failed';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((field, index) => field === sortedExpected[index]);
}

function safeOpaqueId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && OPAQUE_ID.test(value);
}

function safeStableCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && STABLE_CODE.test(value);
}

function safePositiveInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function nonnegativeCount(value: number, label: string, maximum?: number): number {
  if (!Number.isSafeInteger(value)
    || value < 0
    || maximum !== undefined && value > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function parseAdmissionInput(value: unknown): ExamTargetAttemptAdmissionInput {
  if (!hasExactFields(value, ADMISSION_FIELDS)) {
    throw new TypeError('invalid exam-target attempt admission fields');
  }
  if (!safeOpaqueId(value.userId)
    || !UUID.test(typeof value.sessionId === 'string' ? value.sessionId : '')
    || !UUID.test(typeof value.batchId === 'string' ? value.batchId : '')
    || !ROTATIONS.has(value.rotation as ExamTargetRotation)
    || !DECISION_PATHS.has(value.decisionPath as ExamTargetAttemptDecisionPath)
    || !safeOpaqueId(value.targetSnapshotId)
    || !safePositiveInteger(value.activationRevision, Number.MAX_SAFE_INTEGER)
    || !safeStableCode(value.schedulerVersion)
    || typeof value.policyDigest !== 'string'
    || !SHA256.test(value.policyDigest)
    || !MODES.has(value.mode as ExamTargetAttemptMode)
    || !ASSIGNMENTS.has(value.assignment as ExamTargetAttemptAssignment)
    || !safePositiveInteger(value.requestedSize, 100)
    || value.mode === 'shadow' && value.assignment !== 'control'
    || value.assignment === 'treatment' && value.mode !== 'active') {
    throw new TypeError('invalid exam-target attempt admission value');
  }
  return value as unknown as ExamTargetAttemptAdmissionInput;
}

function parseTerminalInput(value: unknown): TerminalizeExamTargetAttemptInput {
  if (!hasExactFields(value, TERMINAL_FIELDS)) {
    throw new TypeError('invalid exam-target attempt terminal fields');
  }
  const outcome = value.outcome as Exclude<ExamTargetAttemptOutcome, 'started'>;
  const failureClass = value.failureClass as ExamTargetAttemptFailureClass | null;
  const disposition = value.servedDisposition as ExamTargetAttemptServedDisposition;
  if (!safeOpaqueId(value.attemptId)
    || !safeOpaqueId(value.userId)
    || !TERMINAL_OUTCOMES.has(outcome)
    || !(failureClass === null || FAILURE_CLASSES.has(failureClass))
    || !SERVED_DISPOSITIONS.has(disposition)
    || !Number.isSafeInteger(value.servedItemCount)
    || (value.servedItemCount as number) < 0
    || (value.servedItemCount as number) > 100
    || !(value.fallbackTracePersisted === null
      || typeof value.fallbackTracePersisted === 'boolean')) {
    throw new TypeError('invalid exam-target attempt terminal value');
  }

  const servedItemCount = value.servedItemCount as number;
  const fallbackTracePersisted = value.fallbackTracePersisted as boolean | null;
  const validShape = outcome === 'decision_persisted'
    ? failureClass === null
      && disposition !== 'none'
      && servedItemCount > 0
      && fallbackTracePersisted === null
    : outcome === 'control_fallback'
      ? failureClass !== null
        && disposition === 'control'
        && servedItemCount > 0
        && typeof fallbackTracePersisted === 'boolean'
      : outcome === 'no_items'
        // no_items is the final empty serving result. Its orthogonal typed
        // failure may be null (natural exhaustion) or preserve an upstream
        // target failure before the control path also returned no items.
        ? disposition === 'none'
          && servedItemCount === 0
          && fallbackTracePersisted === null
        : failureClass !== null
          && disposition === 'none'
          && servedItemCount === 0
          && fallbackTracePersisted === null;
  if (!validShape) {
    throw new TypeError('invalid exam-target attempt terminal shape');
  }
  return value as unknown as TerminalizeExamTargetAttemptInput;
}

function parseNow(value: Date | undefined): Date {
  const now = value === undefined ? new Date() : new Date(value.getTime());
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('invalid exam-target attempt admission timestamp');
  }
  return now;
}

function parseAttemptRecord(value: unknown): ExamTargetAttemptRecord {
  if (!hasExactFields(value, ATTEMPT_FIELDS) || !safeOpaqueId(value.id)) {
    throw new TypeError('invalid exam-target attempt database record');
  }
  const admission = parseAdmissionInput({
    userId: value.userId,
    sessionId: value.sessionId,
    batchId: value.batchId,
    rotation: value.rotation,
    decisionPath: value.decisionPath,
    targetSnapshotId: value.targetSnapshotId,
    activationRevision: value.activationRevision,
    schedulerVersion: value.schedulerVersion,
    policyDigest: value.policyDigest,
    mode: value.mode,
    assignment: value.assignment,
    requestedSize: value.requestedSize,
  });
  if (!(value.startedAt instanceof Date)
    || !Number.isFinite(value.startedAt.getTime())
    || !(value.expiresAt instanceof Date)
    || !Number.isFinite(value.expiresAt.getTime())
    || value.expiresAt.getTime() <= value.startedAt.getTime()
    || value.expiresAt.getTime() - value.startedAt.getTime()
      > EXAM_TARGET_ATTEMPT_RETENTION_MS) {
    throw new TypeError('invalid exam-target attempt database retention');
  }

  if (value.outcome === 'started') {
    if (value.failureClass !== null
      || value.servedDisposition !== null
      || value.servedItemCount !== null
      || value.fallbackTracePersisted !== null
      || value.completedAt !== null) {
      throw new TypeError('invalid started exam-target attempt database record');
    }
  } else {
    const terminal = parseTerminalInput({
      attemptId: value.id,
      userId: value.userId,
      outcome: value.outcome,
      failureClass: value.failureClass,
      servedDisposition: value.servedDisposition,
      servedItemCount: value.servedItemCount,
      fallbackTracePersisted: value.fallbackTracePersisted,
    });
    if (!(value.completedAt instanceof Date)
      || !Number.isFinite(value.completedAt.getTime())
      || value.completedAt.getTime() < value.startedAt.getTime()
      || value.completedAt.getTime() > value.expiresAt.getTime()
      || terminal.servedItemCount > admission.requestedSize
      || terminal.outcome === 'decision_persisted'
        && terminal.servedDisposition !== admission.assignment) {
      throw new TypeError('invalid terminal exam-target attempt database record');
    }
  }
  return value as unknown as ExamTargetAttemptRecord;
}

/**
 * Durably admits one target-capable compute before any target policy work.
 * Callers cannot choose the initial state or retention deadline, and unknown
 * fields are rejected so content, item identifiers, vectors, JSON overflow,
 * and raw error strings cannot enter the attempt ledger through this seam.
 * Admission is intentionally create-only: any rejected or ambiguous insert
 * must keep targeting disabled for that request. If the insert committed but
 * its acknowledgement was lost, the durable started row becomes stale audit
 * evidence instead of authorizing a duplicate compute.
 */
export async function admitExamTargetDecisionAttempt(
  client: ExamTargetAttemptLedgerClient,
  input: ExamTargetAttemptAdmissionInput,
  options: AdmitExamTargetAttemptOptions = {},
): Promise<ExamTargetAttemptRecord> {
  const parsed = parseAdmissionInput(input);
  const startedAt = parseNow(options.now);
  const expiresAt = new Date(startedAt.getTime() + EXAM_TARGET_ATTEMPT_RETENTION_MS);

  const attempt = await client.examTargetDecisionAttempt.create({
    data: {
      ...parsed,
      outcome: 'started',
      failureClass: null,
      servedDisposition: null,
      servedItemCount: null,
      fallbackTracePersisted: null,
      startedAt,
      completedAt: null,
      expiresAt,
    },
    select: ATTEMPT_SELECT,
  });
  return parseAttemptRecord(attempt);
}

function hasSameTerminalState(
  attempt: ExamTargetAttemptRecord,
  terminal: TerminalizeExamTargetAttemptInput,
): boolean {
  return attempt.outcome === terminal.outcome
    && attempt.failureClass === terminal.failureClass
    && attempt.servedDisposition === terminal.servedDisposition
    && attempt.servedItemCount === terminal.servedItemCount
    && attempt.fallbackTracePersisted === terminal.fallbackTracePersisted
    && attempt.completedAt instanceof Date
    && Number.isFinite(attempt.completedAt.getTime());
}

/**
 * Performs the only legal lifecycle mutation: started -> one terminal state.
 * A repeated semantically identical call succeeds without rewriting the row;
 * a conflicting second terminal state fails closed.
 */
export async function terminalizeExamTargetDecisionAttempt(
  client: ExamTargetAttemptLedgerClient,
  input: TerminalizeExamTargetAttemptInput,
  options: TerminalizeExamTargetAttemptOptions = {},
): Promise<TerminalizeExamTargetAttemptResult> {
  const terminal = parseTerminalInput(input);
  const completedAt = parseNow(options.now);
  const mutation = await client.examTargetDecisionAttempt.updateMany({
    where: {
      id: terminal.attemptId,
      userId: terminal.userId,
      outcome: 'started',
      completedAt: null,
    },
    data: {
      outcome: terminal.outcome,
      failureClass: terminal.failureClass,
      servedDisposition: terminal.servedDisposition,
      servedItemCount: terminal.servedItemCount,
      fallbackTracePersisted: terminal.fallbackTracePersisted,
      completedAt,
    },
  });
  if (!Number.isSafeInteger(mutation.count) || mutation.count < 0 || mutation.count > 1) {
    throw new Error('exam_target_attempt_transition_inconsistent');
  }

  const storedAttempt = await client.examTargetDecisionAttempt.findFirst({
    where: { id: terminal.attemptId, userId: terminal.userId },
    select: ATTEMPT_SELECT,
  });
  const attempt = storedAttempt === null ? null : parseAttemptRecord(storedAttempt);
  if (!attempt || !hasSameTerminalState(attempt, terminal)) {
    throw new Error('exam_target_attempt_transition_conflict');
  }
  return {
    status: mutation.count === 1 ? 'transitioned' : 'already-terminal',
    attempt,
  };
}

/** Classifies mature unclosed attempts without mutating or hiding them. */
export function classifyExamTargetAttemptState(
  input: ClassifyExamTargetAttemptStateInput,
  options: ClassifyExamTargetAttemptStateOptions = {},
): ExamTargetAttemptStateClassification {
  if (!(input.startedAt instanceof Date)
    || !Number.isFinite(input.startedAt.getTime())
    || !(input.completedAt === null || input.completedAt instanceof Date)
    || input.completedAt instanceof Date && !Number.isFinite(input.completedAt.getTime())
    || !(input.outcome === 'started' || TERMINAL_OUTCOMES.has(input.outcome))) {
    throw new TypeError('invalid exam-target attempt state');
  }
  if (input.outcome === 'started') {
    if (input.completedAt !== null) {
      throw new TypeError('invalid started exam-target attempt state');
    }
  } else {
    if (input.completedAt === null
      || input.completedAt.getTime() < input.startedAt.getTime()) {
      throw new TypeError('invalid terminal exam-target attempt state');
    }
    return 'terminal';
  }

  const asOf = parseNow(options.now);
  const staleAfterMs = options.staleAfterMs
    ?? EXAM_TARGET_ATTEMPT_STALE_AFTER_MS_DEFAULT;
  if (!Number.isSafeInteger(staleAfterMs)
    || staleAfterMs <= 0
    || staleAfterMs > EXAM_TARGET_ATTEMPT_RETENTION_MS) {
    throw new TypeError('invalid exam-target attempt stale threshold');
  }
  return asOf.getTime() - input.startedAt.getTime() >= staleAfterMs
    ? 'stale-started'
    : 'pending';
}

/** Deletes complete expired attempt rows in bounded, race-safe batches. */
export async function pruneExpiredExamTargetDecisionAttempts(
  client: ExamTargetAttemptLedgerClient,
  options: PruneExpiredExamTargetAttemptsOptions = {},
): Promise<PruneExpiredExamTargetAttemptsResult> {
  const mode = options.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new TypeError('exam-target attempt prune mode must be dry-run or apply');
  }
  const asOf = parseNow(options.now);
  const batchSize = options.batchSize
    ?? EXAM_TARGET_ATTEMPT_PRUNE_BATCH_SIZE_DEFAULT;
  const maxBatches = options.maxBatches
    ?? EXAM_TARGET_ATTEMPT_PRUNE_BATCHES_DEFAULT;
  if (!safePositiveInteger(batchSize, MAX_EXAM_TARGET_ATTEMPT_PRUNE_BATCH_SIZE)
    || !safePositiveInteger(maxBatches, MAX_EXAM_TARGET_ATTEMPT_PRUNE_BATCHES)) {
    throw new TypeError('invalid exam-target attempt prune bounds');
  }
  const maxRows = batchSize * maxBatches;
  const where: AttemptExpiryWhere = { expiresAt: { lte: asOf } };
  const eligible = nonnegativeCount(
    await client.examTargetDecisionAttempt.count({ where }),
    'eligible exam-target attempt count',
  );

  if (mode === 'dry-run') {
    return {
      mode,
      asOf,
      eligible,
      deleted: 0,
      batches: 0,
      batchSize,
      maxBatches,
      maxRows,
      cappedOut: eligible > maxRows,
    };
  }

  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = await client.examTargetDecisionAttempt.findMany({
      where,
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (rows.length === 0) break;
    if (rows.length > batchSize) {
      throw new TypeError('exam-target attempt prune delegate exceeded its batch limit');
    }
    const ids = rows.map(({ id }) => id);
    if (ids.some((id) => !safeOpaqueId(id)) || new Set(ids).size !== ids.length) {
      throw new TypeError('exam-target attempt prune received invalid attempt ids');
    }
    const mutation = await client.examTargetDecisionAttempt.deleteMany({
      where: {
        id: { in: ids },
        expiresAt: { lte: asOf },
      },
    });
    deleted += nonnegativeCount(
      mutation.count,
      'deleted exam-target attempt count',
      rows.length,
    );
    batches += 1;
    if (rows.length < batchSize) break;
  }

  const cappedOut = batches >= maxBatches
    && (await client.examTargetDecisionAttempt.findMany({
      where,
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 1,
    })).length > 0;
  return {
    mode,
    asOf,
    eligible,
    deleted,
    batches,
    batchSize,
    maxBatches,
    maxRows,
    cappedOut,
  };
}
