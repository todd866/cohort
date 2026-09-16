import type { ExamTargetSlotClass } from './allocator';
import { canonicalExamTargetJson, hashExamTargetArtifact } from './artifact';
import {
  MAX_EXAM_TARGET_DECISION_CANDIDATES,
  MAX_EXAM_TARGET_REPLAY_BYTES,
  MAX_EXAM_TARGET_REPLAY_SELECTION,
  parseExamTargetDecisionReplaySnapshot,
  type ExamTargetDecisionReplaySnapshot,
  type ExamTargetDecisionTelemetry,
} from './decision-set';
import { parseExamTargetTrace, type ExamTargetTrace } from './trace';
import type { ExamTargetBasis, ExamTargetRotation } from './types';

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STABLE_CODE = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const DOMAIN_CODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TARGET_ID = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const ROTATIONS = new Set<ExamTargetRotation>(['critical-care', 'paam', 'cah', 'pwh']);
const MODES = new Set<ExamTargetDecisionMode>(['off', 'shadow', 'active', 'fallback']);
const ASSIGNMENTS = new Set<ExamTargetDecisionAssignment>(['control', 'treatment', 'unassigned']);
const BASES = new Set<ExamTargetBasis>(['official', 'hybrid', 'proxy']);
const SLOT_CLASSES = new Set<ExamTargetSlotClass>([
  'protected_due',
  'protected_relearn',
  'protected_failure',
  'protected_scaffold',
  'discretionary',
]);

const DECISION_FIELDS = [
  'decisionKey',
  'userId',
  'sessionId',
  'batchId',
  'rotation',
  'decisionPath',
  'decidedAt',
  'schedulerVersion',
  'mode',
  'assignment',
  'targetPolicyVersion',
  'activationRevision',
  'targetSnapshotId',
  'targetId',
  'targetRevision',
  'targetBasis',
  'targetScorerVersion',
  'daysToExam',
  'pressureBucket',
  'learnerStateVersion',
  'sourcePolicy',
  'masteryTelemetry',
  'tieBreakSeed',
  'requestedSize',
  'candidateCount',
  'eligibleCount',
  'targetEligibleCount',
  'controlSelectedCount',
  'targetSelectedCount',
  'controlAllocationError',
  'targetAllocationError',
  'targetComputeMs',
  'fallbackReason',
  'traceVersion',
  'replayCapturedAt',
  'replayExpiresAt',
] as const;
const DECISION_FIELDS_WITH_ATTEMPT = [...DECISION_FIELDS, 'attemptId'] as const;
const TELEMETRY_FIELDS = [
  'policyDigest',
  'candidateSetDigest',
  'controlSelectionDigest',
  'targetSelectionDigest',
  'selectedSetOverlap',
  'changedMembershipCount',
  'controlMeanTargetScore',
  'targetMeanTargetScore',
  'pairedTargetLift',
  'replaySnapshot',
] as const;
const SOURCE_POLICY_FIELDS = ['allowed', 'max'] as const;
const MASTERY_TELEMETRY_FIELDS = [
  'policyVersion',
  'requiredTargetWorkToday',
  'remainingTargetWorkToday',
  'coreTargetSeats',
  'coreTargetSeatsSelected',
  'coreTargetSeatShortfall',
  'surplusSeats',
  'surplusTargetSeatsSelected',
  'workloadOnTrack',
  'workloadShortfall',
  'loadWarnings',
  'coverageDebtDomainCodes',
  'changedConceptMembershipCount',
  'evaluationOnly',
  'curriculumCoverageDebtCount',
] as const;
const ITEM_FIELDS = [
  'itemKey',
  'itemToken',
  'sourceRotation',
  'slotClass',
  'targetEligible',
  'targetApplied',
  'targetBypassReason',
  'targetEmbeddingHash',
  'targetDomainCode',
  'examRelevancePct',
  'examDomainWeight',
  'userDomainGap',
  'contentTargetScore',
  'personalizedTargetScore',
  'targetWeightProvenance',
  'targetBoostDelta',
  'baseRankInPool',
  'targetRankInPool',
  'finalRankInPool',
  'targetChangedMembership',
  'targetCacheAgeMs',
  'constraintCodes',
] as const;

const MAX_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_EXAM_TARGET_PERSISTED_DECISION_BYTES = MAX_EXAM_TARGET_REPLAY_BYTES + 16_384;

export type ExamTargetDecisionMode = 'off' | 'shadow' | 'active' | 'fallback';
export type ExamTargetDecisionAssignment = 'control' | 'treatment' | 'unassigned';

export interface ExamTargetPersistedSourcePolicy {
  allowed: readonly string[];
  max: number;
}

export interface ExamTargetPersistedMasteryTelemetry {
  policyVersion: string | null;
  requiredTargetWorkToday: number | null;
  remainingTargetWorkToday: number | null;
  coreTargetSeats: number | null;
  coreTargetSeatsSelected: number;
  coreTargetSeatShortfall: number;
  surplusSeats: number | null;
  surplusTargetSeatsSelected: number;
  workloadOnTrack: boolean | null;
  workloadShortfall: number | null;
  loadWarnings: readonly string[];
  coverageDebtDomainCodes: readonly string[];
  changedConceptMembershipCount: number;
  evaluationOnly: boolean;
  curriculumCoverageDebtCount: number | null;
}

export interface ExamTargetDecisionSetWriteInput {
  decisionKey: string;
  /** Required for target-aware writes; omitted only by non-target legacy callers. */
  attemptId?: string | null;
  userId: string;
  sessionId: string;
  batchId: string | null;
  rotation: ExamTargetRotation;
  decisionPath: string;
  decidedAt: Date;
  schedulerVersion: string;
  mode: ExamTargetDecisionMode;
  assignment: ExamTargetDecisionAssignment;
  targetPolicyVersion: string;
  activationRevision: number | null;
  targetSnapshotId: string | null;
  targetId: string | null;
  targetRevision: number | null;
  targetBasis: ExamTargetBasis | null;
  targetScorerVersion: string | null;
  daysToExam: number | null;
  pressureBucket: string | null;
  learnerStateVersion: string | null;
  sourcePolicy: ExamTargetPersistedSourcePolicy | null;
  masteryTelemetry: ExamTargetPersistedMasteryTelemetry | null;
  tieBreakSeed: string;
  requestedSize: number;
  candidateCount: number;
  eligibleCount: number;
  targetEligibleCount: number;
  controlSelectedCount: number;
  targetSelectedCount: number;
  controlAllocationError: number | null;
  targetAllocationError: number | null;
  targetComputeMs: number | null;
  fallbackReason: string | null;
  traceVersion: number;
  replayCapturedAt: Date | null;
  replayExpiresAt: Date | null;
}

