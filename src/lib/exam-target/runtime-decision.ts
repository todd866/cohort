import type { UnifiedSessionExamTargetDecision } from '../knowledge/unified-scheduler';
import type { ExamTargetSlotClass } from './allocator';
import {
  buildExamTargetDecisionTelemetry,
  MAX_EXAM_TARGET_DECISION_CANDIDATES,
  MAX_EXAM_TARGET_REPLAY_CANDIDATES,
  MAX_EXAM_TARGET_REPLAY_SELECTION,
  type ExamTargetDecisionCandidate,
  type ExamTargetDecisionTelemetry,
} from './decision-set';
import type {
  ExamTargetDecisionSetWriteInput,
  ExamTargetPersistedMasteryTelemetry,
  ExamTargetPersistedSourcePolicy,
  ExamTargetServeItemTelemetryInput,
} from './decision-set-persistence.server';
import type { ExamTargetTrace } from './trace';
import type {
  ExamTargetBasis,
  ExamTargetRotation,
} from './types';

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/;
const STABLE_CODE = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const DOMAIN_CODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TARGET_ID = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const INPUT_FIELDS = [
  'identity',
  'controlItems',
  'targetItems',
  'schedulerDecision',
  'controlPlane',
  'activationSnapshot',
  'protectedRelearnCardIds',
  'requestedSize',
  'targetComputeMs',
  'tieBreakSeed',
  'sourcePolicy',
  'tokenizeItemKey',
  'now',
] as const;
const IDENTITY_FIELDS = [
  'decisionKey',
  'attemptId',
  'userId',
  'sessionId',
  'batchId',
  'rotation',
  'decisionPath',
] as const;
const CONTROL_PLANE_FIELDS = ['mode', 'assignment', 'fallbackReason'] as const;
const SNAPSHOT_FIELDS = [
  'id',
  'targetId',
  'revision',
  'targetVersion',
  'rotation',
  'lifecycle',
  'privacyValidated',
  'targetBasis',
  'scorerVersion',
  'targetPolicyVersion',
  'artifactHash',
] as const;
const SOURCE_POLICY_FIELDS = ['allowed', 'max'] as const;
const ITEM_FIELDS = ['itemKey', 'sourceRotation', 'due', 'scaffold', 'failure'] as const;
const REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const BASES = new Set<ExamTargetBasis>(['official', 'hybrid', 'proxy']);
const ROTATIONS = new Set<ExamTargetRotation>(['critical-care', 'paam', 'cah', 'pwh']);

export interface RuntimeExamTargetDecisionIdentity {
  decisionKey: string;
  /** Identity returned by the fail-closed pre-compute admission gate. */
  attemptId: string;
  userId: string;
  sessionId: string;
  batchId: string | null;
  rotation: ExamTargetRotation;
  decisionPath: string;
}

/** Scalar-only final item shape; content, paths and embeddings are not accepted. */
export interface RuntimeExamTargetFinalItemScalar {
  itemKey: string;
  sourceRotation: string;
  due: boolean;
  scaffold: boolean;
  failure: boolean;
}

export interface RuntimeExamTargetControlPlane {
  mode: 'shadow' | 'active';
  assignment: 'control' | 'treatment';
  fallbackReason: string | null;
}

export interface RuntimeExamTargetActivationSnapshotMetadata {
  id: string;
  targetId: string;
  revision: number;
  targetVersion: string;
  rotation: ExamTargetRotation;
  lifecycle: 'validated' | 'active';
  privacyValidated: boolean;
  targetBasis: ExamTargetBasis;
  scorerVersion: string;
  targetPolicyVersion: string;
  artifactHash: string;
}

export interface RuntimeExamTargetDecisionInput {
  identity: RuntimeExamTargetDecisionIdentity;
  controlItems: readonly RuntimeExamTargetFinalItemScalar[];
  targetItems: readonly RuntimeExamTargetFinalItemScalar[];
  /** Decision emitted by the deliberately forced active/treatment branch. */
  schedulerDecision: UnifiedSessionExamTargetDecision;
  /** Real resolved activation; this alone determines the branch actually served. */
  controlPlane: RuntimeExamTargetControlPlane;
  activationSnapshot: RuntimeExamTargetActivationSnapshotMetadata;
  protectedRelearnCardIds: readonly string[];
  requestedSize: number;
  /** Wall-clock latency of the paired control/target scheduler computation. */
  targetComputeMs: number;
  tieBreakSeed: string;
  sourcePolicy: ExamTargetPersistedSourcePolicy | null;
  /** Must be a deterministic HMAC-SHA256 tokenizer. */
  tokenizeItemKey: (itemKey: string) => string;
  now: Date;
}

