import { hashExamTargetArtifact } from './artifact';
import { examTargetVersionId, parseExamTargetDefinition } from './contract';
import { getExamTargetDefinition } from './registry';
import { computeItemTargetIndex } from './scoring';
import type {
  CompiledExamTargetConceptRow,
  CompiledExamTargetItemRow,
  CompiledExamTargetSnapshot,
  ExamTargetAssignmentMethod,
  ExamTargetConceptMappingMethod,
  ExamTargetSnapshotItemType,
} from './snapshot-builder';
import type {
  ExamTargetBasis,
  ExamTargetDefinition,
  ExamTargetRotation,
  ExamTargetWeightPolicy,
} from './types';

export interface ReviewedExamTargetSnapshotMetadata {
  definition: ExamTargetDefinition;
  weightPolicy: ExamTargetWeightPolicy;
  sourceManifestHash: string;
  generatedBy: string;
  supersedesId: string | null;
}

export interface PersistExamTargetSnapshotInput {
  compiled: CompiledExamTargetSnapshot;
  metadata: ReviewedExamTargetSnapshotMetadata;
}

export interface ExamTargetSnapshotCreateData {
  targetId: string;
  revision: number;
  schemaVersion: 'md3.exam-target/v1';
  rotation: ExamTargetRotation;
  status: 'built';
  targetBasis: ExamTargetBasis;
  validFrom: Date;
  supersedesId: string | null;
  weightPolicy: ExamTargetWeightPolicy;
  scorerVersion: string;
  embeddingModel: string;
  embeddingDimensions: number;
  sourceManifestHash: string;
  anchorCorpusHash: string;
  artifactHash: string;
  itemRowsHash: string;
  conceptRowsHash: string;
  manifestHash: string;
  buildManifest: ExamTargetSnapshotManifest;
  runtimeProjection: ExamTargetDefinition;
  privacyValidated: false;
  generatedBy: string;
  validatedAt: null;
  reviewedBy: string;
  activatedAt: null;
  activatedBy: null;
}

export interface ItemExamTargetScoreCreateManyData {
  targetSnapshotId: string;
  itemType: ExamTargetSnapshotItemType;
  itemId: string;
  sourceRotation: string;
  embeddingHash: string;
  domainCode: string;
  assignmentMethod: ExamTargetAssignmentMethod;
  rawSimilarity: number | null;
  zSimilarity: number | null;
  runnerUpDomainCode: string | null;
  assignmentMargin: number | null;
  assignmentConfidence: number;
  geometryConfidence: number;
  fitPercentile: number | null;
  effectiveDomainWeight: number;
  weightProvenance: string;
  domainPriorityIndex: number;
  itemTargetIndex: number;
}

export interface ConceptExamTargetScoreCreateManyData {
  targetSnapshotId: string;
  conceptId: string;
  primaryDomainCode: string;
  domainMix: Readonly<Record<string, number>>;
  mappingMethod: ExamTargetConceptMappingMethod;
  targetIndex: number;
  mappingConfidence: number;
  mappingHash: string;
  artifactHash: string;
}

export interface ExistingExamTargetSnapshotIdentity {
  id: string;
  targetId: string;
  revision: number;
  artifactHash: string;
}

export interface ExamTargetSnapshotFindFirstArgs {
  where: {
    OR: [
      { targetId: string; revision: number },
      { artifactHash: string },
    ];
  };
  select: {
    id: true;
    targetId: true;
    revision: true;
    artifactHash: true;
  };
}

