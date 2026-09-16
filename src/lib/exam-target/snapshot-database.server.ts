import { hashExamTargetArtifact } from './artifact';
import { examTargetVersionId } from './contract';
import { EXAM_TARGET_REGISTRY_SOURCE } from './registry-data';
import { getExamTargetDefinition } from './registry';
import { auditExamTargetSchemaReadiness } from './operations.server';
import {
  compileExamTargetSnapshot,
  type EligibleExamTargetConceptFact,
  type EligibleExamTargetItemFact,
  type ExamTargetSnapshotItemType,
} from './snapshot-builder';
import {
  persistExamTargetSnapshot,
  type ExamTargetSnapshotPersistenceClient,
  type PersistExamTargetSnapshotResult,
} from './snapshot-persistence.server';
import type {
  ExamTargetDefinition,
  ExamTargetDomain,
  ExamTargetRotation,
} from './types';

const SHA256 = /^[a-f0-9]{64}$/;
const CONCEPT_EVIDENCE_CAP_PER_DOMAIN = 3;
const TARGET_RELATIVE_INPUT_SET_FIELDS = [
  'schema',
  'targetRotation',
  'targetVersion',
  'anchorCorpusHash',
  'geometrySourceHashes',
  'scorerVersion',
  'items',
  'artifactHash',
] as const;
const TARGET_RELATIVE_ITEM_FIELDS = [
  'itemType',
  'itemId',
  'sourceRotation',
  'targetRotation',
  'targetVersion',
  'embeddingHash',
  'domainCode',
  'assignmentMethod',
  'rawSimilarity',
  'zSimilarity',
  'runnerUpDomainCode',
  'assignmentMargin',
  'fitPercentile',
  'assignmentConfidence',
  'geometryConfidence',
] as const;

interface DatabaseTargetItemInput {
  itemId: string;
  sourceRotation: string;
  variantGroupId: string | null;
  variantType: string | null;
  domainValue: string | null;
  rawSimilarity: number | null;
  fitPercentile: number | null;
  embeddingHash: string;
  conceptIds: string[] | null;
}

