import type { ExamTargetSlotClass } from './allocator';
import { canonicalExamTargetJson, hashExamTargetArtifact } from './artifact';

const SHA256 = /^[a-f0-9]{64}$/;
const DOMAIN_CODE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SLOT_CLASSES = new Set<ExamTargetSlotClass>([
  'protected_due',
  'protected_relearn',
  'protected_failure',
  'protected_scaffold',
  'discretionary',
]);

const INPUT_FIELDS = [
  'candidates',
  'controlSelectionKeys',
  'targetSelectionKeys',
  'requestedSize',
  'policyDigest',
  'deterministicSeed',
  'captureReplay',
  'tokenizeItemKey',
] as const;
const INPUT_CANDIDATE_FIELDS = [
  'itemKey',
  'slotClass',
  'domainCode',
  'baseRank',
  'targetEligible',
  'targetScore',
] as const;
const REPLAY_FIELDS = [
  'schema',
  'policyDigest',
  'candidateSetDigest',
  'deterministicSeed',
  'requestedSize',
  'candidates',
  'expected',
] as const;
const REPLAY_CANDIDATE_FIELDS = [
  'itemToken',
  'inputOrdinal',
  'slotClass',
  'domainCode',
  'baseRank',
  'targetEligible',
  'targetScore',
] as const;
const REPLAY_EXPECTED_FIELDS = [
  'controlSelectionTokens',
  'targetSelectionTokens',
  'controlSelectionDigest',
  'targetSelectionDigest',
  'selectedSetOverlap',
  'changedMembershipCount',
  'controlMeanTargetScore',
  'targetMeanTargetScore',
  'pairedTargetLift',
] as const;
const REPLAY_DECISION_FIELDS = [
  'controlSelectionTokens',
  'targetSelectionTokens',
] as const;

/**
 * Exact replay must cover the real Year-3 banks (roughly 1.5k-7k candidates),
 * not only toy pools. The 1% sampler and 30-day retention bound storage; these
 * limits bound any one privacy-safe scalar snapshot.
 */
export const MAX_EXAM_TARGET_REPLAY_BYTES = 2_097_152;
export const MAX_EXAM_TARGET_REPLAY_CANDIDATES = 10_000;
/** Aggregate telemetry remains bounded independently of optional exact replay. */
export const MAX_EXAM_TARGET_DECISION_CANDIDATES = 10_000;
export const MAX_EXAM_TARGET_REPLAY_SELECTION = 100;

export interface ExamTargetDecisionCandidate {
  itemKey: string;
  slotClass: ExamTargetSlotClass;
  domainCode: string | null;
  /** Zero-based control rank within the scheduler's already-safe candidate pool. */
  baseRank: number;
  targetEligible: boolean;
  /** Personalized score on the canonical 0..1 scale; null means unscored. */
  targetScore: number | null;
}

export interface BuildExamTargetDecisionTelemetryInput {
  candidates: readonly ExamTargetDecisionCandidate[];
  controlSelectionKeys: readonly string[];
  targetSelectionKeys: readonly string[];
  requestedSize: number;
  policyDigest: string;
  /** Privacy-safe deterministic seed digest, never a user or item identifier. */
  deterministicSeed: string;
  /** Sampling is decided upstream; false still emits aggregate paired metrics. */
  captureReplay: boolean;
  /** Must return a lowercase HMAC-SHA256 token. */
  tokenizeItemKey: (itemKey: string) => string;
}

export interface ExamTargetReplayCandidate {
  itemToken: string;
  inputOrdinal: number;
  slotClass: ExamTargetSlotClass;
  domainCode: string | null;
  baseRank: number;
  targetEligible: boolean;
  targetScore: number | null;
}

export interface ExamTargetReplayExpected {
  controlSelectionTokens: string[];
  targetSelectionTokens: string[];
  controlSelectionDigest: string;
  targetSelectionDigest: string;
  selectedSetOverlap: number;
  changedMembershipCount: number;
  controlMeanTargetScore: number | null;
  targetMeanTargetScore: number | null;
  pairedTargetLift: number | null;
}