export interface ExamTargetSnapshotPersistenceTransaction {
  examTargetSnapshot: {
    findFirst(
      args: ExamTargetSnapshotFindFirstArgs,
    ): Promise<ExistingExamTargetSnapshotIdentity | null>;
    create(args: {
      data: ExamTargetSnapshotCreateData;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  itemExamTargetScore: {
    createMany(args: {
      data: ItemExamTargetScoreCreateManyData[];
    }): Promise<{ count: number }>;
  };
  conceptExamTargetScore: {
    createMany(args: {
      data: ConceptExamTargetScoreCreateManyData[];
    }): Promise<{ count: number }>;
  };
}

export interface ExamTargetSnapshotPersistenceClient {
  $transaction<T>(
    work: (transaction: ExamTargetSnapshotPersistenceTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ExamTargetScoreCompletenessEntry {
  itemType: ExamTargetSnapshotItemType;
  domainCode: string;
  effectiveDomainWeight: number;
  expectedScoreCount: number;
  completeScoreCount: number;
  missingScoreCount: number;
  coverageStatus: 'covered' | 'missing';
}

export interface ExamTargetUnmappedDebtEntry {
  itemType: ExamTargetSnapshotItemType;
  unmappedItemCount: number;
}

export interface ExamTargetSnapshotManifest {
  schema: 'md3.exam-target-snapshot-manifest/v1';
  targetId: string;
  revision: number;
  targetVersion: string;
  targetRotation: ExamTargetRotation;
  status: 'built';
  privacyValidated: false;
  artifactHash: string;
  itemRowsHash: string;
  conceptRowsHash: string;
  sourceManifestHash: string;
  manifestHash: string;
  conceptCoverageStatus: 'complete' | 'incomplete';
  counts: {
    domainCount: number;
    eligibleItemCount: number;
    scoredItemCount: number;
    unmappedCoverageDebtCount: number;
    conceptScoreCount: number;
  };
  scoreCompleteness: readonly ExamTargetScoreCompletenessEntry[];
  unmappedCoverageDebt: readonly ExamTargetUnmappedDebtEntry[];
}

export type PersistExamTargetSnapshotResult = Readonly<{
  mode: 'dry-run' | 'apply';
  applied: boolean;
  snapshotId: string | null;
  manifest: ExamTargetSnapshotManifest;
}>;

export interface PersistExamTargetSnapshotOptions {
  mode?: 'dry-run' | 'apply';
  client?: ExamTargetSnapshotPersistenceClient;
}

export type ExamTargetSnapshotPersistenceErrorCode =
  | 'invalid_definition'
  | 'invalid_weight_policy'
  | 'compiled_identity_mismatch'
  | 'invalid_metadata'
  | 'invalid_compiled_snapshot'
  | 'invalid_mode'
  | 'client_required'
  | 'duplicate_target_revision'
  | 'duplicate_artifact_hash'
  | 'concept_scores_required'
  | 'score_write_count_mismatch'
  | 'concept_score_write_count_mismatch'
  | 'persistence_failed';

export class ExamTargetSnapshotPersistenceError extends Error {
  readonly code: ExamTargetSnapshotPersistenceErrorCode;

  constructor(code: ExamTargetSnapshotPersistenceErrorCode, message: string) {
    super(message);
    this.name = 'ExamTargetSnapshotPersistenceError';
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATOR_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SNAPSHOT_REFERENCE_ID = /^[A-Za-z0-9_-]+$/;
const PRISMA_CUID = /^c[a-z0-9]{24}$/;
const ITEM_TYPES = ['card', 'question'] as const;
const FLOAT_EPSILON = 1e-12;
const DOMAIN_MIX_EPSILON = 1e-9;

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function persistenceRow(row: CompiledExamTargetItemRow) {
  return {
    itemType: row.itemType,
    itemId: row.itemId,
    sourceRotation: row.sourceRotation,
    embeddingHash: row.embeddingHash,
    domainCode: row.domainCode,
    assignmentMethod: row.assignmentMethod,
    rawSimilarity: row.rawSimilarity,
    zSimilarity: row.zSimilarity,
    runnerUpDomainCode: row.runnerUpDomainCode,
    assignmentMargin: row.assignmentMargin,
    assignmentConfidence: row.assignmentConfidence,
    geometryConfidence: row.geometryConfidence,
    fitPercentile: row.fitPercentile,
    effectiveDomainWeight: row.effectiveDomainWeight,
    weightProvenance: row.weightProvenance,
    domainPriorityIndex: row.domainPriorityIndex,
    itemTargetIndex: row.itemTargetIndex,
  };
}

function conceptPersistenceRow(row: CompiledExamTargetConceptRow) {
  return {
    conceptId: row.conceptId,
    primaryDomainCode: row.primaryDomainCode,
    domainMix: Object.fromEntries(
      Object.entries(row.domainMix).sort(
        ([left], [right]) => stableStringCompare(left, right),
      ),
    ),
    mappingMethod: row.mappingMethod,
    targetIndex: row.targetIndex,
    mappingConfidence: row.mappingConfidence,
    mappingHash: row.mappingHash,
    artifactHash: row.artifactHash,
  };
}

function assertWeightPolicyMatchesDefinition(
  definition: ExamTargetDefinition,
  weightPolicy: ExamTargetWeightPolicy,
): void {
  const allOfficial = definition.domains.every(
    (domain) => domain.weightAuthority === 'official',
  );
  const allProxy = definition.domains.every(
    (domain) => domain.weightAuthority === 'proxy',
  );
  const officialQuestionTotal = definition.domains.reduce(
    (total, domain) => total + (domain.questionCount ?? 0),
    0,
  );
  const matchesOfficial = allOfficial
    && weightPolicy.kind === 'official-question-count'
    && definition.domains.every((domain) => domain.questionCount != null)
    && weightPolicy.totalQuestions === officialQuestionTotal;
  const matchesProxy = allProxy
    && weightPolicy.kind === 'proxy-shrunk-anchor-share'
    && weightPolicy.proxyShare === 0.5;

  if (!matchesOfficial && !matchesProxy) {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_weight_policy',
      `weightPolicy does not match validated ${definition.rotation} definition`,
    );
  }
}

function parseReviewedDefinition(value: unknown): ExamTargetDefinition {
  try {
    const definition = parseExamTargetDefinition(value);
    const registered = getExamTargetDefinition(definition.rotation);
    if (
      !registered
      || hashExamTargetArtifact(registered) !== hashExamTargetArtifact(definition)
    ) {
      throw new Error('definition does not match reviewed registry artifact');
    }
    return definition;
  } catch {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_definition',
      'reviewed exam target definition is invalid',
    );
  }
}

function assertReviewedMetadata(
  metadata: ReviewedExamTargetSnapshotMetadata,
): void {
  if (!SHA256.test(metadata.sourceManifestHash)) {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_metadata',
      'sourceManifestHash must be a lowercase SHA-256 digest',
    );
  }
  if (
    !GENERATOR_ID.test(metadata.generatedBy)
    || metadata.generatedBy.length > 128
  ) {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_metadata',
      'generatedBy must be a stable logical identifier',
    );
  }
  if (
    metadata.supersedesId != null
    && (
      !SNAPSHOT_REFERENCE_ID.test(metadata.supersedesId)
      || metadata.supersedesId.length > 191
    )
  ) {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_metadata',
      'supersedesId must be a stable snapshot identifier',
    );
  }
}

function assertCompiledIdentity(
  definition: ExamTargetDefinition,
  compiled: CompiledExamTargetSnapshot,
): void {
  if (
    compiled.targetId !== definition.targetId
    || compiled.revision !== definition.revision
    || compiled.targetVersion !== examTargetVersionId(definition)
    || compiled.targetRotation !== definition.rotation
    || compiled.scorerVersion !== definition.scoringPolicyVersion
  ) {
    throw new ExamTargetSnapshotPersistenceError(
      'compiled_identity_mismatch',
      'compiled snapshot identity does not match reviewed definition',
    );
  }
}

function invalidCompiledSnapshot(): never {
  throw new ExamTargetSnapshotPersistenceError(
    'invalid_compiled_snapshot',
    'compiled snapshot failed persistence preflight',
  );
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= FLOAT_EPSILON;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCompiledRows(
  definition: ExamTargetDefinition,
  compiled: CompiledExamTargetSnapshot,
): void {
  if (!Array.isArray(compiled.itemRows)) invalidCompiledSnapshot();

  const domains = [...definition.domains].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const domainByCode = new Map(domains.map((domain) => [domain.code, domain]));
  const maxDomainWeight = Math.max(
    ...domains.map((domain) => domain.effectiveWeight),
  );
  const seenItemKeys = new Set<string>();
  let previousItemKey: string | null = null;

  for (const row of compiled.itemRows) {
    const expectedItemKey = `${row.itemType}:${row.itemId}`;
    const domain = domainByCode.get(row.domainCode);
    const sourceRotationIsSafe = typeof row.sourceRotation === 'string'
      && row.sourceRotation.trim().length > 0
      && row.sourceRotation.length <= 128
      && !row.sourceRotation.includes('/')
      && !row.sourceRotation.includes('\\')
      && !row.sourceRotation.includes('..');
    if (
      !ITEM_TYPES.includes(row.itemType)
      || typeof row.itemId !== 'string'
      || row.itemId.trim().length === 0
      || row.itemKey !== expectedItemKey
      || seenItemKeys.has(row.itemKey)
      || (previousItemKey != null && previousItemKey.localeCompare(row.itemKey) >= 0)
      || !sourceRotationIsSafe
      || row.targetRotation !== definition.rotation
      || !SHA256.test(row.embeddingHash)
      || !domain
      || (row.assignmentMethod !== 'curated' && row.assignmentMethod !== 'centroid')
      || !isFiniteOrNull(row.rawSimilarity)
      || !isFiniteOrNull(row.zSimilarity)
      || !isFiniteOrNull(row.assignmentMargin)
      || (row.assignmentMargin != null && row.assignmentMargin < 0)
      || !isUnitInterval(row.assignmentConfidence)
      || !isUnitInterval(row.geometryConfidence)
      || !(row.fitPercentile === null || isUnitInterval(row.fitPercentile))
      || !Number.isFinite(row.effectiveDomainWeight)
      || !nearlyEqual(row.effectiveDomainWeight, domain.effectiveWeight)
      || !Number.isFinite(row.maxDomainWeight)
      || !nearlyEqual(row.maxDomainWeight, maxDomainWeight)
      || row.weightProvenance !== (
        domain.weightAuthority === 'official'
          ? 'official-question-count'
          : 'proxy-shrunk-anchor-share'
      )
      || !Number.isFinite(row.domainPriorityIndex)
      || !nearlyEqual(
        row.domainPriorityIndex,
        domain.effectiveWeight / maxDomainWeight,
      )
      || !Number.isFinite(row.itemTargetIndex)
      || row.runnerUpDomainCode === row.domainCode
      || (
        row.runnerUpDomainCode != null
        && !domainByCode.has(row.runnerUpDomainCode)
      )
    ) {
      invalidCompiledSnapshot();
    }

    const expectedItemTargetIndex = computeItemTargetIndex({
      effectiveDomainWeight: domain.effectiveWeight,
      maxDomainWeight,
      fitPercentile: row.fitPercentile,
      geometryConfidence: row.geometryConfidence,
      assignmentConfidence: row.assignmentConfidence,
    });
    if (
      expectedItemTargetIndex == null
      || !nearlyEqual(row.itemTargetIndex, expectedItemTargetIndex)
    ) {
      invalidCompiledSnapshot();
    }

    seenItemKeys.add(row.itemKey);
    previousItemKey = row.itemKey;
  }
}

function assertCompiledConceptRows(
  definition: ExamTargetDefinition,
  compiled: CompiledExamTargetSnapshot,
): void {
  if (!Array.isArray(compiled.conceptRows)) invalidCompiledSnapshot();
  const domains = [...definition.domains].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  const domainByCode = new Map(domains.map((domain) => [domain.code, domain]));
  const maxDomainWeight = Math.max(
    ...domains.map((domain) => domain.effectiveWeight),
  );
  const seenConceptIds = new Set<string>();
  let previousConceptId: string | null = null;

  for (const row of compiled.conceptRows) {
    if (
      typeof row.conceptId !== 'string'
      || row.conceptId.trim().length === 0
      || row.conceptId.length > 191
      || seenConceptIds.has(row.conceptId)
      || (
        previousConceptId != null
        && stableStringCompare(previousConceptId, row.conceptId) >= 0
      )
      || !domainByCode.has(row.primaryDomainCode)
      || !isPlainRecord(row.domainMix)
      || (
        row.mappingMethod !== 'reviewed'
        && row.mappingMethod !== 'capped-linked-item-draft'
      )
      || !isUnitInterval(row.mappingConfidence)
      || !SHA256.test(row.mappingHash)
      || !SHA256.test(row.artifactHash)
      || !isUnitInterval(row.targetIndex)
    ) {
      invalidCompiledSnapshot();
    }

    const rawEntries = Object.entries(row.domainMix);
    const entries = [...rawEntries].sort(([left], [right]) =>
      stableStringCompare(left, right),
    );
    if (
      entries.length === 0
      || rawEntries.some(([code], index) => code !== entries[index]?.[0])
    ) {
      invalidCompiledSnapshot();
    }
    let totalMass = 0;
    let weightedDomainPriority = 0;
    const validatedEntries: Array<readonly [string, number]> = [];
    for (const [domainCode, mass] of entries) {
      const domain = domainByCode.get(domainCode);
      if (!domain || !isUnitInterval(mass)) invalidCompiledSnapshot();
      totalMass += mass;
      weightedDomainPriority += mass * domain.effectiveWeight / maxDomainWeight;
      validatedEntries.push([domainCode, mass]);
    }
    const primaryMass = row.domainMix[row.primaryDomainCode];
    const deterministicPrimary = validatedEntries.reduce((best, entry) =>
      entry[1] > best[1] ? entry : best,
    )[0];
    if (
      Math.abs(totalMass - 1) > DOMAIN_MIX_EPSILON
      || typeof primaryMass !== 'number'
      || !(primaryMass > 0)
      || row.primaryDomainCode !== deterministicPrimary
      || !nearlyEqual(row.targetIndex, weightedDomainPriority / totalMass)
    ) {
      invalidCompiledSnapshot();
    }

    seenConceptIds.add(row.conceptId);
    previousConceptId = row.conceptId;
  }
}

function assertCompiledCoverage(
  definition: ExamTargetDefinition,
  compiled: CompiledExamTargetSnapshot,
): void {
  const coverage = compiled.coverage;
  if (
    !coverage
    || !Array.isArray(coverage.byItemType)
    || coverage.byItemType.length !== ITEM_TYPES.length
    || !Number.isInteger(coverage.eligibleItemCount)
    || !Number.isInteger(coverage.scoredItemCount)
    || !Number.isInteger(coverage.unmappedItemCount)
    || coverage.eligibleItemCount < 0
    || coverage.scoredItemCount < 0
    || coverage.unmappedItemCount < 0
  ) {
    invalidCompiledSnapshot();
  }

  const domains = [...definition.domains].sort((left, right) =>
    left.code.localeCompare(right.code),
  );
  let totalEligible = 0;
  let totalMapped = 0;
  let totalUnmapped = 0;
  const allKnownItemKeys = new Set(compiled.itemRows.map((row) => row.itemKey));

  for (const [itemTypeIndex, itemType] of ITEM_TYPES.entries()) {
    const entry = coverage.byItemType[itemTypeIndex];
    const actualRows = compiled.itemRows.filter((row) => row.itemType === itemType);
    if (
      !entry
      || entry.itemType !== itemType
      || !Number.isInteger(entry.eligibleItemCount)
      || !Number.isInteger(entry.mappedItemCount)
      || !Number.isInteger(entry.unmappedItemCount)
      || entry.eligibleItemCount < 0
      || entry.mappedItemCount < 0
      || entry.unmappedItemCount < 0
      || entry.eligibleItemCount !== entry.mappedItemCount + entry.unmappedItemCount
      || entry.mappedItemCount !== actualRows.length
      || !Array.isArray(entry.unmappedItemKeys)
      || entry.unmappedItemKeys.length !== entry.unmappedItemCount
      || !Array.isArray(entry.domains)
      || entry.domains.length !== domains.length
    ) {
      invalidCompiledSnapshot();
    }

    const seenUnmappedKeys = new Set<string>();
    let previousUnmappedKey: string | null = null;
    for (const key of entry.unmappedItemKeys) {
      if (
        typeof key !== 'string'
        || !key.startsWith(`${itemType}:`)
        || key.length === itemType.length + 1
        || seenUnmappedKeys.has(key)
        || allKnownItemKeys.has(key)
        || (previousUnmappedKey != null && previousUnmappedKey.localeCompare(key) >= 0)
      ) {
        invalidCompiledSnapshot();
      }
      seenUnmappedKeys.add(key);
      allKnownItemKeys.add(key);
      previousUnmappedKey = key;
    }

    let expectedCoveredWeight = 0;
    let expectedMissingWeight = 0;
    for (const [domainIndex, domain] of domains.entries()) {
      const domainCoverage = entry.domains[domainIndex];
      const actualMappedItemCount = actualRows.filter(
        (row) => row.domainCode === domain.code,
      ).length;
      const expectedStatus = actualMappedItemCount > 0 ? 'covered' : 'missing';
      if (
        !domainCoverage
        || domainCoverage.domainCode !== domain.code
        || !Number.isFinite(domainCoverage.effectiveDomainWeight)
        || !nearlyEqual(
          domainCoverage.effectiveDomainWeight,
          domain.effectiveWeight,
        )
        || !Number.isInteger(domainCoverage.mappedItemCount)
        || domainCoverage.mappedItemCount !== actualMappedItemCount
        || domainCoverage.coverageStatus !== expectedStatus
      ) {
        invalidCompiledSnapshot();
      }
      if (expectedStatus === 'covered') {
        expectedCoveredWeight += domain.effectiveWeight;
      } else {
        expectedMissingWeight += domain.effectiveWeight;
      }
    }
    if (
      !Number.isFinite(entry.coveredTargetWeight)
      || !Number.isFinite(entry.missingTargetWeight)
      || !nearlyEqual(entry.coveredTargetWeight, expectedCoveredWeight)
      || !nearlyEqual(entry.missingTargetWeight, expectedMissingWeight)
    ) {
      invalidCompiledSnapshot();
    }

    totalEligible += entry.eligibleItemCount;
    totalMapped += entry.mappedItemCount;
    totalUnmapped += entry.unmappedItemCount;
  }

  if (
    coverage.eligibleItemCount !== totalEligible
    || coverage.scoredItemCount !== totalMapped
    || coverage.scoredItemCount !== compiled.itemRows.length
    || coverage.unmappedItemCount !== totalUnmapped
    || coverage.eligibleItemCount !== coverage.scoredItemCount + coverage.unmappedItemCount
  ) {
    invalidCompiledSnapshot();
  }
}

function assertCompiledSnapshot(
  definition: ExamTargetDefinition,
  compiled: CompiledExamTargetSnapshot,
): void {
  assertCompiledRows(definition, compiled);
  assertCompiledConceptRows(definition, compiled);
  assertCompiledCoverage(definition, compiled);
}

interface ExamTargetSnapshotPreflight {
  definition: ExamTargetDefinition;
  metadata: Omit<ReviewedExamTargetSnapshotMetadata, 'definition'>;
  itemRows: readonly ReturnType<typeof persistenceRow>[];
  conceptRows: readonly ReturnType<typeof conceptPersistenceRow>[];
  manifest: ExamTargetSnapshotManifest;
}

function preflightSnapshot(
  input: PersistExamTargetSnapshotInput,
): ExamTargetSnapshotPreflight {
  const definition = parseReviewedDefinition(input.metadata.definition);
  const metadata: ReviewedExamTargetSnapshotMetadata = {
    definition,
    weightPolicy: input.metadata.weightPolicy.kind === 'official-question-count'
      ? {
          kind: 'official-question-count',
          totalQuestions: input.metadata.weightPolicy.totalQuestions,
        }
      : {
          kind: 'proxy-shrunk-anchor-share',
          proxyShare: input.metadata.weightPolicy.proxyShare,
        },
    sourceManifestHash: input.metadata.sourceManifestHash,
    generatedBy: input.metadata.generatedBy,
    supersedesId: input.metadata.supersedesId,
  };
  assertWeightPolicyMatchesDefinition(definition, metadata.weightPolicy);
  assertReviewedMetadata(metadata);
  assertCompiledIdentity(definition, input.compiled);
  assertCompiledSnapshot(definition, input.compiled);
  const itemRows = input.compiled.itemRows.map(persistenceRow);
  const conceptRows = input.compiled.conceptRows.map(conceptPersistenceRow);
  const scoreCompleteness = input.compiled.coverage.byItemType.flatMap(
    (itemTypeCoverage) => itemTypeCoverage.domains.map((domain) => {
      const completeScoreCount = itemRows.filter(
        (row) => row.itemType === itemTypeCoverage.itemType
          && row.domainCode === domain.domainCode,
      ).length;
      return {
        itemType: itemTypeCoverage.itemType,
        domainCode: domain.domainCode,
        effectiveDomainWeight: domain.effectiveDomainWeight,
        expectedScoreCount: domain.mappedItemCount,
        completeScoreCount,
        missingScoreCount: Math.max(0, domain.mappedItemCount - completeScoreCount),
        coverageStatus: domain.coverageStatus,
      };
    }),
  );
  const unmappedCoverageDebt = input.compiled.coverage.byItemType.map((entry) => ({
    itemType: entry.itemType,
    unmappedItemCount: entry.unmappedItemCount,
  }));
  const base = {
    schema: 'md3.exam-target-snapshot-manifest/v1' as const,
    targetId: definition.targetId,
    revision: definition.revision,
    targetVersion: examTargetVersionId(definition),
    targetRotation: definition.rotation,
    status: 'built' as const,
    privacyValidated: false as const,
    artifactHash: hashExamTargetArtifact(definition),
    itemRowsHash: hashExamTargetArtifact(itemRows),
    conceptRowsHash: hashExamTargetArtifact(conceptRows),
    sourceManifestHash: metadata.sourceManifestHash,
    conceptCoverageStatus: conceptRows.length > 0
      ? 'complete' as const
      : 'incomplete' as const,
    counts: {
      domainCount: definition.domains.length,
      eligibleItemCount: input.compiled.coverage.eligibleItemCount,
      scoredItemCount: input.compiled.coverage.scoredItemCount,
      unmappedCoverageDebtCount: input.compiled.coverage.unmappedItemCount,
      conceptScoreCount: conceptRows.length,
    },
    scoreCompleteness,
    unmappedCoverageDebt,
  };

  const manifest = {
    ...base,
    manifestHash: hashExamTargetArtifact(base),
  };

  const { definition: _definition, ...capturedMetadata } = metadata;
  void _definition;
  return {
    definition,
    metadata: capturedMetadata,
    itemRows,
    conceptRows,
    manifest,
  };
}

function snapshotCreateData(
  preflight: ExamTargetSnapshotPreflight,
): ExamTargetSnapshotCreateData {
  const { definition, manifest, metadata } = preflight;
  return {
    targetId: definition.targetId,
    revision: definition.revision,
    schemaVersion: definition.schema,
    rotation: definition.rotation,
    status: 'built',
    targetBasis: definition.targetBasis,
    validFrom: new Date(`${definition.validFrom}T00:00:00.000Z`),
    supersedesId: metadata.supersedesId,
    weightPolicy: metadata.weightPolicy,
    scorerVersion: definition.scoringPolicyVersion,
    embeddingModel: definition.embeddingModel,
    embeddingDimensions: definition.embeddingDimensions,
    sourceManifestHash: metadata.sourceManifestHash,
    anchorCorpusHash: definition.anchorCorpusHash,
    artifactHash: manifest.artifactHash,
    itemRowsHash: manifest.itemRowsHash,
    conceptRowsHash: manifest.conceptRowsHash,
    manifestHash: manifest.manifestHash,
    buildManifest: manifest,
    runtimeProjection: definition,
    privacyValidated: false,
    generatedBy: metadata.generatedBy,
    validatedAt: null,
    reviewedBy: definition.reviewedBy,
    activatedAt: null,
    activatedBy: null,
  };
}

function duplicateError(
  existing: ExistingExamTargetSnapshotIdentity,
  manifest: ExamTargetSnapshotManifest,
): ExamTargetSnapshotPersistenceError {
  if (
    existing.targetId === manifest.targetId
    && existing.revision === manifest.revision
  ) {
    return new ExamTargetSnapshotPersistenceError(
      'duplicate_target_revision',
      'exam target snapshot targetId and revision already exist',
    );
  }
  return new ExamTargetSnapshotPersistenceError(
    'duplicate_artifact_hash',
    'exam target snapshot artifact hash already exists',
  );
}

function uniqueConstraintError(
  error: unknown,
): ExamTargetSnapshotPersistenceError | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  if ((error as { code?: unknown }).code !== 'P2002') return null;

  const meta = 'meta' in error && error.meta && typeof error.meta === 'object'
    ? error.meta as { target?: unknown }
    : null;
  const target = meta?.target;
  const fields = Array.isArray(target)
    ? target.filter((field): field is string => typeof field === 'string')
    : typeof target === 'string'
      ? [target]
      : [];
  return fields.some((field) => field.includes('artifactHash'))
    ? new ExamTargetSnapshotPersistenceError(
        'duplicate_artifact_hash',
        'exam target snapshot artifact hash already exists',
      )
    : new ExamTargetSnapshotPersistenceError(
        'duplicate_target_revision',
        'exam target snapshot targetId and revision already exist',
      );
}

export async function persistExamTargetSnapshot(
  input: PersistExamTargetSnapshotInput,
  options: PersistExamTargetSnapshotOptions = {},
): Promise<PersistExamTargetSnapshotResult> {
  const mode = options.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new ExamTargetSnapshotPersistenceError(
      'invalid_mode',
      'snapshot persistence mode must be dry-run or apply',
    );
  }
  const preflight = preflightSnapshot(input);
  if (mode === 'dry-run') {
    return deepFreeze({
      mode: 'dry-run',
      applied: false,
      snapshotId: null,
      manifest: preflight.manifest,
    });
  }

  if (preflight.conceptRows.length === 0) {
    throw new ExamTargetSnapshotPersistenceError(
      'concept_scores_required',
      'apply mode requires at least one concept target score',
    );
  }

  if (!options.client) {
    throw new ExamTargetSnapshotPersistenceError(
      'client_required',
      'apply mode requires a snapshot persistence client',
    );
  }

  try {
    const snapshotId = await options.client.$transaction(async (transaction) => {
      const existing = await transaction.examTargetSnapshot.findFirst({
        where: {
          OR: [
            {
              targetId: preflight.manifest.targetId,
              revision: preflight.manifest.revision,
            },
            { artifactHash: preflight.manifest.artifactHash },
          ],
        },
        select: {
          id: true,
          targetId: true,
          revision: true,
          artifactHash: true,
        },
      });
      if (existing) throw duplicateError(existing, preflight.manifest);

      const created = await transaction.examTargetSnapshot.create({
        data: snapshotCreateData(preflight),
        select: { id: true },
      });
      if (
        typeof created.id !== 'string'
        || !PRISMA_CUID.test(created.id)
      ) {
        throw new ExamTargetSnapshotPersistenceError(
          'persistence_failed',
          'exam target snapshot persistence failed',
        );
      }
      const scoreRows: ItemExamTargetScoreCreateManyData[] =
        preflight.itemRows.map((row) => ({
          targetSnapshotId: created.id,
          ...row,
        }));
      if (scoreRows.length > 0) {
        const inserted = await transaction.itemExamTargetScore.createMany({
          data: scoreRows,
        });
        if (inserted.count !== scoreRows.length) {
          throw new ExamTargetSnapshotPersistenceError(
            'score_write_count_mismatch',
            'item score write count did not match the preflight manifest',
          );
        }
      }
      const conceptScoreRows: ConceptExamTargetScoreCreateManyData[] =
        preflight.conceptRows.map((row) => ({
          targetSnapshotId: created.id,
          ...row,
        }));
      const insertedConcepts = await transaction.conceptExamTargetScore.createMany({
        data: conceptScoreRows,
      });
      if (insertedConcepts.count !== conceptScoreRows.length) {
        throw new ExamTargetSnapshotPersistenceError(
          'concept_score_write_count_mismatch',
          'concept score write count did not match the preflight manifest',
        );
      }
      return created.id;
    });

    return deepFreeze({
      mode: 'apply',
      applied: true,
      snapshotId,
      manifest: preflight.manifest,
    });
  } catch (error) {
    if (error instanceof ExamTargetSnapshotPersistenceError) throw error;
    const uniqueError = uniqueConstraintError(error);
    if (uniqueError) throw uniqueError;
    throw new ExamTargetSnapshotPersistenceError(
      'persistence_failed',
      'exam target snapshot persistence failed',
    );
  }
}