export interface RuntimeExamTargetDecisionResult {
  decision: ExamTargetDecisionSetWriteInput;
  telemetry: ExamTargetDecisionTelemetry;
  items: readonly ExamTargetServeItemTelemetryInput[];
}

export type RuntimeExamTargetDecisionErrorCode =
  | 'invalid_identity'
  | 'invalid_control_plane'
  | 'invalid_snapshot_metadata'
  | 'invalid_scheduler_decision'
  | 'invalid_selection'
  | 'protected_pair_mismatch'
  | 'invalid_source_policy'
  | 'invalid_hmac'
  | 'invalid_telemetry';

export class RuntimeExamTargetDecisionError extends Error {
  constructor(readonly code: RuntimeExamTargetDecisionErrorCode) {
    super(`Runtime exam-target decision adaptation failed (${code})`);
    this.name = 'RuntimeExamTargetDecisionError';
  }
}

interface ValidatedFinalItem extends RuntimeExamTargetFinalItemScalar {
  slotClass: ExamTargetSlotClass;
}

interface TargetScalar {
  sourceRotation: string;
  baseRank: number;
  targetEligible: boolean;
  targetDomainCode: string | null;
  embeddingHash: string | null;
  examRelevancePct: number | null;
  examDomainWeight: number | null;
  userDomainGap: number | null;
  contentTargetScore: number | null;
  personalizedTargetScore: number | null;
  targetWeightProvenance: string | null;
}

interface BuiltCandidate {
  telemetry: ExamTargetDecisionCandidate;
  scalar: TargetScalar;
}

function fail(code: RuntimeExamTargetDecisionErrorCode): never {
  throw new RuntimeExamTargetDecisionError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: unknown, fields: readonly string[]): boolean {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function safeOpaqueId(value: unknown): value is string;
function safeOpaqueId(value: unknown, nullable: true): value is string | null;
function safeOpaqueId(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && OPAQUE_ID.test(value);
}

function safeStableCode(value: unknown): value is string;
function safeStableCode(value: unknown, nullable: true): value is string | null;
function safeStableCode(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true;
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && STABLE_CODE.test(value);
}

function safeTargetId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 180
    && !value.startsWith('/')
    && !value.includes('..')
    && TARGET_ID.test(value);
}

function safeItemKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && OPAQUE_ID.test(value);
}

function safeInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= minimum
    && (value as number) <= maximum;
}

function safeUnit(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function stableMetric(value: number): number {
  const rounded = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function classifySlot(
  item: RuntimeExamTargetFinalItemScalar,
  protectedRelearnCardIds: ReadonlySet<string>,
): ExamTargetSlotClass {
  const cardId = item.itemKey.startsWith('card:') ? item.itemKey.slice(5) : null;
  if (cardId && protectedRelearnCardIds.has(cardId)) return 'protected_relearn';
  if (item.scaffold) return 'protected_scaffold';
  if (item.failure) return 'protected_failure';
  if (item.due) return 'protected_due';
  return 'discretionary';
}

function validateFinalItems(
  values: unknown,
  protectedRelearnCardIds: ReadonlySet<string>,
  requestedSize: number,
): ValidatedFinalItem[] {
  if (!Array.isArray(values)
    || values.length > requestedSize
    || values.length > MAX_EXAM_TARGET_REPLAY_SELECTION) {
    fail('invalid_selection');
  }
  const seen = new Set<string>();
  return values.map((value) => {
    if (!hasExactFields(value, ITEM_FIELDS)
      || !safeItemKey(value.itemKey)
      || !safeStableCode(value.sourceRotation)
      || typeof value.due !== 'boolean'
      || typeof value.scaffold !== 'boolean'
      || typeof value.failure !== 'boolean'
      || seen.has(value.itemKey)) {
      fail('invalid_selection');
    }
    seen.add(value.itemKey);
    return {
      itemKey: value.itemKey,
      sourceRotation: value.sourceRotation,
      due: value.due,
      scaffold: value.scaffold,
      failure: value.failure,
      slotClass: classifySlot(
        value as unknown as RuntimeExamTargetFinalItemScalar,
        protectedRelearnCardIds,
      ),
    };
  });
}

function assertProtectedPair(
  controlItems: readonly ValidatedFinalItem[],
  targetItems: readonly ValidatedFinalItem[],
): void {
  const protectedControl = controlItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.slotClass !== 'discretionary')
    .map(({ item, index }) => `${index}:${item.slotClass}:${item.itemKey}`);
  const protectedTarget = targetItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.slotClass !== 'discretionary')
    .map(({ item, index }) => `${index}:${item.slotClass}:${item.itemKey}`);
  if (protectedControl.length !== protectedTarget.length
    || protectedControl.some((value, index) => value !== protectedTarget[index])) {
    fail('protected_pair_mismatch');
  }
}