export interface ExamTargetDecisionReplaySnapshot {
  schema: 'md3.exam-target-decision-replay/v1';
  policyDigest: string;
  candidateSetDigest: string;
  deterministicSeed: string;
  requestedSize: number;
  candidates: ExamTargetReplayCandidate[];
  expected: ExamTargetReplayExpected;
}

export interface ExamTargetDecisionTelemetry {
  policyDigest: string;
  candidateSetDigest: string;
  controlSelectionDigest: string;
  targetSelectionDigest: string;
  selectedSetOverlap: number;
  changedMembershipCount: number;
  controlMeanTargetScore: number | null;
  targetMeanTargetScore: number | null;
  pairedTargetLift: number | null;
  replaySnapshot: ExamTargetDecisionReplaySnapshot | null;
}

export interface ExamTargetReplayDecisionInput {
  policyDigest: string;
  deterministicSeed: string;
  requestedSize: number;
  candidates: readonly Readonly<ExamTargetReplayCandidate>[];
}

export interface ExamTargetReplaySelections {
  controlSelectionTokens: readonly string[];
  targetSelectionTokens: readonly string[];
}

export type ExamTargetReplayDecider = (
  input: Readonly<ExamTargetReplayDecisionInput>,
) => ExamTargetReplaySelections;

export interface ExamTargetReplayVerification {
  exactMatch: boolean;
  candidateSetDigestMatches: boolean;
  capturedControlSelectionDigestMatches: boolean;
  capturedTargetSelectionDigestMatches: boolean;
  controlMembershipMatches: boolean;
  targetMembershipMatches: boolean;
  controlRanksMatch: boolean;
  targetRanksMatch: boolean;
  metricsMatch: boolean;
  replayed: Omit<ExamTargetDecisionTelemetry, 'replaySnapshot' | 'policyDigest'>;
}

interface PairedMetrics {
  selectedSetOverlap: number;
  changedMembershipCount: number;
  controlMeanTargetScore: number | null;
  targetMeanTargetScore: number | null;
  pairedTargetLift: number | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(
  value: unknown,
  allowedFields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...allowedFields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} fields do not match allowlist`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be a safe integer in range`);
  }
}

function assertScore(value: unknown, label: string): asserts value is number | null {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be null or a finite number from 0 to 1`);
  }
}

function assertMetric(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable?: false,
): asserts value is number;
function assertMetric(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable: true,
): asserts value is number | null;
function assertMetric(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  nullable = false,
): asserts value is number | null {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside its finite range`);
  }
}

function assertSlotClass(value: unknown): asserts value is ExamTargetSlotClass {
  if (typeof value !== 'string' || !SLOT_CLASSES.has(value as ExamTargetSlotClass)) {
    throw new TypeError('candidate slot class is not allowlisted');
  }
}

function assertDomainCode(value: unknown): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > 80 || !DOMAIN_CODE.test(value)) {
    throw new TypeError('candidate domain code is invalid');
  }
}

function assertReplayCandidate(
  value: unknown,
  expectedOrdinal: number,
): asserts value is ExamTargetReplayCandidate {
  assertExactFields(value, REPLAY_CANDIDATE_FIELDS, 'replay candidate');
  assertSha256(value.itemToken, 'replay item token');
  assertSafeInteger(value.inputOrdinal, 'replay input ordinal', 0);
  if (value.inputOrdinal !== expectedOrdinal) {
    throw new TypeError('replay candidate ordinals must be contiguous and ordered');
  }
  assertSlotClass(value.slotClass);
  assertDomainCode(value.domainCode);
  assertSafeInteger(value.baseRank, 'replay base rank', 0);
  if (typeof value.targetEligible !== 'boolean') {
    throw new TypeError('replay target eligibility must be boolean');
  }
  assertScore(value.targetScore, 'replay target score');
  if (value.targetEligible && value.targetScore === null) {
    throw new TypeError('target-eligible replay candidates require a target score');
  }
}