export interface ExamTargetServeItemTelemetryInput {
  /** In-memory join key only; never included in persisted target fields. */
  itemKey: string;
  /** HMAC-SHA256 token used to prove the selected order without persisting itemKey. */
  itemToken: string;
  sourceRotation: string;
  slotClass: ExamTargetSlotClass;
  targetEligible: boolean;
  targetApplied: boolean;
  targetBypassReason: string | null;
  targetEmbeddingHash: string | null;
  targetDomainCode: string | null;
  examRelevancePct: number | null;
  examDomainWeight: number | null;
  userDomainGap: number | null;
  contentTargetScore: number | null;
  personalizedTargetScore: number | null;
  targetWeightProvenance: string | null;
  targetBoostDelta: number | null;
  baseRankInPool: number | null;
  targetRankInPool: number | null;
  finalRankInPool: number | null;
  targetChangedMembership: boolean;
  targetCacheAgeMs: number | null;
  constraintCodes: ExamTargetTrace['constraintCodes'];
}

export interface ExamTargetServeDecisionFields {
  decisionSetId: string;
  examTargetSnapshotId: string | null;
  schedulerVersion: string;
  targetPolicyVersion: string;
  targetMode: ExamTargetDecisionMode;
  targetAssignment: ExamTargetDecisionAssignment;
  targetId: string | null;
  targetRevision: number | null;
  targetBasis: ExamTargetBasis | null;
  targetScorerVersion: string | null;
  targetEmbeddingHash: string | null;
  targetActivationRevision: number | null;
  targetRotation: ExamTargetRotation | null;
  sourceRotation: string;
  slotClass: ExamTargetSlotClass;
  targetEligible: boolean;
  targetApplied: boolean;
  targetBypassReason: string | null;
  targetDomainCode: string | null;
  targetPressureBucket: string | null;
  examRelevancePct: number | null;
  examDomainWeight: number | null;
  userDomainGap: number | null;
  contentTargetScore: number | null;
  personalizedTargetScore: number | null;
  targetWeightProvenance: string | null;
  targetBoostDelta: number | null;
  baseRankInPool: number | null;
  targetRankInPool: number | null;
  finalRankInPool: number | null;
  targetChangedMembership: boolean;
  targetCacheAgeMs: number | null;
  targetTraceVersion: 1 | null;
  targetTrace: ExamTargetTrace | null;
}

export interface SchedulerDecisionSetCreateData {
  decisionKey: string;
  attemptId: string | null;
  userId: string;
  sessionId: string;
  batchId: string | null;
  rotation: ExamTargetRotation;
  decisionPath: string;
  decidedAt: Date;
  schedulerVersion: string;
  mode: ExamTargetDecisionMode;
  assignment: ExamTargetDecisionAssignment;
  targetPolicyVersion: string;
  policyDigest: string;
  activationRevision: number | null;
  targetSnapshotId: string | null;
  targetId: string | null;
  targetRevision: number | null;
  targetBasis: ExamTargetBasis | null;
  targetScorerVersion: string | null;
  daysToExam: number | null;
  pressureBucket: string | null;
  learnerStateVersion: string | null;
  sourcePolicy: { allowed: string[]; max: number } | null;
  masteryTelemetry: ExamTargetPersistedMasteryTelemetry | null;
  candidateSetDigest: string;
  tieBreakSeed: string;
  requestedSize: number;
  candidateCount: number;
  eligibleCount: number;
  targetEligibleCount: number;
  controlSelectedCount: number;
  targetSelectedCount: number;
  controlSelectionDigest: string;
  targetSelectionDigest: string;
  selectedSetOverlap: number;
  changedMembershipCount: number;
  controlMeanTargetScore: number | null;
  targetMeanTargetScore: number | null;
  pairedTargetLift: number | null;
  controlAllocationError: number | null;
  targetAllocationError: number | null;
  targetComputeMs: number | null;
  fallbackReason: string | null;
  traceVersion: number;
  replaySnapshot: ExamTargetDecisionReplaySnapshot | null;
  replayCapturedAt: Date | null;
  replayExpiresAt: Date | null;
}

export interface ExamTargetDecisionTransaction {
  schedulerDecisionSet: {
    create(args: {
      data: SchedulerDecisionSetCreateData;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  examTargetDecisionAttempt?: {
    updateMany(args: ExamTargetAttemptDecisionPersistArgs): Promise<{ count: number }>;
  };
}

export interface ExamTargetAttemptDecisionPersistArgs {
  where: {
    id: string;
    userId: string;
    sessionId: string;
    batchId: string;
    rotation: ExamTargetRotation;
    decisionPath: string;
    targetSnapshotId: string;
    activationRevision: number;
    schedulerVersion: string;
    policyDigest: string;
    mode: 'shadow' | 'active';
    assignment: 'control' | 'treatment';
    requestedSize: number;
    outcome: 'started';
    completedAt: null;
  };
  data: {
    outcome: 'decision_persisted';
    failureClass: null;
    servedDisposition: 'control' | 'treatment';
    servedItemCount: number;
    fallbackTracePersisted: null;
    completedAt: Date;
  };
}

export interface ExamTargetDecisionPersistenceClient<
  TTransaction extends ExamTargetDecisionTransaction = ExamTargetDecisionTransaction,
> {
  $transaction<T>(work: (transaction: TTransaction) => Promise<T>): Promise<T>;
}

export interface ExamTargetDecisionPersistenceReceipt {
  decisionSetId: string;
  serveDecisionFieldsByItemKey: ReadonlyMap<string, ExamTargetServeDecisionFields>;
}

export interface ExamTargetAtomicServeWriterContext<
  TTransaction extends ExamTargetDecisionTransaction,
> {
  transaction: TTransaction;
  receipt: ExamTargetDecisionPersistenceReceipt;
}

export type ExamTargetPersistenceFailureReason = 'validation_failed' | 'transaction_failed';

export interface ExamTargetPersistenceFailureReport {
  mode: ExamTargetDecisionMode;
  assignment: ExamTargetDecisionAssignment;
  failureReason: ExamTargetPersistenceFailureReason;
  failClosed: boolean;
}

export type ExamTargetDecisionPersistenceResult =
  | {
    status: 'persisted';
    servingDisposition: 'serve-control' | 'serve-treatment';
    receipt: ExamTargetDecisionPersistenceReceipt;
  }
  | {
    status: 'not-persisted';
    servingDisposition: 'serve-control';
    failureReason: ExamTargetPersistenceFailureReason;
  };

export type ExamTargetDecisionPersistenceErrorCode =
  | 'invalid_control_plane'
  | 'atomic_writer_required'
  | 'telemetry_invalid'
  | 'persistence_failed';

export class ExamTargetDecisionPersistenceError extends Error {
  readonly mustAbortServe = true;

  constructor(readonly code: ExamTargetDecisionPersistenceErrorCode) {
    super(`Exam-target decision persistence failed (${code})`);
    this.name = 'ExamTargetDecisionPersistenceError';
  }
}

export interface PersistExamTargetDecisionSetInput {
  decision: ExamTargetDecisionSetWriteInput;
  telemetry: ExamTargetDecisionTelemetry;
  items: readonly ExamTargetServeItemTelemetryInput[];
}

export interface PersistExamTargetDecisionSetDependencies<
  TTransaction extends ExamTargetDecisionTransaction,
> {
  client: ExamTargetDecisionPersistenceClient<TTransaction>;
  /** Must use the same HMAC-SHA256 keying policy as decision-set telemetry. */
  tokenizeItemKey: (itemKey: string) => string;
  writeServeDecisionTargets?: (
    context: ExamTargetAtomicServeWriterContext<TTransaction>,
  ) => Promise<void>;
  reportPersistenceFailure?: (report: ExamTargetPersistenceFailureReport) => void;
}

interface PreparedDecisionSet {
  createData: SchedulerDecisionSetCreateData;
  itemFields: Map<string, Omit<ExamTargetServeDecisionFields, 'decisionSetId'>>;
  attemptTransition: Omit<ExamTargetAttemptDecisionPersistArgs, 'data'> & {
    data: Omit<ExamTargetAttemptDecisionPersistArgs['data'], 'completedAt'>;
  } | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields do not match allowlist`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string;
function assertOpaqueId(value: unknown, label: string, nullable: true): asserts value is string | null;
function assertOpaqueId(value: unknown, label: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 200
    || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
}

function assertItemKey(value: unknown): asserts value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 512
    || !OPAQUE_ID.test(value)) {
    throw new TypeError('serve item key is invalid');
  }
}

function assertStableCode(value: unknown, label: string): asserts value is string;
function assertStableCode(value: unknown, label: string, nullable: true): asserts value is string | null;
function assertStableCode(value: unknown, label: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > 200 || !STABLE_CODE.test(value)) {
    throw new TypeError(`${label} must be a stable code`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum?: number,
): asserts value is number;
function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable: true,
): asserts value is number | null;
function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
  nullable = false,
): asserts value is number | null {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer in range`);
  }
}

function assertFiniteRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number;
function assertFiniteRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable: true,
): asserts value is number | null;
function assertFiniteRange(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable = false,
): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be finite and in range`);
  }
}

function assertDate(value: unknown, label: string): asserts value is Date;
function assertDate(value: unknown, label: string, nullable: true): asserts value is Date | null;
function assertDate(value: unknown, label: string, nullable = false): asserts value is Date | null {
  if (nullable && value === null) return;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid Date`);
  }
}