function validateIdentity(identity: RuntimeExamTargetDecisionIdentity): void {
  if (!hasExactFields(identity, IDENTITY_FIELDS)
    || !SHA256.test(identity.decisionKey)
    || !safeOpaqueId(identity.attemptId)
    || !safeOpaqueId(identity.userId)
    || !safeOpaqueId(identity.sessionId)
    || !safeOpaqueId(identity.batchId, true)
    || !ROTATIONS.has(identity.rotation)
    || !safeStableCode(identity.decisionPath)) {
    fail('invalid_identity');
  }
}

function validateSourcePolicy(
  sourcePolicy: ExamTargetPersistedSourcePolicy | null,
  rotation: ExamTargetRotation,
): { allowed: string[]; max: number } | null {
  if (sourcePolicy === null) return null;
  if (!hasExactFields(sourcePolicy, SOURCE_POLICY_FIELDS)
    || !Array.isArray(sourcePolicy.allowed)
    || sourcePolicy.allowed.length > 16
    || !safeInteger(sourcePolicy.max, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)) {
    fail('invalid_source_policy');
  }
  const allowed = sourcePolicy.allowed.map((source) => {
    if (!safeStableCode(source) || source === rotation) fail('invalid_source_policy');
    return source;
  });
  if (new Set(allowed).size !== allowed.length
    || allowed.some((source, index) => index > 0 && allowed[index - 1]! > source)) {
    fail('invalid_source_policy');
  }
  return { allowed, max: sourcePolicy.max };
}

function validateControlPlane(controlPlane: RuntimeExamTargetControlPlane): void {
  if (!hasExactFields(controlPlane, CONTROL_PLANE_FIELDS)
    || (controlPlane.mode !== 'shadow' && controlPlane.mode !== 'active')
    || (controlPlane.assignment !== 'control' && controlPlane.assignment !== 'treatment')
    || controlPlane.mode === 'shadow' && controlPlane.assignment !== 'control'
    || controlPlane.assignment === 'treatment' && controlPlane.mode !== 'active'
    || !safeStableCode(controlPlane.fallbackReason, true)) {
    fail('invalid_control_plane');
  }
}

function validateSnapshotAndScheduler(
  input: RuntimeExamTargetDecisionInput,
): void {
  const { activationSnapshot: snapshot, schedulerDecision: scheduler, identity } = input;
  if (!hasExactFields(snapshot, SNAPSHOT_FIELDS)
    || !safeOpaqueId(snapshot.id)
    || !safeTargetId(snapshot.targetId)
    || !safeInteger(snapshot.revision, 1, Number.MAX_SAFE_INTEGER)
    || snapshot.targetVersion !== `${snapshot.targetId}@${snapshot.revision}`
    || snapshot.rotation !== identity.rotation
    || (snapshot.lifecycle !== 'validated' && snapshot.lifecycle !== 'active')
    || snapshot.privacyValidated !== true
    || !BASES.has(snapshot.targetBasis)
    || !safeStableCode(snapshot.scorerVersion)
    || !safeStableCode(snapshot.targetPolicyVersion)
    || !SHA256.test(snapshot.artifactHash)) {
    fail('invalid_snapshot_metadata');
  }
  if (!isPlainRecord(scheduler)
    || scheduler.mode !== 'active'
    || scheduler.assignment !== 'treatment'
    || scheduler.targetSnapshotId !== snapshot.id
    || scheduler.targetVersion !== snapshot.targetVersion
    || scheduler.targetBasis !== snapshot.targetBasis
    || scheduler.targetScorerVersion !== snapshot.scorerVersion
    || !safeStableCode(scheduler.schedulerVersion)
    || !SHA256.test(scheduler.policyDigest)
    || !safeInteger(scheduler.activationRevision, 1, Number.MAX_SAFE_INTEGER)
    || !safeInteger(scheduler.maxItemRankMove, 0, 5)
    || typeof scheduler.applied !== 'boolean'
    || !safeStableCode(scheduler.bypassReason, true)
    || scheduler.applied && scheduler.bypassReason !== null
    || !safeInteger(scheduler.daysToExam, 0, 3_650)
    || !safeStableCode(scheduler.pressureBucket)
    || !safeStableCode(scheduler.learnerStateVersion)
    || (scheduler.targetAllocationError !== undefined
      && scheduler.targetAllocationError !== null
      && !safeUnit(scheduler.targetAllocationError))
    || !Array.isArray(scheduler.candidatePool)
    || !isPlainRecord(scheduler.itemTraces)) {
    fail('invalid_scheduler_decision');
  }
}