function stableMetric(value: number): number {
  const rounded = Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function hashCandidateSet(candidates: readonly ExamTargetReplayCandidate[]): string {
  return hashExamTargetArtifact({
    schema: 'md3.exam-target-candidate-set/v1',
    candidates,
  });
}

function hashSelection(itemTokens: readonly string[]): string {
  return hashExamTargetArtifact({
    schema: 'md3.exam-target-selection/v1',
    itemTokens,
  });
}

function selectedMean(
  selection: readonly string[],
  candidatesByToken: ReadonlyMap<string, ExamTargetReplayCandidate>,
): number | null {
  let total = 0;
  let scored = 0;
  for (const itemToken of selection) {
    const candidate = candidatesByToken.get(itemToken);
    if (!candidate) throw new Error('selection references an unknown candidate');
    if (candidate.targetScore !== null) {
      total += candidate.targetScore;
      scored += 1;
    }
  }
  return scored === 0 ? null : stableMetric(total / scored);
}

function pairedMetrics(
  candidates: readonly ExamTargetReplayCandidate[],
  controlSelectionTokens: readonly string[],
  targetSelectionTokens: readonly string[],
): PairedMetrics {
  const candidatesByToken = new Map(candidates.map(candidate => [candidate.itemToken, candidate]));
  const controlSet = new Set(controlSelectionTokens);
  const targetSet = new Set(targetSelectionTokens);
  let intersection = 0;
  for (const itemToken of controlSet) {
    if (targetSet.has(itemToken)) intersection += 1;
  }
  const overlapDenominator = Math.max(controlSet.size, targetSet.size);
  const selectedSetOverlap = overlapDenominator === 0
    ? 1
    : stableMetric(intersection / overlapDenominator);
  const changedMembershipCount = [...targetSet]
    .reduce((count, itemToken) => count + (controlSet.has(itemToken) ? 0 : 1), 0);
  const controlMeanTargetScore = selectedMean(controlSelectionTokens, candidatesByToken);
  const targetMeanTargetScore = selectedMean(targetSelectionTokens, candidatesByToken);
  const pairedTargetLift = controlMeanTargetScore === null || targetMeanTargetScore === null
    ? null
    : stableMetric(targetMeanTargetScore - controlMeanTargetScore);

  return {
    selectedSetOverlap,
    changedMembershipCount,
    controlMeanTargetScore,
    targetMeanTargetScore,
    pairedTargetLift,
  };
}

function assertTokenSelection(
  value: unknown,
  label: string,
  candidateTokens: ReadonlySet<string>,
  requestedSize: number,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > requestedSize || value.length > MAX_EXAM_TARGET_REPLAY_SELECTION) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const seen = new Set<string>();
  for (const itemToken of value) {
    assertSha256(itemToken, `${label} item token`);
    if (!candidateTokens.has(itemToken)) throw new Error(`${label} references an unknown candidate`);
    if (seen.has(itemToken)) throw new Error(`${label} contains duplicate item tokens`);
    seen.add(itemToken);
  }
}

function assertRawSelection(
  value: unknown,
  label: string,
  itemTokensByKey: ReadonlyMap<string, string>,
  requestedSize: number,
): string[] {
  if (!Array.isArray(value) || value.length > requestedSize || value.length > MAX_EXAM_TARGET_REPLAY_SELECTION) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const seen = new Set<string>();
  return value.map((itemKey) => {
    if (typeof itemKey !== 'string' || itemKey.length === 0 || itemKey.length > 512) {
      throw new TypeError(`${label} contains an invalid item key`);
    }
    if (seen.has(itemKey)) throw new Error(`${label} contains duplicate item keys`);
    seen.add(itemKey);
    const itemToken = itemTokensByKey.get(itemKey);
    if (!itemToken) throw new Error(`${label} references an unknown candidate`);
    return itemToken;
  });
}