function assertNullableHash(value: unknown, label: string): asserts value is string | null {
  if (value === null) return;
  assertSha256(value, label);
}

function assertNullableDomain(value: unknown): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > 80 || !DOMAIN_CODE.test(value)) {
    throw new TypeError('target domain code is invalid');
  }
}

function assertNullableRank(value: unknown, label: string): asserts value is number | null {
  assertInteger(value, label, 0, Number.MAX_SAFE_INTEGER, true);
}

function stableMetric(value: number): number {
  const rounded = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function selectionDigest(itemTokens: readonly string[]): string {
  return hashExamTargetArtifact({
    schema: 'md3.exam-target-selection/v1',
    itemTokens,
  });
}

function targetMetadataPresent(decision: ExamTargetDecisionSetWriteInput): boolean {
  return decision.targetSnapshotId !== null;
}

function validateControlPlane(value: unknown): {
  mode: ExamTargetDecisionMode;
  assignment: ExamTargetDecisionAssignment;
  activeTreatment: boolean;
} {
  if (!isPlainRecord(value)
    || typeof value.mode !== 'string'
    || !MODES.has(value.mode as ExamTargetDecisionMode)
    || typeof value.assignment !== 'string'
    || !ASSIGNMENTS.has(value.assignment as ExamTargetDecisionAssignment)) {
    throw new ExamTargetDecisionPersistenceError('invalid_control_plane');
  }
  const mode = value.mode as ExamTargetDecisionMode;
  const assignment = value.assignment as ExamTargetDecisionAssignment;
  if (assignment === 'treatment' && mode !== 'active'
    || mode === 'shadow' && assignment !== 'control'
    || mode === 'active' && assignment === 'unassigned') {
    throw new ExamTargetDecisionPersistenceError('invalid_control_plane');
  }
  return { mode, assignment, activeTreatment: mode === 'active' && assignment === 'treatment' };
}

function validateSourcePolicy(value: unknown): { allowed: string[]; max: number } | null {
  if (value === null) return null;
  assertExactFields(value, SOURCE_POLICY_FIELDS, 'source policy');
  if (!Array.isArray(value.allowed) || value.allowed.length > 16) {
    throw new TypeError('source policy allowed list is invalid');
  }
  const allowed = value.allowed.map((source) => {
    assertStableCode(source, 'source policy source');
    return source;
  });
  if (new Set(allowed).size !== allowed.length) {
    throw new TypeError('source policy sources must be unique');
  }
  if (allowed.some((source, index) => index > 0 && allowed[index - 1]! > source)) {
    throw new TypeError('source policy sources must be canonically sorted');
  }
  assertInteger(value.max, 'source policy maximum', 0, MAX_EXAM_TARGET_REPLAY_SELECTION);
  return { allowed, max: value.max };
}

function validateMasteryTelemetry(
  value: unknown,
): ExamTargetPersistedMasteryTelemetry | null {
  if (value === null) return null;
  assertExactFields(value, MASTERY_TELEMETRY_FIELDS, 'mastery telemetry');
  assertStableCode(value.policyVersion, 'mastery policy version', true);
  assertInteger(value.requiredTargetWorkToday, 'required target work today', 0, Number.MAX_SAFE_INTEGER, true);
  assertInteger(value.remainingTargetWorkToday, 'remaining target work today', 0, Number.MAX_SAFE_INTEGER, true);
  assertInteger(value.coreTargetSeats, 'core target seats', 0, MAX_EXAM_TARGET_REPLAY_SELECTION, true);
  assertInteger(value.coreTargetSeatsSelected, 'core target seats selected', 0, MAX_EXAM_TARGET_REPLAY_SELECTION);
  assertInteger(value.coreTargetSeatShortfall, 'core target seat shortfall', 0, MAX_EXAM_TARGET_REPLAY_SELECTION);
  assertInteger(value.surplusSeats, 'surplus seats', 0, MAX_EXAM_TARGET_REPLAY_SELECTION, true);
  assertInteger(value.surplusTargetSeatsSelected, 'surplus target seats selected', 0, MAX_EXAM_TARGET_REPLAY_SELECTION);
  if (value.workloadOnTrack !== null && typeof value.workloadOnTrack !== 'boolean') {
    throw new TypeError('mastery workload on-track flag is invalid');
  }
  assertInteger(value.workloadShortfall, 'mastery workload shortfall', 0, Number.MAX_SAFE_INTEGER, true);
  if (!Array.isArray(value.loadWarnings) || value.loadWarnings.length > 32) {
    throw new TypeError('mastery load warnings are invalid');
  }
  const loadWarnings = value.loadWarnings.map((warning) => {
    assertStableCode(warning, 'mastery load warning');
    return warning;
  });
  if (!Array.isArray(value.coverageDebtDomainCodes) || value.coverageDebtDomainCodes.length > 64) {
    throw new TypeError('mastery coverage-debt domains are invalid');
  }
  const coverageDebtDomainCodes = value.coverageDebtDomainCodes.map((domainCode) => {
    if (typeof domainCode !== 'string' || !DOMAIN_CODE.test(domainCode)) {
      throw new TypeError('mastery coverage-debt domain is invalid');
    }
    return domainCode;
  });
  for (const [label, values] of [
    ['mastery load warnings', loadWarnings],
    ['mastery coverage-debt domains', coverageDebtDomainCodes],
  ] as const) {
    if (new Set(values).size !== values.length
      || values.some((entry, index) => index > 0 && values[index - 1]! > entry)) {
      throw new TypeError(`${label} must be unique and canonically sorted`);
    }
  }
  assertInteger(
    value.changedConceptMembershipCount,
    'changed concept membership count',
    0,
    MAX_EXAM_TARGET_DECISION_CANDIDATES,
  );
  if (typeof value.evaluationOnly !== 'boolean') {
    throw new TypeError('mastery evaluation-only flag is invalid');
  }
  assertInteger(
    value.curriculumCoverageDebtCount,
    'curriculum coverage-debt count',
    0,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  if (value.coreTargetSeats !== null) {
    const expectedShortfall = Math.max(
      0,
      value.coreTargetSeats - value.coreTargetSeatsSelected,
    );
    if (value.coreTargetSeatsSelected > value.coreTargetSeats
      || value.coreTargetSeatShortfall !== expectedShortfall) {
      throw new TypeError('mastery core quota summary is inconsistent');
    }
  }
  if (value.surplusSeats !== null
    && value.surplusTargetSeatsSelected > value.surplusSeats) {
    throw new TypeError('mastery surplus quota summary is inconsistent');
  }
  return {
    policyVersion: value.policyVersion,
    requiredTargetWorkToday: value.requiredTargetWorkToday,
    remainingTargetWorkToday: value.remainingTargetWorkToday,
    coreTargetSeats: value.coreTargetSeats,
    coreTargetSeatsSelected: value.coreTargetSeatsSelected,
    coreTargetSeatShortfall: value.coreTargetSeatShortfall,
    surplusSeats: value.surplusSeats,
    surplusTargetSeatsSelected: value.surplusTargetSeatsSelected,
    workloadOnTrack: value.workloadOnTrack,
    workloadShortfall: value.workloadShortfall,
    loadWarnings,
    coverageDebtDomainCodes,
    changedConceptMembershipCount: value.changedConceptMembershipCount,
    evaluationOnly: value.evaluationOnly,
    curriculumCoverageDebtCount: value.curriculumCoverageDebtCount,
  };
}

function validateTelemetry(
  value: unknown,
): { telemetry: ExamTargetDecisionTelemetry; replay: ExamTargetDecisionReplaySnapshot | null } {
  assertExactFields(value, TELEMETRY_FIELDS, 'decision telemetry');
  assertSha256(value.policyDigest, 'telemetry policy digest');
  assertSha256(value.candidateSetDigest, 'telemetry candidate digest');
  assertSha256(value.controlSelectionDigest, 'telemetry control digest');
  assertSha256(value.targetSelectionDigest, 'telemetry target digest');
  assertFiniteRange(value.selectedSetOverlap, 'selected-set overlap', 0, 1);
  assertInteger(value.changedMembershipCount, 'changed-membership count', 0);
  assertFiniteRange(value.controlMeanTargetScore, 'control mean target score', 0, 1, true);
  assertFiniteRange(value.targetMeanTargetScore, 'target mean target score', 0, 1, true);
  assertFiniteRange(value.pairedTargetLift, 'paired target lift', -1, 1, true);
  const replay = value.replaySnapshot === null
    ? null
    : parseExamTargetDecisionReplaySnapshot(value.replaySnapshot);
  return {
    telemetry: {
      policyDigest: value.policyDigest,
      candidateSetDigest: value.candidateSetDigest,
      controlSelectionDigest: value.controlSelectionDigest,
      targetSelectionDigest: value.targetSelectionDigest,
      selectedSetOverlap: value.selectedSetOverlap,
      changedMembershipCount: value.changedMembershipCount,
      controlMeanTargetScore: value.controlMeanTargetScore,
      targetMeanTargetScore: value.targetMeanTargetScore,
      pairedTargetLift: value.pairedTargetLift,
      replaySnapshot: replay,
    },
    replay,
  };
}

function validateDecision(
  value: unknown,
  telemetry: ExamTargetDecisionTelemetry,
  replay: ExamTargetDecisionReplaySnapshot | null,
): ExamTargetDecisionSetWriteInput & {
  attemptId: string | null;
  sourcePolicy: { allowed: string[]; max: number } | null;
} {
  const hasAttemptField = isPlainRecord(value)
    && Object.prototype.hasOwnProperty.call(value, 'attemptId');
  assertExactFields(
    value,
    hasAttemptField ? DECISION_FIELDS_WITH_ATTEMPT : DECISION_FIELDS,
    'decision set',
  );
  const attemptId = hasAttemptField ? value.attemptId : null;
  assertSha256(value.decisionKey, 'decision key');
  assertOpaqueId(attemptId, 'attempt id', true);
  assertOpaqueId(value.userId, 'user id');
  assertOpaqueId(value.sessionId, 'session id');
  assertOpaqueId(value.batchId, 'batch id', true);
  if (typeof value.rotation !== 'string' || !ROTATIONS.has(value.rotation as ExamTargetRotation)) {
    throw new TypeError('decision rotation is invalid');
  }
  assertStableCode(value.decisionPath, 'decision path');
  assertDate(value.decidedAt, 'decision timestamp');
  assertStableCode(value.schedulerVersion, 'scheduler version');
  if (typeof value.mode !== 'string' || !MODES.has(value.mode as ExamTargetDecisionMode)) {
    throw new TypeError('decision mode is invalid');
  }
  if (typeof value.assignment !== 'string'
    || !ASSIGNMENTS.has(value.assignment as ExamTargetDecisionAssignment)) {
    throw new TypeError('decision assignment is invalid');
  }
  assertStableCode(value.targetPolicyVersion, 'target policy version');
  assertInteger(value.activationRevision, 'activation revision', 1, Number.MAX_SAFE_INTEGER, true);
  assertOpaqueId(value.targetSnapshotId, 'target snapshot id', true);
  if (value.targetId !== null
    && (typeof value.targetId !== 'string' || value.targetId.length > 180 || !TARGET_ID.test(value.targetId))) {
    throw new TypeError('target id is invalid');
  }
  assertInteger(value.targetRevision, 'target revision', 1, Number.MAX_SAFE_INTEGER, true);
  if (value.targetBasis !== null
    && (typeof value.targetBasis !== 'string' || !BASES.has(value.targetBasis as ExamTargetBasis))) {
    throw new TypeError('target basis is invalid');
  }
  assertStableCode(value.targetScorerVersion, 'target scorer version', true);
  assertInteger(value.daysToExam, 'days to exam', -365, 3_650, true);
  assertStableCode(value.pressureBucket, 'pressure bucket', true);
  assertStableCode(value.learnerStateVersion, 'learner state version', true);
  const sourcePolicy = validateSourcePolicy(value.sourcePolicy);
  const masteryTelemetry = validateMasteryTelemetry(value.masteryTelemetry);
  assertSha256(value.tieBreakSeed, 'tie-break seed');
  assertInteger(value.requestedSize, 'requested size', 0, MAX_EXAM_TARGET_REPLAY_SELECTION);
  assertInteger(value.candidateCount, 'candidate count', 0, MAX_EXAM_TARGET_DECISION_CANDIDATES);
  assertInteger(value.eligibleCount, 'eligible count', 0, value.candidateCount);
  assertInteger(value.targetEligibleCount, 'target-eligible count', 0, value.eligibleCount);
  assertInteger(value.controlSelectedCount, 'control selected count', 0, value.requestedSize);
  assertInteger(value.targetSelectedCount, 'target selected count', 0, value.requestedSize);
  assertFiniteRange(value.controlAllocationError, 'control allocation error', 0, 1, true);
  assertFiniteRange(value.targetAllocationError, 'target allocation error', 0, 1, true);
  assertInteger(value.targetComputeMs, 'target compute time', 0, Number.MAX_SAFE_INTEGER, true);
  assertStableCode(value.fallbackReason, 'fallback reason', true);
  assertInteger(value.traceVersion, 'trace version', 1, 1);
  assertDate(value.replayCapturedAt, 'replay capture timestamp', true);
  assertDate(value.replayExpiresAt, 'replay expiry timestamp', true);

  const targetValues = [
    value.targetSnapshotId,
    value.targetId,
    value.targetRevision,
    value.targetBasis,
    value.targetScorerVersion,
  ];
  const hasAnyTarget = targetValues.some(target => target !== null);
  const hasAllTarget = targetValues.every(target => target !== null);
  if (hasAnyTarget !== hasAllTarget) throw new TypeError('target provenance must be complete or absent');
  if ((value.mode === 'shadow' || value.mode === 'active') && !hasAllTarget) {
    throw new TypeError('shadow and active decisions require target provenance');
  }
  if (hasAllTarget && value.activationRevision === null) {
    throw new TypeError('target provenance requires activation revision');
  }
  if (!hasAllTarget && value.activationRevision !== null) {
    throw new TypeError('activation revision requires target provenance');
  }
  if (value.mode === 'off' && hasAllTarget) {
    throw new TypeError('off decisions cannot retain target provenance');
  }
  if (hasAllTarget) {
    if (attemptId === null) {
      throw new TypeError('target-aware decisions require an admitted attempt');
    }
    assertUuid(value.sessionId, 'target-aware session id');
    assertUuid(value.batchId, 'target-aware batch id');
    if ((value.mode !== 'shadow' && value.mode !== 'active')
      || (value.assignment !== 'control' && value.assignment !== 'treatment')) {
      throw new TypeError('target-aware attempt identity requires a serving mode and assignment');
    }
    assertInteger(value.requestedSize, 'target-aware requested size', 1, 100);
  } else if (attemptId !== null) {
    throw new TypeError('non-target decisions cannot link an exam-target attempt');
  }
  if (value.controlSelectedCount > value.eligibleCount
    || value.targetSelectedCount > value.eligibleCount) {
    throw new TypeError('selected counts cannot exceed eligible count');
  }
  const overlapDenominator = Math.max(value.controlSelectedCount, value.targetSelectedCount);
  const intersection = value.targetSelectedCount - telemetry.changedMembershipCount;
  const expectedOverlap = overlapDenominator === 0
    ? 1
    : intersection < 0
      ? -1
      : stableMetric(intersection / overlapDenominator);
  if (intersection > value.controlSelectedCount || telemetry.selectedSetOverlap !== expectedOverlap) {
    throw new TypeError('paired membership metrics do not match selected counts');
  }
  const expectedLift = telemetry.controlMeanTargetScore === null
    || telemetry.targetMeanTargetScore === null
    ? null
    : stableMetric(telemetry.targetMeanTargetScore - telemetry.controlMeanTargetScore);
  if (telemetry.pairedTargetLift !== expectedLift) {
    throw new TypeError('paired target lift does not match selected means');
  }

  if (replay === null) {
    if (value.replayCapturedAt !== null || value.replayExpiresAt !== null) {
      throw new TypeError('replay timestamps require a replay snapshot');
    }
  } else {
    if (!(value.replayCapturedAt instanceof Date) || !(value.replayExpiresAt instanceof Date)) {
      throw new TypeError('sampled replay requires retention timestamps');
    }
    const retention = value.replayExpiresAt.getTime() - value.replayCapturedAt.getTime();
    if (retention <= 0 || retention > MAX_REPLAY_RETENTION_MS) {
      throw new TypeError('sampled replay retention is outside the 30-day contract');
    }
    if (replay.policyDigest !== telemetry.policyDigest
      || replay.candidateSetDigest !== telemetry.candidateSetDigest
      || replay.deterministicSeed !== value.tieBreakSeed
      || replay.requestedSize !== value.requestedSize
      || replay.candidates.length !== value.candidateCount
      || replay.expected.controlSelectionTokens.length !== value.controlSelectedCount
      || replay.expected.targetSelectionTokens.length !== value.targetSelectedCount
      || replay.expected.controlSelectionDigest !== telemetry.controlSelectionDigest
      || replay.expected.targetSelectionDigest !== telemetry.targetSelectionDigest
      || replay.expected.selectedSetOverlap !== telemetry.selectedSetOverlap
      || replay.expected.changedMembershipCount !== telemetry.changedMembershipCount
      || replay.expected.controlMeanTargetScore !== telemetry.controlMeanTargetScore
      || replay.expected.targetMeanTargetScore !== telemetry.targetMeanTargetScore
      || replay.expected.pairedTargetLift !== telemetry.pairedTargetLift) {
      throw new TypeError('sampled replay does not match decision telemetry');
    }
  }

  return {
    decisionKey: value.decisionKey,
    attemptId,
    userId: value.userId,
    sessionId: value.sessionId,
    batchId: value.batchId,
    rotation: value.rotation as ExamTargetRotation,
    decisionPath: value.decisionPath,
    decidedAt: value.decidedAt,
    schedulerVersion: value.schedulerVersion,
    mode: value.mode as ExamTargetDecisionMode,
    assignment: value.assignment as ExamTargetDecisionAssignment,
    targetPolicyVersion: value.targetPolicyVersion,
    activationRevision: value.activationRevision,
    targetSnapshotId: value.targetSnapshotId,
    targetId: value.targetId,
    targetRevision: value.targetRevision,
    targetBasis: value.targetBasis as ExamTargetBasis | null,
    targetScorerVersion: value.targetScorerVersion,
    daysToExam: value.daysToExam,
    pressureBucket: value.pressureBucket,
    learnerStateVersion: value.learnerStateVersion,
    sourcePolicy,
    masteryTelemetry,
    tieBreakSeed: value.tieBreakSeed,
    requestedSize: value.requestedSize,
    candidateCount: value.candidateCount,
    eligibleCount: value.eligibleCount,
    targetEligibleCount: value.targetEligibleCount,
    controlSelectedCount: value.controlSelectedCount,
    targetSelectedCount: value.targetSelectedCount,
    controlAllocationError: value.controlAllocationError,
    targetAllocationError: value.targetAllocationError,
    targetComputeMs: value.targetComputeMs,
    fallbackReason: value.fallbackReason,
    traceVersion: value.traceVersion,
    replayCapturedAt: value.replayCapturedAt,
    replayExpiresAt: value.replayExpiresAt,
  };
}

function validateAndProjectItems(
  values: unknown,
  decision: ExamTargetDecisionSetWriteInput,
  telemetry: ExamTargetDecisionTelemetry,
  replay: ExamTargetDecisionReplaySnapshot | null,
  tokenizeItemKey: (itemKey: string) => string,
): Map<string, Omit<ExamTargetServeDecisionFields, 'decisionSetId'>> {
  if (!Array.isArray(values) || values.length > MAX_EXAM_TARGET_REPLAY_SELECTION) {
    throw new TypeError('serve target items must be a bounded array');
  }
  const selectedCount = decision.assignment === 'treatment'
    ? decision.targetSelectedCount
    : decision.controlSelectedCount;
  if (values.length !== selectedCount) {
    throw new TypeError('serve target item count does not match selected count');
  }
  const itemKeys = new Set<string>();
  const itemTokens = new Set<string>();
  const projected = new Map<string, Omit<ExamTargetServeDecisionFields, 'decisionSetId'>>();
  const orderedTokens: string[] = [];
  let targetScoreTotal = 0;
  let targetScoreCount = 0;
  let changedMembershipCount = 0;
  const hasTarget = targetMetadataPresent(decision);
  const targetVersion = hasTarget ? `${decision.targetId}@${decision.targetRevision}` : null;
  const replayCandidatesByToken = replay === null
    ? null
    : new Map(replay.candidates.map(candidate => [candidate.itemToken, candidate]));
  const replayTargetRanks = replay === null
    ? null
    : new Map(replay.expected.targetSelectionTokens.map((token, rank) => [token, rank]));
  const replayCounterpartTokens = replay === null
    ? null
    : new Set(decision.assignment === 'treatment'
      ? replay.expected.controlSelectionTokens
      : replay.expected.targetSelectionTokens);

  for (const [finalRank, value] of values.entries()) {
    assertExactFields(value, ITEM_FIELDS, 'serve target item');
    assertItemKey(value.itemKey);
    assertSha256(value.itemToken, 'serve item token');
    let expectedItemToken: string;
    try {
      expectedItemToken = tokenizeItemKey(value.itemKey);
    } catch {
      throw new TypeError('serve item tokenization failed');
    }
    assertSha256(expectedItemToken, 'recomputed serve item token');
    if (value.itemToken !== expectedItemToken) {
      throw new TypeError('serve item token does not match its HMAC join key');
    }
    if (itemKeys.has(value.itemKey) || itemTokens.has(value.itemToken)) {
      throw new TypeError('serve target item keys and tokens must be unique');
    }
    itemKeys.add(value.itemKey);
    itemTokens.add(value.itemToken);
    orderedTokens.push(value.itemToken);
    assertStableCode(value.sourceRotation, 'source rotation');
    if (typeof value.slotClass !== 'string'
      || !SLOT_CLASSES.has(value.slotClass as ExamTargetSlotClass)) {
      throw new TypeError('serve target slot class is invalid');
    }
    if (typeof value.targetEligible !== 'boolean'
      || typeof value.targetApplied !== 'boolean'
      || typeof value.targetChangedMembership !== 'boolean') {
      throw new TypeError('serve target booleans are invalid');
    }
    if (value.targetChangedMembership) changedMembershipCount += 1;
    assertStableCode(value.targetBypassReason, 'target bypass reason', true);
    assertNullableHash(value.targetEmbeddingHash, 'target embedding hash');
    assertNullableDomain(value.targetDomainCode);
    assertFiniteRange(value.examRelevancePct, 'exam relevance percentile', 0, 1, true);
    assertFiniteRange(value.examDomainWeight, 'exam domain weight', 0, 1, true);
    assertFiniteRange(value.userDomainGap, 'user domain gap', 0, 1, true);
    assertFiniteRange(value.contentTargetScore, 'content target score', 0, 1, true);
    assertFiniteRange(value.personalizedTargetScore, 'personalized target score', 0, 1, true);
    assertStableCode(value.targetWeightProvenance, 'target weight provenance', true);
    assertFiniteRange(value.targetBoostDelta, 'target boost delta', -5, 0, true);
    assertNullableRank(value.baseRankInPool, 'base pool rank');
    assertNullableRank(value.targetRankInPool, 'target pool rank');
    assertNullableRank(value.finalRankInPool, 'final pool rank');
    if (value.finalRankInPool !== finalRank) {
      throw new TypeError('final pool ranks must match the persisted selection order');
    }
    assertInteger(value.targetCacheAgeMs, 'target cache age', 0, Number.MAX_SAFE_INTEGER, true);
    if (!Array.isArray(value.constraintCodes)) {
      throw new TypeError('target constraint codes must be an array');
    }
    if (decision.assignment !== 'treatment' && value.targetApplied) {
      throw new TypeError('control decisions cannot mark target influence as applied');
    }
    if (value.targetApplied && (!value.targetEligible || !hasTarget)) {
      throw new TypeError('applied target influence requires eligible target provenance');
    }
    if (value.targetEligible && !hasTarget) {
      throw new TypeError('target eligibility requires target provenance');
    }
    if (value.targetEligible && (
      value.targetEmbeddingHash === null
      || value.targetDomainCode === null
      || value.examRelevancePct === null
      || value.examDomainWeight === null
      || value.userDomainGap === null
      || value.contentTargetScore === null
      || value.personalizedTargetScore === null
      || value.targetWeightProvenance === null
    )) {
      throw new TypeError('target-eligible items require complete scalar provenance');
    }
    if (value.personalizedTargetScore !== null) {
      targetScoreTotal += value.personalizedTargetScore;
      targetScoreCount += 1;
    }

    const replayCandidate = replayCandidatesByToken?.get(value.itemToken);
    if (replay !== null && replayCandidate === undefined) {
      throw new TypeError('serve target item is absent from sampled replay candidates');
    }
    if (replayCandidate !== undefined) {
      const expectedTargetRank = replayTargetRanks?.get(value.itemToken) ?? null;
      const expectedChangedMembership = !replayCounterpartTokens?.has(value.itemToken);
      if (value.slotClass !== replayCandidate.slotClass
        || value.targetDomainCode !== replayCandidate.domainCode
        || value.baseRankInPool !== replayCandidate.baseRank
        || value.targetRankInPool !== expectedTargetRank
        || value.targetEligible !== replayCandidate.targetEligible
        || value.personalizedTargetScore !== replayCandidate.targetScore
        || value.targetChangedMembership !== expectedChangedMembership) {
        throw new TypeError('serve target scalar fields do not match sampled replay');
      }
    } else if (decision.assignment === 'treatment' && value.targetRankInPool !== finalRank) {
      throw new TypeError('treatment target ranks must match the persisted selection order');
    }

    const targetTrace = targetVersion === null
      ? null
      : parseExamTargetTrace({
        schema: 'md3.exam-target-trace/v1',
        targetVersion,
        domainCode: value.targetDomainCode,
        constraintCodes: value.constraintCodes,
        components: {
          examRelevancePct: value.examRelevancePct,
          examDomainWeight: value.examDomainWeight,
          userDomainGap: value.userDomainGap,
          contentTargetScore: value.contentTargetScore,
          personalizedTargetScore: value.personalizedTargetScore,
          targetBoostDelta: value.targetBoostDelta,
        },
        policyDigest: telemetry.policyDigest,
        candidateSetDigest: telemetry.candidateSetDigest,
      });

    projected.set(value.itemKey, {
      examTargetSnapshotId: decision.targetSnapshotId,
      schedulerVersion: decision.schedulerVersion,
      targetPolicyVersion: decision.targetPolicyVersion,
      targetMode: decision.mode,
      targetAssignment: decision.assignment,
      targetId: decision.targetId,
      targetRevision: decision.targetRevision,
      targetBasis: decision.targetBasis,
      targetScorerVersion: decision.targetScorerVersion,
      targetEmbeddingHash: value.targetEmbeddingHash,
      targetActivationRevision: decision.activationRevision,
      targetRotation: hasTarget ? decision.rotation : null,
      sourceRotation: value.sourceRotation,
      slotClass: value.slotClass as ExamTargetSlotClass,
      targetEligible: value.targetEligible,
      targetApplied: value.targetApplied,
      targetBypassReason: value.targetBypassReason,
      targetDomainCode: value.targetDomainCode,
      targetPressureBucket: decision.pressureBucket,
      examRelevancePct: value.examRelevancePct,
      examDomainWeight: value.examDomainWeight,
      userDomainGap: value.userDomainGap,
      contentTargetScore: value.contentTargetScore,
      personalizedTargetScore: value.personalizedTargetScore,
      targetWeightProvenance: value.targetWeightProvenance,
      targetBoostDelta: value.targetBoostDelta,
      baseRankInPool: value.baseRankInPool,
      targetRankInPool: value.targetRankInPool,
      finalRankInPool: value.finalRankInPool,
      targetChangedMembership: value.targetChangedMembership,
      targetCacheAgeMs: value.targetCacheAgeMs,
      targetTraceVersion: targetTrace === null ? null : 1,
      targetTrace,
    });
  }

  const expectedSelectionDigest = decision.assignment === 'treatment'
    ? telemetry.targetSelectionDigest
    : telemetry.controlSelectionDigest;
  if (selectionDigest(orderedTokens) !== expectedSelectionDigest) {
    throw new TypeError('ordered serve item tokens do not match the selected digest');
  }
  if (replay) {
    const expectedTokens = decision.assignment === 'treatment'
      ? replay.expected.targetSelectionTokens
      : replay.expected.controlSelectionTokens;
    if (orderedTokens.length !== expectedTokens.length
      || orderedTokens.some((token, index) => token !== expectedTokens[index])) {
      throw new TypeError('ordered serve item tokens do not match sampled replay');
    }
  } else if (decision.assignment === 'treatment'
    && changedMembershipCount !== telemetry.changedMembershipCount) {
    throw new TypeError('serve membership changes do not match paired telemetry');
  }
  const selectedMean = targetScoreCount === 0 ? null : stableMetric(targetScoreTotal / targetScoreCount);
  const expectedMean = decision.assignment === 'treatment'
    ? telemetry.targetMeanTargetScore
    : telemetry.controlMeanTargetScore;
  if (selectedMean !== expectedMean) {
    throw new TypeError('serve item target scores do not match paired telemetry');
  }

  return projected;
}

function buildCreateData(
  decision: ExamTargetDecisionSetWriteInput & {
    attemptId: string | null;
    sourcePolicy: { allowed: string[]; max: number } | null;
  },
  telemetry: ExamTargetDecisionTelemetry,
  replay: ExamTargetDecisionReplaySnapshot | null,
): SchedulerDecisionSetCreateData {
  const data: SchedulerDecisionSetCreateData = {
    decisionKey: decision.decisionKey,
    attemptId: decision.attemptId,
    userId: decision.userId,
    sessionId: decision.sessionId,
    batchId: decision.batchId,
    rotation: decision.rotation,
    decisionPath: decision.decisionPath,
    decidedAt: decision.decidedAt,
    schedulerVersion: decision.schedulerVersion,
    mode: decision.mode,
    assignment: decision.assignment,
    targetPolicyVersion: decision.targetPolicyVersion,
    policyDigest: telemetry.policyDigest,
    activationRevision: decision.activationRevision,
    targetSnapshotId: decision.targetSnapshotId,
    targetId: decision.targetId,
    targetRevision: decision.targetRevision,
    targetBasis: decision.targetBasis,
    targetScorerVersion: decision.targetScorerVersion,
    daysToExam: decision.daysToExam,
    pressureBucket: decision.pressureBucket,
    learnerStateVersion: decision.learnerStateVersion,
    sourcePolicy: decision.sourcePolicy,
    masteryTelemetry: decision.masteryTelemetry,
    candidateSetDigest: telemetry.candidateSetDigest,
    tieBreakSeed: decision.tieBreakSeed,
    requestedSize: decision.requestedSize,
    candidateCount: decision.candidateCount,
    eligibleCount: decision.eligibleCount,
    targetEligibleCount: decision.targetEligibleCount,
    controlSelectedCount: decision.controlSelectedCount,
    targetSelectedCount: decision.targetSelectedCount,
    controlSelectionDigest: telemetry.controlSelectionDigest,
    targetSelectionDigest: telemetry.targetSelectionDigest,
    selectedSetOverlap: telemetry.selectedSetOverlap,
    changedMembershipCount: telemetry.changedMembershipCount,
    controlMeanTargetScore: telemetry.controlMeanTargetScore,
    targetMeanTargetScore: telemetry.targetMeanTargetScore,
    pairedTargetLift: telemetry.pairedTargetLift,
    controlAllocationError: decision.controlAllocationError,
    targetAllocationError: decision.targetAllocationError,
    targetComputeMs: decision.targetComputeMs,
    fallbackReason: decision.fallbackReason,
    traceVersion: decision.traceVersion,
    replaySnapshot: replay,
    replayCapturedAt: decision.replayCapturedAt,
    replayExpiresAt: decision.replayExpiresAt,
  };
  const sizeEnvelope = {
    ...data,
    decidedAt: data.decidedAt.toISOString(),
    replayCapturedAt: data.replayCapturedAt?.toISOString() ?? null,
    replayExpiresAt: data.replayExpiresAt?.toISOString() ?? null,
  };
  const size = new TextEncoder().encode(canonicalExamTargetJson(sizeEnvelope)).byteLength;
  if (size > MAX_EXAM_TARGET_PERSISTED_DECISION_BYTES) {
    throw new TypeError('persisted exam-target decision exceeds its size contract');
  }
  return data;
}

function prepareDecisionSet(
  input: PersistExamTargetDecisionSetInput,
  tokenizeItemKey: (itemKey: string) => string,
): PreparedDecisionSet {
  assertExactFields(input, ['decision', 'telemetry', 'items'], 'persistence input');
  const validatedTelemetry = validateTelemetry(input.telemetry);
  const decision = validateDecision(
    input.decision,
    validatedTelemetry.telemetry,
    validatedTelemetry.replay,
  );
  const itemFields = validateAndProjectItems(
    input.items,
    decision,
    validatedTelemetry.telemetry,
    validatedTelemetry.replay,
    tokenizeItemKey,
  );
  const attemptTransition = decision.attemptId === null
    ? null
    : {
      where: {
        id: decision.attemptId,
        userId: decision.userId,
        sessionId: decision.sessionId,
        batchId: decision.batchId!,
        rotation: decision.rotation,
        decisionPath: decision.decisionPath,
        targetSnapshotId: decision.targetSnapshotId!,
        activationRevision: decision.activationRevision!,
        schedulerVersion: decision.schedulerVersion,
        policyDigest: validatedTelemetry.telemetry.policyDigest,
        mode: decision.mode as 'shadow' | 'active',
        assignment: decision.assignment as 'control' | 'treatment',
        requestedSize: decision.requestedSize,
        outcome: 'started' as const,
        completedAt: null,
      },
      data: {
        outcome: 'decision_persisted' as const,
        failureClass: null,
        servedDisposition: decision.assignment as 'control' | 'treatment',
        servedItemCount: itemFields.size,
        fallbackTracePersisted: null,
      },
    };
  if (attemptTransition !== null && itemFields.size === 0) {
    throw new TypeError('target-aware decision persistence requires served items');
  }
  return {
    createData: buildCreateData(decision, validatedTelemetry.telemetry, validatedTelemetry.replay),
    itemFields,
    attemptTransition,
  };
}

function reportFailure(
  report: ExamTargetPersistenceFailureReport,
  reporter?: (value: ExamTargetPersistenceFailureReport) => void,
): void {
  try {
    reporter?.(report);
  } catch {
    // Reporting cannot weaken the serving disposition or expose the raw write error.
  }
}

function failedControlResult(
  failureReason: ExamTargetPersistenceFailureReason,
): ExamTargetDecisionPersistenceResult {
  return {
    status: 'not-persisted',
    servingDisposition: 'serve-control',
    failureReason,
  };
}

export async function persistExamTargetDecisionSet<
  TTransaction extends ExamTargetDecisionTransaction,
>(
  input: PersistExamTargetDecisionSetInput,
  dependencies: PersistExamTargetDecisionSetDependencies<TTransaction>,
): Promise<ExamTargetDecisionPersistenceResult> {
  const controlPlane = validateControlPlane(input?.decision);
  if (controlPlane.activeTreatment && !dependencies.writeServeDecisionTargets) {
    reportFailure({
      mode: controlPlane.mode,
      assignment: controlPlane.assignment,
      failureReason: 'validation_failed',
      failClosed: true,
    }, dependencies.reportPersistenceFailure);
    throw new ExamTargetDecisionPersistenceError('atomic_writer_required');
  }

  let prepared: PreparedDecisionSet;
  try {
    prepared = prepareDecisionSet(input, dependencies.tokenizeItemKey);
  } catch {
    reportFailure({
      mode: controlPlane.mode,
      assignment: controlPlane.assignment,
      failureReason: 'validation_failed',
      failClosed: controlPlane.activeTreatment,
    }, dependencies.reportPersistenceFailure);
    if (controlPlane.activeTreatment) {
      throw new ExamTargetDecisionPersistenceError('telemetry_invalid');
    }
    return failedControlResult('validation_failed');
  }

  try {
    const receipt = await dependencies.client.$transaction(async (transaction) => {
      const created = await transaction.schedulerDecisionSet.create({
        data: prepared.createData,
        select: { id: true },
      });
      assertOpaqueId(created?.id, 'created decision-set id');
      if (prepared.attemptTransition !== null) {
        if (!transaction.examTargetDecisionAttempt) {
          throw new Error('exam_target_attempt_transaction_delegate_missing');
        }
        const attemptMutation = await transaction.examTargetDecisionAttempt.updateMany({
          where: prepared.attemptTransition.where,
          data: {
            ...prepared.attemptTransition.data,
            completedAt: new Date(),
          },
        });
        if (attemptMutation.count !== 1) {
          throw new Error('exam_target_attempt_transition_failed');
        }
      }
      const serveDecisionFieldsByItemKey = new Map(
        [...prepared.itemFields].map(([itemKey, fields]) => [
          itemKey,
          { decisionSetId: created.id, ...fields },
        ]),
      );
      const transactionReceipt: ExamTargetDecisionPersistenceReceipt = {
        decisionSetId: created.id,
        serveDecisionFieldsByItemKey,
      };
      await dependencies.writeServeDecisionTargets?.({
        transaction,
        receipt: transactionReceipt,
      });
      return transactionReceipt;
    });
    return {
      status: 'persisted',
      servingDisposition: controlPlane.activeTreatment ? 'serve-treatment' : 'serve-control',
      receipt,
    };
  } catch {
    reportFailure({
      mode: controlPlane.mode,
      assignment: controlPlane.assignment,
      failureReason: 'transaction_failed',
      failClosed: controlPlane.activeTreatment,
    }, dependencies.reportPersistenceFailure);
    if (controlPlane.activeTreatment) {
      throw new ExamTargetDecisionPersistenceError('persistence_failed');
    }
    return failedControlResult('transaction_failed');
  }
}