function buildMasteryTelemetry(
  scheduler: UnifiedSessionExamTargetDecision,
): ExamTargetPersistedMasteryTelemetry {
  const workload = scheduler.workload;
  const nullableWorkloadInteger = (value: unknown): value is number | null => (
    value === null || safeInteger(value, 0, Number.MAX_SAFE_INTEGER)
  );
  const policyVersion = scheduler.masteryPolicyVersion;
  const loadWarnings = [...scheduler.masteryLoadWarnings];
  const coverageDebtDomainCodes = [...(scheduler.allocationCoverageDebtDomainCodes ?? [])];
  const changedConceptMembershipCount = scheduler.allocationChangedConceptMembershipCount ?? 0;
  const surplusTargetSeatsSelected = scheduler.surplusTargetSeatsSelected ?? 0;
  const curriculumCoverageDebtCount = scheduler.curriculumCoverageDebtCount ?? null;
  if (!safeStableCode(policyVersion, true)
    || !safeInteger(scheduler.coreTargetSeatsSelected, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
    || !safeInteger(scheduler.coreTargetSeatShortfall, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
    || !safeInteger(surplusTargetSeatsSelected, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
    || !safeInteger(changedConceptMembershipCount, 0, MAX_EXAM_TARGET_DECISION_CANDIDATES)
    || (curriculumCoverageDebtCount !== null
      && !safeInteger(curriculumCoverageDebtCount, 0, Number.MAX_SAFE_INTEGER))
    || !Array.isArray(scheduler.masteryLoadWarnings)
    || loadWarnings.length > 32
    || loadWarnings.some((warning) => !safeStableCode(warning))
    || new Set(loadWarnings).size !== loadWarnings.length
    || loadWarnings.some((warning, index) => index > 0 && loadWarnings[index - 1]! > warning)
    || coverageDebtDomainCodes.length > 64
    || coverageDebtDomainCodes.some((domainCode) => !DOMAIN_CODE.test(domainCode))
    || new Set(coverageDebtDomainCodes).size !== coverageDebtDomainCodes.length
    || coverageDebtDomainCodes.some((domainCode, index) => (
      index > 0 && coverageDebtDomainCodes[index - 1]! > domainCode
    ))
    || (workload !== null && (
      !nullableWorkloadInteger(workload.requiredTargetWorkToday)
      || !nullableWorkloadInteger(workload.remainingTargetWorkToday)
      || !safeInteger(workload.coreTargetSeats, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
      || !safeInteger(workload.surplusSeats, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
      || typeof workload.onTrack !== 'boolean'
      || !nullableWorkloadInteger(workload.shortfall)
    ))) {
    fail('invalid_scheduler_decision');
  }
  return {
    policyVersion,
    requiredTargetWorkToday: workload?.requiredTargetWorkToday ?? null,
    remainingTargetWorkToday: workload?.remainingTargetWorkToday ?? null,
    coreTargetSeats: workload?.coreTargetSeats ?? null,
    coreTargetSeatsSelected: scheduler.coreTargetSeatsSelected,
    coreTargetSeatShortfall: scheduler.coreTargetSeatShortfall,
    surplusSeats: workload?.surplusSeats ?? null,
    surplusTargetSeatsSelected,
    workloadOnTrack: workload?.onTrack ?? null,
    workloadShortfall: workload?.shortfall ?? null,
    loadWarnings,
    coverageDebtDomainCodes,
    changedConceptMembershipCount,
    evaluationOnly: scheduler.evaluationOnly === true,
    curriculumCoverageDebtCount,
  };
}

function emptyTargetScalar(sourceRotation: string, baseRank: number): TargetScalar {
  return {
    sourceRotation,
    baseRank,
    targetEligible: false,
    targetDomainCode: null,
    embeddingHash: null,
    examRelevancePct: null,
    examDomainWeight: null,
    userDomainGap: null,
    contentTargetScore: null,
    personalizedTargetScore: null,
    targetWeightProvenance: null,
  };
}

function validateTargetScalar(scalar: TargetScalar): TargetScalar {
  const complete = typeof scalar.targetDomainCode === 'string'
    && DOMAIN_CODE.test(scalar.targetDomainCode)
    && typeof scalar.embeddingHash === 'string'
    && SHA256.test(scalar.embeddingHash)
    && safeUnit(scalar.examRelevancePct)
    && safeUnit(scalar.examDomainWeight)
    && safeUnit(scalar.userDomainGap)
    && safeUnit(scalar.contentTargetScore)
    && safeUnit(scalar.personalizedTargetScore)
    && safeStableCode(scalar.targetWeightProvenance);
  if (!safeItemBaseRank(scalar.baseRank)
    || !safeStableCode(scalar.sourceRotation)
    || scalar.targetEligible !== complete) {
    fail('invalid_scheduler_decision');
  }
  if (!scalar.targetEligible && [
    scalar.targetDomainCode,
    scalar.embeddingHash,
    scalar.examRelevancePct,
    scalar.examDomainWeight,
    scalar.userDomainGap,
    scalar.contentTargetScore,
    scalar.personalizedTargetScore,
    scalar.targetWeightProvenance,
  ].some((value) => value !== null)) {
    fail('invalid_scheduler_decision');
  }
  return scalar;
}

function safeItemBaseRank(value: unknown): value is number {
  return safeInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function candidateScalar(value: UnifiedSessionExamTargetDecision['candidatePool'][number]): TargetScalar {
  return validateTargetScalar({
    sourceRotation: value.sourceRotation,
    baseRank: value.baseRank,
    targetEligible: value.targetEligible,
    targetDomainCode: value.targetDomainCode,
    embeddingHash: value.embeddingHash,
    examRelevancePct: value.examRelevancePct,
    examDomainWeight: value.examDomainWeight,
    userDomainGap: value.userDomainGap,
    contentTargetScore: value.contentTargetScore,
    personalizedTargetScore: value.personalizedTargetScore,
    targetWeightProvenance: value.targetWeightProvenance,
  });
}

function traceScalar(
  value: UnifiedSessionExamTargetDecision['itemTraces'][string],
  baseRank: number,
): TargetScalar {
  return validateTargetScalar({
    sourceRotation: value.sourceRotation,
    baseRank,
    targetEligible: true,
    targetDomainCode: value.targetDomainCode,
    embeddingHash: value.embeddingHash,
    examRelevancePct: value.examRelevancePct,
    examDomainWeight: value.examDomainWeight,
    userDomainGap: value.userDomainGap,
    contentTargetScore: value.contentTargetScore,
    personalizedTargetScore: value.personalizedTargetScore,
    targetWeightProvenance: value.targetWeightProvenance,
  });
}

function sameTargetScalar(left: TargetScalar, right: TargetScalar): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof TargetScalar] === right[key as keyof TargetScalar],
  );
}

function buildCandidates(
  scheduler: UnifiedSessionExamTargetDecision,
  controlItems: readonly ValidatedFinalItem[],
  targetItems: readonly ValidatedFinalItem[],
  rotation: ExamTargetRotation,
  sourcePolicy: { allowed: string[]; max: number } | null,
): { candidates: BuiltCandidate[]; byKey: Map<string, BuiltCandidate> } {
  const allowedSources = new Set([rotation, ...(sourcePolicy?.allowed ?? [])]);
  const poolByKey = new Map<string, TargetScalar>();
  for (const raw of scheduler.candidatePool) {
    if (!safeItemKey(raw.itemKey) || poolByKey.has(raw.itemKey)) {
      fail('invalid_scheduler_decision');
    }
    const scalar = candidateScalar(raw);
    if (!allowedSources.has(scalar.sourceRotation)) fail('invalid_source_policy');
    poolByKey.set(raw.itemKey, scalar);
  }

  const selectedByKey = new Map<string, ValidatedFinalItem>();
  const selectedOrder: string[] = [];
  for (const item of [...controlItems, ...targetItems]) {
    const prior = selectedByKey.get(item.itemKey);
    if (prior) {
      if (prior.sourceRotation !== item.sourceRotation || prior.slotClass !== item.slotClass) {
        fail('invalid_selection');
      }
      continue;
    }
    if (!allowedSources.has(item.sourceRotation)) fail('invalid_source_policy');
    selectedByKey.set(item.itemKey, item);
    selectedOrder.push(item.itemKey);
  }

  const fallbackRanks = new Map<string, number>();
  controlItems.forEach((item, index) => fallbackRanks.set(item.itemKey, index));
  targetItems.forEach((item, index) => {
    if (!fallbackRanks.has(item.itemKey)) fallbackRanks.set(item.itemKey, index);
  });

  const byKey = new Map<string, BuiltCandidate>();
  const candidates: BuiltCandidate[] = [];
  const add = (itemKey: string, item: ValidatedFinalItem | null, pool: TargetScalar | null) => {
    const fallbackRank = fallbackRanks.get(itemKey) ?? pool?.baseRank ?? candidates.length;
    const trace = scheduler.itemTraces[itemKey];
    const scalar = trace
      ? traceScalar(trace, pool?.baseRank ?? fallbackRank)
      : pool ?? emptyTargetScalar(item?.sourceRotation ?? rotation, fallbackRank);
    if (item && scalar.sourceRotation !== item.sourceRotation) fail('invalid_scheduler_decision');
    if (trace && pool && !sameTargetScalar(scalar, pool)) {
      fail('invalid_scheduler_decision');
    }
    const built = {
      telemetry: {
        itemKey,
        slotClass: item?.slotClass ?? 'discretionary',
        domainCode: scalar.targetDomainCode,
        baseRank: scalar.baseRank,
        targetEligible: scalar.targetEligible,
        targetScore: scalar.personalizedTargetScore,
      },
      scalar,
    } satisfies BuiltCandidate;
    candidates.push(built);
    byKey.set(itemKey, built);
  };

  for (const itemKey of selectedOrder) {
    add(itemKey, selectedByKey.get(itemKey)!, poolByKey.get(itemKey) ?? null);
  }
  for (const [itemKey, scalar] of poolByKey) {
    if (!byKey.has(itemKey)) add(itemKey, null, scalar);
  }
  if (candidates.length > MAX_EXAM_TARGET_DECISION_CANDIDATES) {
    fail('invalid_scheduler_decision');
  }
  return { candidates, byKey };
}

function memoizedHmacTokenizer(raw: unknown): (itemKey: string) => string {
  if (typeof raw !== 'function') fail('invalid_hmac');
  const cache = new Map<string, string>();
  const owners = new Map<string, string>();
  return (itemKey) => {
    const cached = cache.get(itemKey);
    if (cached) return cached;
    let first: unknown;
    let second: unknown;
    try {
      first = raw(itemKey);
      second = raw(itemKey);
    } catch {
      return fail('invalid_hmac');
    }
    if (typeof first !== 'string' || first !== second || !SHA256.test(first)) {
      fail('invalid_hmac');
    }
    const owner = owners.get(first);
    if (owner && owner !== itemKey) fail('invalid_hmac');
    owners.set(first, itemKey);
    cache.set(itemKey, first);
    return first;
  };
}

export function shouldCaptureRuntimeExamTargetReplay(digest: string): boolean {
  if (!SHA256.test(digest)) fail('invalid_telemetry');
  return BigInt(`0x${digest}`) % 100n === 0n;
}

function buildAggregateTelemetry(
  candidates: readonly BuiltCandidate[],
  controlSelectionKeys: readonly string[],
  targetSelectionKeys: readonly string[],
  requestedSize: number,
  policyDigest: string,
  tieBreakSeed: string,
  tokenizeItemKey: (itemKey: string) => string,
): ExamTargetDecisionTelemetry {
  for (const candidate of candidates) tokenizeItemKey(candidate.telemetry.itemKey);
  const baseInput = {
    candidates: candidates.map((candidate) => candidate.telemetry),
    controlSelectionKeys,
    targetSelectionKeys,
    requestedSize,
    policyDigest,
    deterministicSeed: tieBreakSeed,
    tokenizeItemKey,
  };
  const captureReplay = candidates.length <= MAX_EXAM_TARGET_REPLAY_CANDIDATES
    && shouldCaptureRuntimeExamTargetReplay(tieBreakSeed);
  try {
    return buildExamTargetDecisionTelemetry({
      ...baseInput,
      captureReplay,
    });
  } catch (error) {
    if (error instanceof RuntimeExamTargetDecisionError) throw error;
    // Replay is sampled observability, never a serving prerequisite. Preserve
    // the exact aggregate decision when its optional JSON snapshot alone is
    // too large; every other validation failure remains fail-closed.
    if (
      captureReplay
      && error instanceof Error
      && error.message.startsWith('exam-target replay snapshot exceeds ')
    ) {
      try {
        return buildExamTargetDecisionTelemetry({
          ...baseInput,
          captureReplay: false,
        });
      } catch {
        return fail('invalid_telemetry');
      }
    }
    return fail('invalid_telemetry');
  }
}

function buildServeItems(
  actualItems: readonly ValidatedFinalItem[],
  counterpartItems: readonly ValidatedFinalItem[],
  targetItems: readonly ValidatedFinalItem[],
  candidatesByKey: ReadonlyMap<string, BuiltCandidate>,
  scheduler: UnifiedSessionExamTargetDecision,
  controlPlane: RuntimeExamTargetControlPlane,
  tokenizeItemKey: (itemKey: string) => string,
  rotation: ExamTargetRotation,
): ExamTargetServeItemTelemetryInput[] {
  const counterpartKeys = new Set(counterpartItems.map((item) => item.itemKey));
  const targetRanks = new Map(targetItems.map((item, rank) => [item.itemKey, rank]));
  const activeTreatment = controlPlane.mode === 'active'
    && controlPlane.assignment === 'treatment';
  return actualItems.map((item, finalRank): ExamTargetServeItemTelemetryInput => {
    const candidate = candidatesByKey.get(item.itemKey);
    if (!candidate) fail('invalid_telemetry');
    const scalar = candidate.scalar;
    const targetBoostDelta = scalar.targetEligible
      ? stableMetric(-scheduler.maxItemRankMove * scalar.personalizedTargetScore!)
      : null;
    const targetRankInPool = targetRanks.get(item.itemKey) ?? null;
    if (activeTreatment && targetRankInPool !== finalRank) fail('invalid_telemetry');
    const constraintCodes = [
      item.slotClass,
      item.sourceRotation === rotation ? 'source_native' : 'source_cross_mapped',
    ] as ExamTargetTrace['constraintCodes'];
    return {
      itemKey: item.itemKey,
      itemToken: tokenizeItemKey(item.itemKey),
      sourceRotation: item.sourceRotation,
      slotClass: item.slotClass,
      targetEligible: scalar.targetEligible,
      targetApplied: activeTreatment
        && scheduler.applied
        && scalar.targetEligible
        && item.slotClass === 'discretionary',
      targetBypassReason: activeTreatment && scheduler.applied
        ? scheduler.bypassReason
        : controlPlane.fallbackReason ?? scheduler.bypassReason,
      targetEmbeddingHash: scalar.embeddingHash,
      targetDomainCode: scalar.targetDomainCode,
      examRelevancePct: scalar.examRelevancePct,
      examDomainWeight: scalar.examDomainWeight,
      userDomainGap: scalar.userDomainGap,
      contentTargetScore: scalar.contentTargetScore,
      personalizedTargetScore: scalar.personalizedTargetScore,
      targetWeightProvenance: scalar.targetWeightProvenance,
      targetBoostDelta,
      baseRankInPool: scalar.baseRank,
      targetRankInPool,
      finalRankInPool: finalRank,
      targetChangedMembership: !counterpartKeys.has(item.itemKey),
      targetCacheAgeMs: null,
      constraintCodes,
    };
  });
}

export function buildRuntimeExamTargetDecision(
  input: RuntimeExamTargetDecisionInput,
): RuntimeExamTargetDecisionResult {
  if (!hasExactFields(input, INPUT_FIELDS)) fail('invalid_identity');
  validateIdentity(input.identity);
  validateControlPlane(input.controlPlane);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    fail('invalid_snapshot_metadata');
  }
  if (!safeInteger(input.requestedSize, 0, MAX_EXAM_TARGET_REPLAY_SELECTION)
    || !safeInteger(input.targetComputeMs, 0, Number.MAX_SAFE_INTEGER)
    || !SHA256.test(input.tieBreakSeed)
    || !Array.isArray(input.protectedRelearnCardIds)) {
    fail('invalid_selection');
  }
  const relearnIds = new Set<string>();
  for (const id of input.protectedRelearnCardIds) {
    if (!safeOpaqueId(id) || relearnIds.has(id)) fail('invalid_selection');
    relearnIds.add(id);
  }
  const sourcePolicy = validateSourcePolicy(input.sourcePolicy, input.identity.rotation);
  const masteryTelemetry = buildMasteryTelemetry(input.schedulerDecision);
  validateSnapshotAndScheduler(input);
  const controlItems = validateFinalItems(input.controlItems, relearnIds, input.requestedSize);
  const targetItems = validateFinalItems(input.targetItems, relearnIds, input.requestedSize);
  assertProtectedPair(controlItems, targetItems);
  const actualItems = input.controlPlane.assignment === 'treatment'
    ? targetItems
    : controlItems;
  const counterpartItems = input.controlPlane.assignment === 'treatment'
    ? controlItems
    : targetItems;
  const crossSourceMaximum = sourcePolicy?.max ?? 0;
  if ([controlItems, targetItems].some((items) => items.filter(
    (item) => item.sourceRotation !== input.identity.rotation,
  ).length > crossSourceMaximum)) {
    fail('invalid_source_policy');
  }

  const built = buildCandidates(
    input.schedulerDecision,
    controlItems,
    targetItems,
    input.identity.rotation,
    sourcePolicy,
  );
  const tokenizeItemKey = memoizedHmacTokenizer(input.tokenizeItemKey);
  const controlSelectionKeys = controlItems.map((item) => item.itemKey);
  const targetSelectionKeys = targetItems.map((item) => item.itemKey);
  const telemetry = buildAggregateTelemetry(
    built.candidates,
    controlSelectionKeys,
    targetSelectionKeys,
    input.requestedSize,
    input.schedulerDecision.policyDigest,
    input.tieBreakSeed,
    tokenizeItemKey,
  );
  const captureReplay = telemetry.replaySnapshot !== null;
  const decidedAt = new Date(input.now.getTime());
  const snapshot = input.activationSnapshot;
  const decision: ExamTargetDecisionSetWriteInput = {
    decisionKey: input.identity.decisionKey,
    attemptId: input.identity.attemptId,
    userId: input.identity.userId,
    sessionId: input.identity.sessionId,
    batchId: input.identity.batchId,
    rotation: input.identity.rotation,
    decisionPath: input.identity.decisionPath,
    decidedAt,
    schedulerVersion: input.schedulerDecision.schedulerVersion,
    mode: input.controlPlane.mode,
    assignment: input.controlPlane.assignment,
    targetPolicyVersion: snapshot.targetPolicyVersion,
    activationRevision: input.schedulerDecision.activationRevision,
    targetSnapshotId: snapshot.id,
    targetId: snapshot.targetId,
    targetRevision: snapshot.revision,
    targetBasis: snapshot.targetBasis,
    targetScorerVersion: snapshot.scorerVersion,
    daysToExam: input.schedulerDecision.daysToExam,
    pressureBucket: input.schedulerDecision.pressureBucket,
    learnerStateVersion: input.schedulerDecision.learnerStateVersion,
    sourcePolicy,
    masteryTelemetry,
    tieBreakSeed: input.tieBreakSeed,
    requestedSize: input.requestedSize,
    candidateCount: built.candidates.length,
    eligibleCount: built.candidates.length,
    targetEligibleCount: built.candidates.filter(
      (candidate) => candidate.telemetry.targetEligible,
    ).length,
    controlSelectedCount: controlItems.length,
    targetSelectedCount: targetItems.length,
    controlAllocationError: null,
    targetAllocationError: input.schedulerDecision.targetAllocationError ?? null,
    targetComputeMs: input.targetComputeMs,
    fallbackReason: input.controlPlane.fallbackReason,
    traceVersion: 1,
    replayCapturedAt: captureReplay ? decidedAt : null,
    replayExpiresAt: captureReplay
      ? new Date(decidedAt.getTime() + REPLAY_RETENTION_MS)
      : null,
  };
  const items = buildServeItems(
    actualItems,
    counterpartItems,
    targetItems,
    built.byKey,
    input.schedulerDecision,
    input.controlPlane,
    tokenizeItemKey,
    input.identity.rotation,
  );
  return deepFreeze({ decision, telemetry, items });
}