function sanitizeCandidates(
  value: unknown,
  tokenizeItemKey: (itemKey: string) => string,
): {
  candidates: ExamTargetReplayCandidate[];
  itemTokensByKey: Map<string, string>;
} {
  if (!Array.isArray(value) || value.length > MAX_EXAM_TARGET_DECISION_CANDIDATES) {
    throw new TypeError('candidates must be a bounded array');
  }
  const itemTokensByKey = new Map<string, string>();
  const seenTokens = new Set<string>();
  const candidates = value.map((candidate, inputOrdinal): ExamTargetReplayCandidate => {
    assertExactFields(candidate, INPUT_CANDIDATE_FIELDS, 'candidate');
    if (typeof candidate.itemKey !== 'string'
      || candidate.itemKey.length === 0
      || candidate.itemKey.length > 512) {
      throw new TypeError('candidate item key is invalid');
    }
    if (itemTokensByKey.has(candidate.itemKey)) {
      throw new Error('candidate item keys must be unique');
    }
    assertSlotClass(candidate.slotClass);
    assertDomainCode(candidate.domainCode);
    assertSafeInteger(candidate.baseRank, 'candidate base rank', 0);
    if (typeof candidate.targetEligible !== 'boolean') {
      throw new TypeError('candidate target eligibility must be boolean');
    }
    assertScore(candidate.targetScore, 'candidate target score');
    if (candidate.targetEligible && candidate.targetScore === null) {
      throw new TypeError('target-eligible candidates require a target score');
    }

    let itemToken: string;
    try {
      itemToken = tokenizeItemKey(candidate.itemKey);
    } catch {
      throw new Error('item tokenization failed');
    }
    assertSha256(itemToken, 'item token');
    if (seenTokens.has(itemToken)) throw new Error('item token collision');
    seenTokens.add(itemToken);
    itemTokensByKey.set(candidate.itemKey, itemToken);

    return {
      itemToken,
      inputOrdinal,
      slotClass: candidate.slotClass,
      domainCode: candidate.domainCode,
      baseRank: candidate.baseRank,
      targetEligible: candidate.targetEligible,
      targetScore: candidate.targetScore,
    };
  });

  return { candidates, itemTokensByKey };
}

function expectedMetricsMatch(
  expected: ExamTargetReplayExpected,
  actual: PairedMetrics,
): boolean {
  return expected.selectedSetOverlap === actual.selectedSetOverlap
    && expected.changedMembershipCount === actual.changedMembershipCount
    && expected.controlMeanTargetScore === actual.controlMeanTargetScore
    && expected.targetMeanTargetScore === actual.targetMeanTargetScore
    && expected.pairedTargetLift === actual.pairedTargetLift;
}

function sameMembership(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(itemToken => rightSet.has(itemToken));
}

function sameRanks(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((itemToken, index) => itemToken === right[index]);
}