export interface ExamTargetSnapshotDatabaseReadClient {
  /** Queries return scalar metadata and an in-database hash, never a vector. */
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface ExamTargetTargetRelativeCandidate {
  itemType: ExamTargetSnapshotItemType;
  itemId: string;
  sourceRotation: string;
  embeddingHash: string;
  /** Internal-only calibration family; never serialized into the v1 artifact. */
  atomicFamilyKey: string;
}

export interface ExamTargetTargetRelativeItemInput {
  itemType: ExamTargetSnapshotItemType;
  itemId: string;
  sourceRotation: string;
  embeddingHash: string;
  targetRotation: ExamTargetRotation;
  targetVersion: string;
  domainCode: string | null;
  assignmentMethod: 'curated' | 'centroid' | null;
  rawSimilarity: number | null;
  zSimilarity: number | null;
  runnerUpDomainCode: string | null;
  assignmentMargin: number | null;
  fitPercentile: number | null;
  assignmentConfidence: number;
  geometryConfidence: number;
}

export interface ExamTargetTargetRelativeInputSet {
  schema: 'md3.exam-target-target-relative-item-input/v1';
  targetRotation: ExamTargetRotation;
  targetVersion: string;
  anchorCorpusHash: string;
  geometrySourceHashes: readonly string[];
  scorerVersion: string;
  items: readonly ExamTargetTargetRelativeItemInput[];
  artifactHash: string;
}

export interface BuildExamTargetTargetRelativeInputsContext {
  rotation: ExamTargetRotation;
  targetVersion: string;
  definition: ExamTargetDefinition;
  candidates: readonly ExamTargetTargetRelativeCandidate[];
}

export type ExamTargetTargetRelativeInputProvider = (
  context: BuildExamTargetTargetRelativeInputsContext,
) => Promise<ExamTargetTargetRelativeInputSet>;

export interface CompileExamTargetSnapshotFromDatabaseInput {
  client: ExamTargetSnapshotDatabaseReadClient
    & Partial<ExamTargetSnapshotPersistenceClient>;
  rotation: ExamTargetRotation;
  /** Exact checked-in registry version, for example `proxy...@1`. */
  targetVersion: string;
  mode?: 'dry-run' | 'apply';
  generatedBy?: string;
  supersedesId?: string | null;
  /** LOCAL-ONLY private-anchor scorer injected by the operator entry point. */
  targetRelativeInputProvider?: ExamTargetTargetRelativeInputProvider;
}

export interface ExamTargetDatabaseInputQualification {
  schema: 'md3.exam-target-db-input-qualification/v1';
  validationEligible: boolean;
  eligibleItemCount: number;
  mappedItemCount: number;
  neutralCoverageDebtCount: number;
  nativeEligibleItemCount: number;
  nativeMappedItemCount: number;
  crossSourceEligibleItemCount: number;
  crossSourceMappedItemCount: number;
  crossSourceNeutralDebtCount: number;
  targetRelativeInputArtifactHash: string | null;
  missingBySourceRotation: Readonly<Record<string, number>>;
  requiredInputContract: null | {
    schema: 'md3.exam-target-target-relative-item-input/v1';
    availability: 'not-configured' | 'configured-incomplete';
    requiredFields: readonly string[];
    rule: 'never-reuse-source-home-domain';
  };
  issues: readonly string[];
}

export type CompileExamTargetSnapshotFromDatabaseResult =
  PersistExamTargetSnapshotResult & {
    inputQualification: ExamTargetDatabaseInputQualification;
  };

const CARD_INPUT_QUERY = String.raw`
/* exam-target:card-inputs */
SELECT
  c.id AS "itemId",
  c.rotation AS "sourceRotation",
  c."variantGroupId" AS "variantGroupId",
  c."variantType" AS "variantType",
  c."examDomain" AS "domainValue",
  c."examDomainSim" AS "rawSimilarity",
  c."examRelevancePct" AS "fitPercentile",
  encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex') AS "embeddingHash",
  CASE
    WHEN c."conceptId" IS NULL THEN ARRAY[]::text[]
    ELSE ARRAY[c."conceptId"]::text[]
  END AS "conceptIds"
FROM "Card" c
JOIN card_embeddings e ON e.card_id = c.id
WHERE (c.rotation = $1 OR $1 = ANY(c."moduleNodes"))
  AND c."deletedAt" IS NULL
  AND c."shelvedAt" IS NULL
  AND c."ownerUserId" IS NULL
ORDER BY c.id
`;

const QUESTION_INPUT_QUERY = String.raw`
/* exam-target:question-inputs */
SELECT
  q.id AS "itemId",
  q.rotation AS "sourceRotation",
  q."variantGroupId" AS "variantGroupId",
  q."variantType" AS "variantType",
  q."examDomain" AS "domainValue",
  q."examDomainSim" AS "rawSimilarity",
  q."examRelevancePct" AS "fitPercentile",
  encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex') AS "embeddingHash",
  ARRAY(
    SELECT qc."conceptId"
    FROM "QuestionConcept" qc
    WHERE qc."questionId" = q.id
    ORDER BY qc."conceptId"
  )::text[] AS "conceptIds"
FROM "Question" q
JOIN question_embeddings e ON e.question_id = q.id
WHERE (q.rotation = $1 OR $1 = ANY(q."moduleNodes"))
  AND q.excluded = false
  AND q."contentState" NOT IN ('shelved', 'retired')
ORDER BY q.id
`;

async function readDatabaseTargetInputs(
  client: ExamTargetSnapshotDatabaseReadClient,
  rotation: ExamTargetRotation,
): Promise<{
  cardRows: DatabaseTargetItemInput[];
  questionRows: DatabaseTargetItemInput[];
}> {
  const [rawCardRows, rawQuestionRows] = await Promise.all([
    client.$queryRawUnsafe(CARD_INPUT_QUERY, rotation),
    client.$queryRawUnsafe(QUESTION_INPUT_QUERY, rotation),
  ]);
  if (!Array.isArray(rawCardRows) || !Array.isArray(rawQuestionRows)) {
    throw new Error('exam-target database inputs must be arrays');
  }
  return {
    cardRows: rawCardRows as DatabaseTargetItemInput[],
    questionRows: rawQuestionRows as DatabaseTargetItemInput[],
  };
}

function databaseInputRowsForHash(
  cardRows: readonly DatabaseTargetItemInput[],
  questionRows: readonly DatabaseTargetItemInput[],
): unknown[] {
  return [...cardRows, ...questionRows].map((row, index) => {
    const itemType = index < cardRows.length ? 'card' : 'question';
    return {
      itemType,
      itemId: row.itemId,
      sourceRotation: row.sourceRotation,
      atomicFamilyKey: databaseAtomicFamilyKey(row, itemType),
      embeddingHash: row.embeddingHash,
      domainValue: row.domainValue,
      rawSimilarity: row.rawSimilarity,
      fitPercentile: row.fitPercentile,
      conceptIds: [...new Set(row.conceptIds ?? [])].sort(),
    };
  });
}

function assertExactTarget(
  rotation: ExamTargetRotation,
  targetVersion: string,
) {
  const definition = getExamTargetDefinition(rotation);
  if (!definition || examTargetVersionId(definition) !== targetVersion) {
    throw new Error(
      `target version must exactly match the reviewed ${rotation} registry entry`,
    );
  }
  return definition;
}

function normalizedLookupValue(value: string): string {
  return value.trim().toLocaleLowerCase('en-AU');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(
  value: unknown,
  expectedFields: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isUnitIntervalOrNull(value: unknown): value is number | null {
  return value === null || (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
  );
}

function targetRelativeItemKey(
  value: Pick<ExamTargetTargetRelativeCandidate, 'itemType' | 'itemId'>,
): string {
  return `${value.itemType}:${value.itemId}`;
}

function databaseAtomicFamilyKey(
  row: DatabaseTargetItemInput,
  itemType: ExamTargetSnapshotItemType,
): string {
  if (
    typeof row.itemId !== 'string'
    || !row.itemId.trim()
    || typeof row.sourceRotation !== 'string'
    || !row.sourceRotation.trim()
    || (row.variantGroupId != null && typeof row.variantGroupId !== 'string')
    || (row.variantType != null && typeof row.variantType !== 'string')
  ) throw new Error(`invalid ${itemType} family input`);
  const variantGroupId = row.variantGroupId?.trim() || null;
  const collapses = itemType === 'card'
    ? row.variantType === 'cloze-blank'
    : row.variantType === 'near-duplicate';
  const familyIdentity = collapses && variantGroupId
    ? `family:${variantGroupId}`
    : `item:${row.itemId}`;
  return `${itemType}:${row.sourceRotation}:${familyIdentity}`;
}

function domainLookup(domains: readonly ExamTargetDomain[]): Map<string, ExamTargetDomain> {
  const lookup = new Map<string, ExamTargetDomain>();
  for (const domain of domains) {
    for (const value of [domain.code, domain.label, ...domain.aliases]) {
      const key = normalizedLookupValue(value);
      const existing = lookup.get(key);
      if (existing && existing.code !== domain.code) {
        throw new Error(`ambiguous reviewed domain alias ${value}`);
      }
      lookup.set(key, domain);
    }
  }
  return lookup;
}

function mappedDomain(
  value: string | null,
  lookup: ReadonlyMap<string, ExamTargetDomain>,
): ExamTargetDomain | null {
  if (!value) return null;
  const domain = lookup.get(normalizedLookupValue(value)) ?? null;
  if (
    !domain
    || domain.anchorSupport === 'sparse'
    || domain.anchorSupport === 'missing'
  ) {
    return null;
  }
  return domain;
}

function geometryConfidence(domain: ExamTargetDomain): number {
  return domain.anchorSupport === 'sufficient' ? 1 : 0.5;
}

function itemFact(
  row: DatabaseTargetItemInput,
  itemType: ExamTargetSnapshotItemType,
  rotation: ExamTargetRotation,
  lookup: ReadonlyMap<string, ExamTargetDomain>,
): EligibleExamTargetItemFact {
  if (
    typeof row.itemId !== 'string'
    || typeof row.sourceRotation !== 'string'
    || !SHA256.test(row.embeddingHash)
  ) {
    throw new Error(`invalid ${itemType} target input`);
  }
  // Legacy examDomain is home-rotation-relative. It is never re-used as a
  // cross-source target score; module-mapped cross-source rows remain explicit
  // coverage debt until a target-relative mapping is reviewed.
  const domain = row.sourceRotation === rotation
    ? mappedDomain(row.domainValue, lookup)
    : null;
  if (!domain) {
    return {
      itemType,
      id: row.itemId,
      sourceRotation: row.sourceRotation,
      targetRotation: rotation,
      embeddingHash: row.embeddingHash,
      domainCode: null,
      assignmentMethod: null,
      rawSimilarity: null,
      zSimilarity: null,
      runnerUpDomainCode: null,
      assignmentMargin: null,
      fitPercentile: null,
      assignmentConfidence: 0,
      geometryConfidence: 0,
    };
  }
  const confidence = geometryConfidence(domain);
  return {
    itemType,
    id: row.itemId,
    sourceRotation: row.sourceRotation,
    targetRotation: rotation,
    embeddingHash: row.embeddingHash,
    domainCode: domain.code,
    assignmentMethod: 'centroid',
    rawSimilarity: row.rawSimilarity,
    zSimilarity: null,
    runnerUpDomainCode: null,
    assignmentMargin: null,
    fitPercentile: row.fitPercentile,
    assignmentConfidence: confidence,
    geometryConfidence: confidence,
  };
}

function validateTargetRelativeInputSet(
  value: ExamTargetTargetRelativeInputSet,
  definition: ExamTargetDefinition,
  targetVersion: string,
  candidates: readonly ExamTargetTargetRelativeCandidate[],
): ReadonlyMap<string, ExamTargetTargetRelativeItemInput> {
  const expectedGeometrySourceHashes = definition.evidence.geometry
    .map(source => source.sha256)
    .sort();
  if (
    !hasExactFields(value, TARGET_RELATIVE_INPUT_SET_FIELDS)
    || value.schema !== 'md3.exam-target-target-relative-item-input/v1'
    || value.targetRotation !== definition.rotation
    || value.targetVersion !== targetVersion
    || value.anchorCorpusHash !== definition.anchorCorpusHash
    || !Array.isArray(value.geometrySourceHashes)
    || value.geometrySourceHashes.length !== expectedGeometrySourceHashes.length
    || value.geometrySourceHashes.some(
      (hash, index) => hash !== expectedGeometrySourceHashes[index],
    )
    || value.scorerVersion !== definition.scoringPolicyVersion
    || !SHA256.test(value.artifactHash as string)
    || !Array.isArray(value.items)
  ) {
    throw new Error('target-relative input artifact binding is invalid');
  }
  const { artifactHash, ...artifactBase } = value;
  if (hashExamTargetArtifact(artifactBase) !== artifactHash) {
    throw new Error('target-relative input artifact hash is invalid');
  }

  const candidateByKey = new Map<string, ExamTargetTargetRelativeCandidate>();
  for (const candidate of candidates) {
    const key = targetRelativeItemKey(candidate);
    if (candidateByKey.has(key)) {
      throw new Error(`duplicate target-relative candidate ${key}`);
    }
    if (
      typeof candidate.atomicFamilyKey !== 'string'
      || !candidate.atomicFamilyKey.startsWith(
        `${candidate.itemType}:${candidate.sourceRotation}:`,
      )
    ) throw new Error(`target-relative family binding is invalid for ${key}`);
    candidateByKey.set(key, candidate);
  }
  const allowedDomains = new Set(definition.domains.map(domain => domain.code));
  const inputByKey = new Map<string, ExamTargetTargetRelativeItemInput>();
  for (const rawItem of value.items) {
    if (!hasExactFields(rawItem, TARGET_RELATIVE_ITEM_FIELDS)) {
      throw new Error('target-relative item input fields are invalid');
    }
    const item = rawItem as unknown as ExamTargetTargetRelativeItemInput;
    const key = targetRelativeItemKey(item);
    const candidate = candidateByKey.get(key);
    if (!candidate) throw new Error(`unknown target-relative item input ${key}`);
    if (inputByKey.has(key)) throw new Error(`duplicate target-relative item input ${key}`);
    if (
      item.sourceRotation !== candidate.sourceRotation
      || item.targetRotation !== definition.rotation
      || item.targetVersion !== targetVersion
    ) {
      throw new Error(`target-relative item identity binding is invalid for ${key}`);
    }
    if (item.embeddingHash !== candidate.embeddingHash) {
      throw new Error(`target-relative embedding binding is stale for ${key}`);
    }
    const neutral = item.domainCode === null;
    if (
      !SHA256.test(item.embeddingHash)
      || !isFiniteOrNull(item.rawSimilarity)
      || !isFiniteOrNull(item.zSimilarity)
      || !isFiniteOrNull(item.assignmentMargin)
      || (item.assignmentMargin != null && item.assignmentMargin < 0)
      || !isUnitIntervalOrNull(item.fitPercentile)
      || !isUnitIntervalOrNull(item.assignmentConfidence)
      || item.assignmentConfidence == null
      || !isUnitIntervalOrNull(item.geometryConfidence)
      || item.geometryConfidence == null
      || (!neutral && !allowedDomains.has(item.domainCode!))
      || (
        !neutral
        && item.assignmentMethod !== 'curated'
        && item.assignmentMethod !== 'centroid'
      )
      || (
        item.runnerUpDomainCode != null
        && (
          !allowedDomains.has(item.runnerUpDomainCode)
          || item.runnerUpDomainCode === item.domainCode
        )
      )
      || (
        neutral
        && (
          item.assignmentMethod !== null
          || item.rawSimilarity !== null
          || item.zSimilarity !== null
          || item.runnerUpDomainCode !== null
          || item.assignmentMargin !== null
          || item.fitPercentile !== null
          || item.assignmentConfidence !== 0
          || item.geometryConfidence !== 0
        )
      )
    ) {
      throw new Error(`target-relative assignment evidence is invalid for ${key}`);
    }
    inputByKey.set(key, item);
  }
  if (inputByKey.size !== candidateByKey.size) {
    throw new Error('target-relative input artifact must cover every eligible item');
  }
  const geometryByFamily = new Map<string, string>();
  for (const candidate of candidates) {
    const item = inputByKey.get(targetRelativeItemKey(candidate))!;
    const geometry = JSON.stringify({
      domainCode: item.domainCode,
      assignmentMethod: item.assignmentMethod,
      rawSimilarity: item.rawSimilarity,
      zSimilarity: item.zSimilarity,
      runnerUpDomainCode: item.runnerUpDomainCode,
      assignmentMargin: item.assignmentMargin,
      fitPercentile: item.fitPercentile,
      assignmentConfidence: item.assignmentConfidence,
      geometryConfidence: item.geometryConfidence,
    });
    const existing = geometryByFamily.get(candidate.atomicFamilyKey);
    if (existing !== undefined && existing !== geometry) {
      throw new Error('target-relative family members have divergent geometry');
    }
    geometryByFamily.set(candidate.atomicFamilyKey, geometry);
  }
  return inputByKey;
}

function targetRelativeItemFact(
  candidate: ExamTargetTargetRelativeCandidate,
  inputByKey: ReadonlyMap<string, ExamTargetTargetRelativeItemInput>,
  rotation: ExamTargetRotation,
): EligibleExamTargetItemFact {
  const input = inputByKey.get(targetRelativeItemKey(candidate));
  if (!input || input.domainCode === null) {
    return {
      itemType: candidate.itemType,
      id: candidate.itemId,
      sourceRotation: candidate.sourceRotation,
      targetRotation: rotation,
      embeddingHash: candidate.embeddingHash,
      domainCode: null,
      assignmentMethod: null,
      rawSimilarity: null,
      zSimilarity: null,
      runnerUpDomainCode: null,
      assignmentMargin: null,
      fitPercentile: null,
      assignmentConfidence: 0,
      geometryConfidence: 0,
    };
  }
  return {
    itemType: candidate.itemType,
    id: candidate.itemId,
    sourceRotation: candidate.sourceRotation,
    targetRotation: rotation,
    embeddingHash: candidate.embeddingHash,
    domainCode: input.domainCode,
    assignmentMethod: input.assignmentMethod!,
    rawSimilarity: input.rawSimilarity,
    zSimilarity: input.zSimilarity,
    runnerUpDomainCode: input.runnerUpDomainCode,
    assignmentMargin: input.assignmentMargin,
    fitPercentile: input.fitPercentile,
    assignmentConfidence: input.assignmentConfidence,
    geometryConfidence: input.geometryConfidence,
  };
}

function conceptFacts(
  rows: readonly DatabaseTargetItemInput[],
  itemFacts: readonly EligibleExamTargetItemFact[],
  definitionHash: string,
): EligibleExamTargetConceptFact[] {
  const votesByConcept = new Map<
    string,
    Map<string, { itemKey: string; domainCode: string }>
  >();
  rows.forEach((row, index) => {
    const itemFact = itemFacts[index];
    const domainCode = itemFact?.domainCode;
    if (!domainCode || !Array.isArray(row.conceptIds)) return;
    const atomicFamilyKey = databaseAtomicFamilyKey(row, itemFact.itemType);
    const itemKey = `${itemFact.itemType}:${row.itemId}`;
    for (const conceptId of new Set(row.conceptIds)) {
      if (typeof conceptId !== 'string' || !conceptId.trim()) continue;
      const votes = votesByConcept.get(conceptId) ?? new Map();
      const existing = votes.get(atomicFamilyKey);
      if (!existing || itemKey.localeCompare(existing.itemKey) < 0) {
        votes.set(atomicFamilyKey, { itemKey, domainCode });
      }
      votesByConcept.set(conceptId, votes);
    }
  });

  return [...votesByConcept.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([conceptId, votes]) => {
      const counts = new Map<string, number>();
      for (const { domainCode } of [...votes.values()].sort(
        (left, right) => left.itemKey.localeCompare(right.itemKey),
      )) {
        counts.set(
          domainCode,
          Math.min(
            CONCEPT_EVIDENCE_CAP_PER_DOMAIN,
            (counts.get(domainCode) ?? 0) + 1,
          ),
        );
      }
      const sortedCounts = [...counts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      );
      const total = sortedCounts.reduce((sum, [, count]) => sum + count, 0);
      const domainMix = Object.fromEntries(
        sortedCounts.map(([domainCode, count]) => [domainCode, count / total]),
      );
      const primaryDomainCode = sortedCounts.reduce((best, entry) =>
        entry[1] > best[1] ? entry : best,
      )[0];
      const mappingEvidence = {
        schema: 'md3.exam-target-concept-draft/v1',
        conceptId,
        domainMix,
        mappingMethod: 'capped-linked-item-draft',
        capPerDomain: CONCEPT_EVIDENCE_CAP_PER_DOMAIN,
      } as const;
      return {
        conceptId,
        domainMix,
        primaryDomainCode,
        mappingMethod: 'capped-linked-item-draft' as const,
        mappingConfidence: Math.min(1, total / CONCEPT_EVIDENCE_CAP_PER_DOMAIN),
        mappingHash: hashExamTargetArtifact(mappingEvidence),
        artifactHash: hashExamTargetArtifact({
          definitionHash,
          mappingHash: hashExamTargetArtifact(mappingEvidence),
        }),
      };
    });
}

/**
 * Compile the reviewed target against the current database projection. The
 * default is deliberately read-only. Raw vectors and content never cross the
 * SQL boundary; Postgres returns only stable IDs, bounded scalars and SHA-256s.
 */
export async function compileExamTargetSnapshotFromDatabase(
  input: CompileExamTargetSnapshotFromDatabaseInput,
): Promise<CompileExamTargetSnapshotFromDatabaseResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error('snapshot compile mode must be dry-run or apply');
  }
  const definition = assertExactTarget(input.rotation, input.targetVersion);
  const schemaReadiness = await auditExamTargetSchemaReadiness(input.client);
  if (!schemaReadiness.ready) {
    throw new Error(
      `snapshot compile schema readiness failed: ${schemaReadiness.missingDependencies.join(',')}`,
    );
  }
  const { cardRows, questionRows } = await readDatabaseTargetInputs(
    input.client,
    input.rotation,
  );
  const allRows = [...cardRows, ...questionRows];
  const lookup = domainLookup(definition.domains);
  const legacyItemFacts = [
    ...cardRows.map(row => itemFact(row, 'card', input.rotation, lookup)),
    ...questionRows.map(row => itemFact(row, 'question', input.rotation, lookup)),
  ];
  const candidates = legacyItemFacts.map((fact, index) => ({
    itemType: fact.itemType,
    itemId: fact.id,
    sourceRotation: fact.sourceRotation,
    embeddingHash: fact.embeddingHash,
    atomicFamilyKey: databaseAtomicFamilyKey(allRows[index], fact.itemType),
  })).sort((left, right) =>
    targetRelativeItemKey(left).localeCompare(targetRelativeItemKey(right)),
  );
  const targetRelativeInputs = input.targetRelativeInputProvider
    ? await input.targetRelativeInputProvider({
        rotation: input.rotation,
        targetVersion: input.targetVersion,
        definition,
        candidates,
      })
    : null;
  if (targetRelativeInputs) {
    const current = await readDatabaseTargetInputs(input.client, input.rotation);
    if (
      hashExamTargetArtifact(databaseInputRowsForHash(cardRows, questionRows))
      !== hashExamTargetArtifact(databaseInputRowsForHash(
        current.cardRows,
        current.questionRows,
      ))
    ) {
      throw new Error('database inputs changed during target-relative scoring');
    }
  }
  const targetRelativeInputByKey = targetRelativeInputs
    ? validateTargetRelativeInputSet(
        targetRelativeInputs,
        definition,
        input.targetVersion,
        candidates,
      )
    : null;
  // Once a target-relative provider is configured, its missing rows remain
  // neutral debt. Never fall back to a source-home legacy domain and thereby
  // hide incomplete private-anchor scoring.
  const itemFacts = targetRelativeInputByKey
    ? legacyItemFacts.map((fact, index) => targetRelativeItemFact({
        itemType: fact.itemType,
        itemId: fact.id,
        sourceRotation: fact.sourceRotation,
        embeddingHash: fact.embeddingHash,
        atomicFamilyKey: databaseAtomicFamilyKey(allRows[index], fact.itemType),
      }, targetRelativeInputByKey, input.rotation))
    : legacyItemFacts;
  const definitionHash = hashExamTargetArtifact(definition);
  const concepts = conceptFacts(allRows, itemFacts, definitionHash);
  const compiled = compileExamTargetSnapshot({
    definition,
    items: itemFacts,
    concepts,
  });
  const sourceManifestHash = hashExamTargetArtifact({
    schema: 'md3.exam-target-db-input-manifest/v1',
    targetVersion: input.targetVersion,
    targetRelativeInputArtifactHash: targetRelativeInputs?.artifactHash ?? null,
    items: databaseInputRowsForHash(cardRows, questionRows),
    concepts: concepts.map(concept => ({
      conceptId: concept.conceptId,
      mappingHash: concept.mappingHash,
      artifactHash: concept.artifactHash,
    })),
  });
  const nativeFacts = itemFacts.filter(fact => fact.sourceRotation === input.rotation);
  const crossSourceFacts = itemFacts.filter(
    fact => fact.sourceRotation !== input.rotation,
  );
  const nativeMappedItemCount = nativeFacts.filter(
    fact => fact.domainCode != null,
  ).length;
  const crossSourceMappedItemCount = crossSourceFacts.filter(
    fact => fact.domainCode != null,
  ).length;
  const missingBySourceRotation = Object.fromEntries(
    [...new Set(crossSourceFacts.map(fact => fact.sourceRotation))]
      .sort()
      .map(sourceRotation => [
        sourceRotation,
        crossSourceFacts.filter(fact => (
          fact.sourceRotation === sourceRotation && fact.domainCode == null
        )).length,
      ]),
  );
  const issues: string[] = [];
  for (const itemType of ['card', 'question'] as const) {
    const nativeTypeFacts = nativeFacts.filter(fact => fact.itemType === itemType);
    const nativeTypeMappedCount = nativeTypeFacts.filter(
      fact => fact.domainCode != null,
    ).length;
    if (
      nativeTypeFacts.length > 0
      && nativeTypeMappedCount / nativeTypeFacts.length < 0.95
    ) issues.push(`${itemType}_native_target_relative_coverage_below_threshold`);

    const crossTypeFacts = crossSourceFacts.filter(fact => fact.itemType === itemType);
    const crossTypeMappedCount = crossTypeFacts.filter(
      fact => fact.domainCode != null,
    ).length;
    if (
      targetRelativeInputs
      && crossTypeFacts.length > 0
      && crossTypeMappedCount / crossTypeFacts.length < 0.95
    ) issues.push(`${itemType}_cross_source_target_relative_coverage_below_threshold`);
  }
  if (
    !targetRelativeInputs
    && crossSourceFacts.length > 0
    && crossSourceMappedItemCount / crossSourceFacts.length < 0.95
  ) {
    issues.push('cross_source_target_relative_inputs_missing');
  }
  const mappedItemCount = nativeMappedItemCount + crossSourceMappedItemCount;
  const crossSourceNeutralDebtCount = crossSourceFacts.length
    - crossSourceMappedItemCount;
  const neutralCoverageDebtCount = itemFacts.length - mappedItemCount;
  const inputQualification: ExamTargetDatabaseInputQualification = {
    schema: 'md3.exam-target-db-input-qualification/v1',
    validationEligible: issues.length === 0,
    eligibleItemCount: itemFacts.length,
    mappedItemCount,
    neutralCoverageDebtCount,
    nativeEligibleItemCount: nativeFacts.length,
    nativeMappedItemCount,
    crossSourceEligibleItemCount: crossSourceFacts.length,
    crossSourceMappedItemCount,
    crossSourceNeutralDebtCount,
    targetRelativeInputArtifactHash: targetRelativeInputs?.artifactHash ?? null,
    missingBySourceRotation,
    requiredInputContract: neutralCoverageDebtCount === 0
      ? null
      : {
          schema: 'md3.exam-target-target-relative-item-input/v1',
          availability: targetRelativeInputs
            ? 'configured-incomplete'
            : 'not-configured',
          requiredFields: [...TARGET_RELATIVE_ITEM_FIELDS],
          rule: 'never-reuse-source-home-domain',
        },
    issues,
  };
  if (mode === 'apply' && !inputQualification.validationEligible) {
    throw new Error(
      'target-relative mapping coverage must reach 95% before snapshot apply',
    );
  }
  const persistenceClient = mode === 'apply'
    ? input.client as ExamTargetSnapshotDatabaseReadClient
      & ExamTargetSnapshotPersistenceClient
    : undefined;
  const persisted = await persistExamTargetSnapshot({
    compiled,
    metadata: {
      definition,
      weightPolicy: EXAM_TARGET_REGISTRY_SOURCE[input.rotation].weightPolicy,
      sourceManifestHash,
      generatedBy: input.generatedBy ?? 'exam-target-operator-v1',
      supersedesId: input.supersedesId ?? null,
    },
  }, {
    mode,
    client: persistenceClient,
  });

  return {
    ...persisted,
    inputQualification,
  };
}