export function parseExamTargetDecisionReplaySnapshot(
  value: unknown,
): ExamTargetDecisionReplaySnapshot {
  const byteLength = new TextEncoder().encode(canonicalExamTargetJson(value)).byteLength;
  if (byteLength > MAX_EXAM_TARGET_REPLAY_BYTES) {
    throw new Error(`exam-target replay snapshot exceeds ${MAX_EXAM_TARGET_REPLAY_BYTES} bytes`);
  }

  assertExactFields(value, REPLAY_FIELDS, 'replay snapshot');
  if (value.schema !== 'md3.exam-target-decision-replay/v1') {
    throw new TypeError('replay snapshot schema is unsupported');
  }
  assertSha256(value.policyDigest, 'replay policy digest');
  assertSha256(value.candidateSetDigest, 'replay candidate-set digest');
  assertSha256(value.deterministicSeed, 'replay deterministic seed');
  assertSafeInteger(
    value.requestedSize,
    'replay requested size',
    0,
    MAX_EXAM_TARGET_REPLAY_SELECTION,
  );
  if (!Array.isArray(value.candidates)
    || value.candidates.length > MAX_EXAM_TARGET_REPLAY_CANDIDATES) {
    throw new TypeError('replay candidates must be a bounded array');
  }
  const candidateTokens = new Set<string>();
  const candidates = value.candidates.map((candidate, index) => {
    assertReplayCandidate(candidate, index);
    if (candidateTokens.has(candidate.itemToken)) throw new Error('replay item tokens must be unique');
    candidateTokens.add(candidate.itemToken);
    return { ...candidate };
  });

  assertExactFields(value.expected, REPLAY_EXPECTED_FIELDS, 'replay expected result');
  assertTokenSelection(
    value.expected.controlSelectionTokens,
    'replay control selection',
    candidateTokens,
    value.requestedSize,
  );
  assertTokenSelection(
    value.expected.targetSelectionTokens,
    'replay target selection',
    candidateTokens,
    value.requestedSize,
  );
  assertSha256(value.expected.controlSelectionDigest, 'replay control selection digest');
  assertSha256(value.expected.targetSelectionDigest, 'replay target selection digest');
  assertMetric(value.expected.selectedSetOverlap, 'replay selected-set overlap', 0, 1);
  assertSafeInteger(
    value.expected.changedMembershipCount,
    'replay changed-membership count',
    0,
    value.requestedSize,
  );
  assertMetric(value.expected.controlMeanTargetScore, 'replay control mean score', 0, 1, true);
  assertMetric(value.expected.targetMeanTargetScore, 'replay target mean score', 0, 1, true);
  assertMetric(value.expected.pairedTargetLift, 'replay paired lift', -1, 1, true);

  return {
    schema: value.schema,
    policyDigest: value.policyDigest,
    candidateSetDigest: value.candidateSetDigest,
    deterministicSeed: value.deterministicSeed,
    requestedSize: value.requestedSize,
    candidates,
    expected: {
      controlSelectionTokens: [...value.expected.controlSelectionTokens],
      targetSelectionTokens: [...value.expected.targetSelectionTokens],
      controlSelectionDigest: value.expected.controlSelectionDigest,
      targetSelectionDigest: value.expected.targetSelectionDigest,
      selectedSetOverlap: value.expected.selectedSetOverlap,
      changedMembershipCount: value.expected.changedMembershipCount,
      controlMeanTargetScore: value.expected.controlMeanTargetScore,
      targetMeanTargetScore: value.expected.targetMeanTargetScore,
      pairedTargetLift: value.expected.pairedTargetLift,
    },
  };
}

export function buildExamTargetDecisionTelemetry(
  input: BuildExamTargetDecisionTelemetryInput,
): ExamTargetDecisionTelemetry {
  assertExactFields(input, INPUT_FIELDS, 'decision telemetry input');
  assertSha256(input.policyDigest, 'policy digest');
  assertSha256(input.deterministicSeed, 'deterministic seed');
  assertSafeInteger(
    input.requestedSize,
    'requested size',
    0,
    MAX_EXAM_TARGET_REPLAY_SELECTION,
  );
  if (typeof input.captureReplay !== 'boolean') {
    throw new TypeError('captureReplay must be boolean');
  }
  if (typeof input.tokenizeItemKey !== 'function') {
    throw new TypeError('tokenizeItemKey must be a function');
  }

  const sanitized = sanitizeCandidates(input.candidates, input.tokenizeItemKey);
  const controlSelectionTokens = assertRawSelection(
    input.controlSelectionKeys,
    'control selection',
    sanitized.itemTokensByKey,
    input.requestedSize,
  );
  const targetSelectionTokens = assertRawSelection(
    input.targetSelectionKeys,
    'target selection',
    sanitized.itemTokensByKey,
    input.requestedSize,
  );
  const candidateSetDigest = hashCandidateSet(sanitized.candidates);
  const controlSelectionDigest = hashSelection(controlSelectionTokens);
  const targetSelectionDigest = hashSelection(targetSelectionTokens);
  const metrics = pairedMetrics(
    sanitized.candidates,
    controlSelectionTokens,
    targetSelectionTokens,
  );

  const replaySnapshot = input.captureReplay
    ? parseExamTargetDecisionReplaySnapshot({
      schema: 'md3.exam-target-decision-replay/v1',
      policyDigest: input.policyDigest,
      candidateSetDigest,
      deterministicSeed: input.deterministicSeed,
      requestedSize: input.requestedSize,
      candidates: sanitized.candidates,
      expected: {
        controlSelectionTokens,
        targetSelectionTokens,
        controlSelectionDigest,
        targetSelectionDigest,
        ...metrics,
      },
    })
    : null;

  return {
    policyDigest: input.policyDigest,
    candidateSetDigest,
    controlSelectionDigest,
    targetSelectionDigest,
    ...metrics,
    replaySnapshot,
  };
}

export function replayExamTargetDecision(
  snapshotValue: unknown,
  decide: ExamTargetReplayDecider,
): ExamTargetReplayVerification {
  const snapshot = parseExamTargetDecisionReplaySnapshot(snapshotValue);
  if (typeof decide !== 'function') throw new TypeError('replay decider must be a function');
  const replayCandidates = snapshot.candidates.map(candidate => Object.freeze({ ...candidate }));
  const decisionInput = Object.freeze({
    policyDigest: snapshot.policyDigest,
    deterministicSeed: snapshot.deterministicSeed,
    requestedSize: snapshot.requestedSize,
    candidates: Object.freeze(replayCandidates),
  });
  const selection = decide(decisionInput);
  assertExactFields(selection, REPLAY_DECISION_FIELDS, 'replay decision');
  const candidateTokens = new Set(snapshot.candidates.map(candidate => candidate.itemToken));
  assertTokenSelection(
    selection.controlSelectionTokens,
    'replayed control selection',
    candidateTokens,
    snapshot.requestedSize,
  );
  assertTokenSelection(
    selection.targetSelectionTokens,
    'replayed target selection',
    candidateTokens,
    snapshot.requestedSize,
  );

  const controlSelectionTokens = [...selection.controlSelectionTokens];
  const targetSelectionTokens = [...selection.targetSelectionTokens];
  const candidateSetDigest = hashCandidateSet(snapshot.candidates);
  const controlSelectionDigest = hashSelection(controlSelectionTokens);
  const targetSelectionDigest = hashSelection(targetSelectionTokens);
  const metrics = pairedMetrics(
    snapshot.candidates,
    controlSelectionTokens,
    targetSelectionTokens,
  );
  const candidateSetDigestMatches = candidateSetDigest === snapshot.candidateSetDigest;
  const capturedControlSelectionDigestMatches = hashSelection(
    snapshot.expected.controlSelectionTokens,
  ) === snapshot.expected.controlSelectionDigest;
  const capturedTargetSelectionDigestMatches = hashSelection(
    snapshot.expected.targetSelectionTokens,
  ) === snapshot.expected.targetSelectionDigest;
  const controlMembershipMatches = sameMembership(
    controlSelectionTokens,
    snapshot.expected.controlSelectionTokens,
  );
  const targetMembershipMatches = sameMembership(
    targetSelectionTokens,
    snapshot.expected.targetSelectionTokens,
  );
  const controlRanksMatch = sameRanks(
    controlSelectionTokens,
    snapshot.expected.controlSelectionTokens,
  );
  const targetRanksMatch = sameRanks(
    targetSelectionTokens,
    snapshot.expected.targetSelectionTokens,
  );
  const metricsMatch = expectedMetricsMatch(snapshot.expected, metrics);
  const exactMatch = candidateSetDigestMatches
    && capturedControlSelectionDigestMatches
    && capturedTargetSelectionDigestMatches
    && controlRanksMatch
    && targetRanksMatch
    && metricsMatch;

  return {
    exactMatch,
    candidateSetDigestMatches,
    capturedControlSelectionDigestMatches,
    capturedTargetSelectionDigestMatches,
    controlMembershipMatches,
    targetMembershipMatches,
    controlRanksMatch,
    targetRanksMatch,
    metricsMatch,
    replayed: {
      candidateSetDigest,
      controlSelectionDigest,
      targetSelectionDigest,
      ...metrics,
    },
  };
}
