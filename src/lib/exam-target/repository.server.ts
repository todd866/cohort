import { createHash } from 'node:crypto';
import {
  resolveExamTargetActivation,
  type ExamTargetActivationMode,
  type ExamTargetSnapshotLifecycle,
  type ResolvedExamTargetActivation,
} from './activation';
import { hashExamTargetArtifact } from './artifact';
import { examTargetVersionId, parseExamTargetDefinition } from './contract';
import type {
  ExamTargetBasis,
  ExamTargetDefinition,
  ExamTargetRotation,
} from './types';

const SHA256 = /^[a-f0-9]{64}$/;

interface ExamTargetSnapshotRow {
  id: string;
  targetId: string;
  revision: number;
  schemaVersion: string;
  rotation: string;
  status: string;
  targetBasis: string;
  privacyValidated: boolean;
  validFrom: Date | null;
  scorerVersion: string;
  artifactHash: string;
  runtimeProjection: unknown;
}

interface ExamTargetActivationRow {
  mode: string;
  rolloutBasisPoints: number;
  activationRevision: number;
  schedulerVersion: string;
  policyFingerprint: string;
  targetSnapshot: ExamTargetSnapshotRow | null;
}

export interface ExamTargetRepositoryClient {
  examTargetActivation: {
    findUnique(args: unknown): Promise<ExamTargetActivationRow | null>;
  };
}

export type ExamTargetLoadFailureReason =
  | 'activation-read-failed'
  | 'activation-row-invalid'
  | 'runtime-projection-invalid'
  | 'snapshot-metadata-mismatch'
  | 'artifact-hash-mismatch'
  | 'snapshot-not-yet-valid'
  | null;

export interface RuntimeExamTargetSnapshot {
  id: string;
  targetId: string;
  revision: number;
  targetVersion: string;
  rotation: ExamTargetRotation;
  lifecycle: ExamTargetSnapshotLifecycle;
  privacyValidated: true;
  targetBasis: ExamTargetBasis;
  scorerVersion: string;
  artifactHash: string;
  definition: ExamTargetDefinition;
}

export interface RuntimeExamTargetContext {
  resolved: ResolvedExamTargetActivation;
  snapshot: RuntimeExamTargetSnapshot | null;
  activationRevision: number | null;
  schedulerVersion: string | null;
  policyDigest: string | null;
  loadFailureReason: ExamTargetLoadFailureReason;
}

export interface LoadRuntimeExamTargetInput {
  client: ExamTargetRepositoryClient;
  rotation: ExamTargetRotation;
  hardOff: boolean;
  /** Stable server-owned identity (normally user id; guest session id for guests). */
  assignmentKey: string;
  now?: Date;
}

export type ExamTargetItemType = 'card' | 'question';

export interface ExamTargetItemRef {
  itemType: ExamTargetItemType;
  itemId: string;
  sourceRotation: string;
}

interface ItemExamTargetScoreRow extends ExamTargetItemRef {
  embeddingHash: string;
  domainCode: string;
  assignmentMethod: string;
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

export type RuntimeItemExamTargetScore = ItemExamTargetScoreRow;

interface CurrentItemEmbeddingHashRow {
  itemType: string;
  itemId: string;
  embeddingHash: string;
}

export interface ExamTargetScoreRepositoryClient {
  itemExamTargetScore: {
    findMany(args: unknown): Promise<ItemExamTargetScoreRow[]>;
  };
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface LoadItemExamTargetScoresInput {
  client: ExamTargetScoreRepositoryClient;
  targetSnapshotId: string;
  items: readonly ExamTargetItemRef[];
}

export interface LoadedItemExamTargetScores {
  scores: Map<string, RuntimeItemExamTargetScore>;
  rejectedItemKeys: string[];
  /** Successfully read, valid snapshot scope with no target-relative boost row. */
  neutralItemKeys: string[];
}

interface ConceptExamTargetScoreRow {
  conceptId: string;
  primaryDomainCode: string;
  domainMix: unknown;
  mappingMethod: string;
  targetIndex: number;
  mappingConfidence: number;
  mappingHash: string;
  artifactHash: string;
}

export interface RuntimeConceptExamTargetScore {
  conceptId: string;
  primaryDomainCode: string;
  /** Canonically key-sorted, normalized domain mass. */
  domainMix: Readonly<Record<string, number>>;
  mappingMethod: 'reviewed' | 'capped-linked-item-draft';
  targetIndex: number;
  mappingConfidence: number;
  mappingHash: string;
  artifactHash: string;
}

export interface ExamTargetConceptScoreRepositoryClient {
  conceptExamTargetScore: {
    findMany(args: unknown): Promise<ConceptExamTargetScoreRow[]>;
  };
}

export interface LoadConceptExamTargetScoresInput {
  client: ExamTargetConceptScoreRepositoryClient;
  targetSnapshotId: string;
  conceptIds: readonly string[];
  allowedDomainCodes: readonly string[];
}

export interface LoadedConceptExamTargetScores {
  scores: Map<string, RuntimeConceptExamTargetScore>;
  rejectedConceptIds: string[];
  /** Valid snapshot read with no reviewed mapping; downstream keeps baseline priority. */
  neutralConceptIds: string[];
}

export function examTargetItemKey(item: Pick<ExamTargetItemRef, 'itemType' | 'itemId'>): string {
  return `${item.itemType}:${item.itemId}`;
}

function isUnit(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNullableUnit(value: number | null): boolean {
  return value === null || isUnit(value);
}

function isNullableFinite(value: number | null): boolean {
  return value === null || Number.isFinite(value);
}

function isValidItemScore(row: ItemExamTargetScoreRow): boolean {
  return (row.itemType === 'card' || row.itemType === 'question')
    && Boolean(row.itemId)
    && Boolean(row.sourceRotation)
    && SHA256.test(row.embeddingHash)
    && Boolean(row.domainCode)
    && (row.assignmentMethod === 'curated' || row.assignmentMethod === 'centroid')
    && isNullableFinite(row.rawSimilarity)
    && isNullableFinite(row.zSimilarity)
    && (row.runnerUpDomainCode === null || (
      Boolean(row.runnerUpDomainCode)
      && row.runnerUpDomainCode !== row.domainCode
    ))
    && isNullableFinite(row.assignmentMargin)
    && (row.assignmentMargin === null || row.assignmentMargin >= 0)
    && Boolean(row.weightProvenance)
    && isUnit(row.assignmentConfidence)
    && isUnit(row.geometryConfidence)
    && isNullableUnit(row.fitPercentile)
    && isUnit(row.effectiveDomainWeight)
    && isUnit(row.domainPriorityIndex)
    && isUnit(row.itemTargetIndex);
}

const CURRENT_ITEM_EMBEDDING_HASH_QUERY = String.raw`
/* exam-target:current-item-embedding-hashes */
SELECT
  'card'::text AS "itemType",
  e.card_id AS "itemId",
  encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex') AS "embeddingHash"
FROM card_embeddings e
WHERE e.card_id IN (
  SELECT jsonb_array_elements_text($1::jsonb)
)
UNION ALL
SELECT
  'question'::text AS "itemType",
  e.question_id AS "itemId",
  encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex') AS "embeddingHash"
FROM question_embeddings e
WHERE e.question_id IN (
  SELECT jsonb_array_elements_text($2::jsonb)
)
ORDER BY "itemType", "itemId"
`;

/**
 * Load explicit item rows for one immutable target snapshot. Home-rotation
 * legacy fields are deliberately absent: cross-source content receives a boost
 * only when this query returns a row for the current target.
 */
export async function loadItemExamTargetScores(
  input: LoadItemExamTargetScoresInput,
): Promise<LoadedItemExamTargetScores> {
  if (!input.targetSnapshotId || input.items.length === 0) {
    return { scores: new Map(), rejectedItemKeys: [], neutralItemKeys: [] };
  }

  const requested = new Map<string, ExamTargetItemRef>();
  const rejected = new Set<string>();
  for (const item of input.items) {
    const key = examTargetItemKey(item);
    const prior = requested.get(key);
    if (prior && prior.sourceRotation !== item.sourceRotation) {
      rejected.add(key);
      requested.delete(key);
      continue;
    }
    if (!prior && item.itemId && item.sourceRotation) requested.set(key, item);
  }

  const cardIds = [...requested.values()]
    .filter(item => item.itemType === 'card')
    .map(item => item.itemId);
  const questionIds = [...requested.values()]
    .filter(item => item.itemType === 'question')
    .map(item => item.itemId);

  let rows: ItemExamTargetScoreRow[];
  let currentHashRows: CurrentItemEmbeddingHashRow[];
  try {
    [rows, currentHashRows] = await Promise.all([
      input.client.itemExamTargetScore.findMany({
        where: {
          targetSnapshotId: input.targetSnapshotId,
          OR: [
            ...(cardIds.length > 0 ? [{ itemType: 'card', itemId: { in: cardIds } }] : []),
            ...(questionIds.length > 0 ? [{ itemType: 'question', itemId: { in: questionIds } }] : []),
          ],
        },
        select: {
          itemType: true,
          itemId: true,
          sourceRotation: true,
          embeddingHash: true,
          domainCode: true,
          assignmentMethod: true,
          rawSimilarity: true,
          zSimilarity: true,
          runnerUpDomainCode: true,
          assignmentMargin: true,
          assignmentConfidence: true,
          geometryConfidence: true,
          fitPercentile: true,
          effectiveDomainWeight: true,
          weightProvenance: true,
          domainPriorityIndex: true,
          itemTargetIndex: true,
        },
      }),
      input.client.$queryRawUnsafe(
        CURRENT_ITEM_EMBEDDING_HASH_QUERY,
        JSON.stringify(cardIds),
        JSON.stringify(questionIds),
      ) as Promise<CurrentItemEmbeddingHashRow[]>,
    ]);
  } catch {
    return {
      scores: new Map(),
      rejectedItemKeys: [...requested.keys()].sort(),
      neutralItemKeys: [],
    };
  }
  if (!Array.isArray(rows) || !Array.isArray(currentHashRows)) {
    return {
      scores: new Map(),
      rejectedItemKeys: [...requested.keys()].sort(),
      neutralItemKeys: [],
    };
  }

  const currentHashes = new Map<string, string>();
  let invalidCurrentHashResponse = false;
  for (const row of currentHashRows) {
    if (
      !row
      || (row.itemType !== 'card' && row.itemType !== 'question')
      || typeof row.itemId !== 'string'
      || !row.itemId
    ) {
      invalidCurrentHashResponse = true;
      continue;
    }
    const key = `${row.itemType}:${row.itemId}`;
    if (!requested.has(key)) {
      invalidCurrentHashResponse = true;
      continue;
    }
    if (!SHA256.test(row.embeddingHash) || currentHashes.has(key)) {
      rejected.add(key);
      currentHashes.delete(key);
      continue;
    }
    if (!rejected.has(key)) currentHashes.set(key, row.embeddingHash);
  }
  if (invalidCurrentHashResponse) {
    return {
      scores: new Map(),
      rejectedItemKeys: [...requested.keys()].sort(),
      neutralItemKeys: [],
    };
  }

  const scores = new Map<string, RuntimeItemExamTargetScore>();
  for (const row of rows) {
    const key = examTargetItemKey(row);
    const expected = requested.get(key);
    if (
      !expected
      || expected.sourceRotation !== row.sourceRotation
      || !isValidItemScore(row)
      || currentHashes.get(key) !== row.embeddingHash
      || scores.has(key)
    ) {
      scores.delete(key);
      rejected.add(key);
      continue;
    }
    scores.set(key, row);
  }
  for (const key of rejected) scores.delete(key);
  const neutralItemKeys = [...requested.keys()]
    .filter((key) => !scores.has(key) && !rejected.has(key))
    .sort();

  return {
    scores,
    rejectedItemKeys: [...rejected].sort(),
    neutralItemKeys,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseDomainMix(
  value: unknown,
  allowedDomainCodes: ReadonlySet<string>,
): Readonly<Record<string, number>> | null {
  if (!isPlainRecord(value)) return null;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return null;

  let total = 0;
  const normalized: Record<string, number> = {};
  for (const [domainCode, mass] of entries) {
    if (
      !allowedDomainCodes.has(domainCode)
      || typeof mass !== 'number'
      || !Number.isFinite(mass)
      || mass < 0
      || mass > 1
    ) {
      return null;
    }
    normalized[domainCode] = mass;
    total += mass;
  }
  if (Math.abs(total - 1) > 1e-9) return null;
  return Object.freeze(normalized);
}

function parseConceptScore(
  row: ConceptExamTargetScoreRow,
  allowedDomainCodes: ReadonlySet<string>,
): RuntimeConceptExamTargetScore | null {
  const domainMix = parseDomainMix(row.domainMix, allowedDomainCodes);
  if (
    !row.conceptId
    || !allowedDomainCodes.has(row.primaryDomainCode)
    || !domainMix
    || !(domainMix[row.primaryDomainCode] > 0)
    || (row.mappingMethod !== 'reviewed' && row.mappingMethod !== 'capped-linked-item-draft')
    || !isUnit(row.targetIndex)
    || !isUnit(row.mappingConfidence)
    || !SHA256.test(row.mappingHash)
    || !SHA256.test(row.artifactHash)
  ) {
    return null;
  }

  return Object.freeze({
    conceptId: row.conceptId,
    primaryDomainCode: row.primaryDomainCode,
    domainMix,
    mappingMethod: row.mappingMethod,
    targetIndex: row.targetIndex,
    mappingConfidence: row.mappingConfidence,
    mappingHash: row.mappingHash,
    artifactHash: row.artifactHash,
  });
}

/**
 * Load concept-to-domain mixtures for one immutable target. Invalid, duplicate,
 * unknown-domain, or unavailable mappings fail closed per concept; callers must
 * then retain exact legacy priority for that concept rather than guessing.
 */
export async function loadConceptExamTargetScores(
  input: LoadConceptExamTargetScoresInput,
): Promise<LoadedConceptExamTargetScores> {
  const requested = [...new Set(input.conceptIds.filter(Boolean))].sort();
  if (!input.targetSnapshotId || requested.length === 0) {
    return { scores: new Map(), rejectedConceptIds: [], neutralConceptIds: [] };
  }

  const allowedDomainCodes = new Set(input.allowedDomainCodes.filter(Boolean));
  if (allowedDomainCodes.size === 0) {
    return { scores: new Map(), rejectedConceptIds: requested, neutralConceptIds: [] };
  }

  let rows: ConceptExamTargetScoreRow[];
  try {
    rows = await input.client.conceptExamTargetScore.findMany({
      where: {
        targetSnapshotId: input.targetSnapshotId,
        conceptId: { in: requested },
      },
      select: {
        conceptId: true,
        primaryDomainCode: true,
        domainMix: true,
        mappingMethod: true,
        targetIndex: true,
        mappingConfidence: true,
        mappingHash: true,
        artifactHash: true,
      },
    });
  } catch {
    return { scores: new Map(), rejectedConceptIds: requested, neutralConceptIds: [] };
  }

  const requestedSet = new Set(requested);
  const scores = new Map<string, RuntimeConceptExamTargetScore>();
  const rejected = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!requestedSet.has(row.conceptId)) continue;
    const parsed = parseConceptScore(row, allowedDomainCodes);
    if (!parsed || scores.has(row.conceptId)) {
      scores.delete(row.conceptId);
      rejected.add(row.conceptId);
      continue;
    }
    if (!rejected.has(row.conceptId)) scores.set(row.conceptId, parsed);
  }
  for (const conceptId of rejected) scores.delete(conceptId);
  const neutralConceptIds = requested.filter(
    (conceptId) => !scores.has(conceptId) && !rejected.has(conceptId),
  );

  return {
    scores,
    rejectedConceptIds: [...rejected].sort(),
    neutralConceptIds,
  };
}

export function examTargetAssignmentBucket(
  assignmentKey: string,
  targetVersion: string,
): number {
  const digest = createHash('sha256')
    .update(assignmentKey, 'utf8')
    .update('\0', 'utf8')
    .update(targetVersion, 'utf8')
    .digest();
  return digest.readUInt32BE(0) % 10_000;
}

function offContext(
  rotation: ExamTargetRotation,
  assignmentBucket: number,
  loadFailureReason: ExamTargetLoadFailureReason,
  hardOff = false,
): RuntimeExamTargetContext {
  return {
    resolved: resolveExamTargetActivation({
      hardOff,
      requestedRotation: rotation,
      activation: null,
      snapshot: null,
      assignmentBucket,
    }),
    snapshot: null,
    activationRevision: null,
    schedulerVersion: null,
    policyDigest: null,
    loadFailureReason,
  };
}

function isActivationMode(value: string): value is ExamTargetActivationMode {
  return value === 'off' || value === 'shadow' || value === 'active';
}

function isSnapshotLifecycle(value: string): value is ExamTargetSnapshotLifecycle {
  return value === 'built'
    || value === 'validated'
    || value === 'active'
    || value === 'retired';
}

function isTargetBasis(value: string): value is ExamTargetBasis {
  return value === 'official' || value === 'hybrid' || value === 'proxy';
}

export async function loadRuntimeExamTarget(
  input: LoadRuntimeExamTargetInput,
): Promise<RuntimeExamTargetContext> {
  const hardOffBucket = 0;
  if (input.hardOff) {
    return offContext(input.rotation, hardOffBucket, null, true);
  }
  if (!input.assignmentKey) {
    return offContext(input.rotation, hardOffBucket, 'activation-row-invalid');
  }

  let activation: ExamTargetActivationRow | null;
  try {
    activation = await input.client.examTargetActivation.findUnique({
      where: { rotation: input.rotation },
      select: {
        mode: true,
        rolloutBasisPoints: true,
        activationRevision: true,
        schedulerVersion: true,
        policyFingerprint: true,
        targetSnapshot: {
          select: {
            id: true,
            targetId: true,
            revision: true,
            schemaVersion: true,
            rotation: true,
            status: true,
            targetBasis: true,
            privacyValidated: true,
            validFrom: true,
            scorerVersion: true,
            artifactHash: true,
            runtimeProjection: true,
          },
        },
      },
    });
  } catch {
    return offContext(input.rotation, hardOffBucket, 'activation-read-failed');
  }

  if (!activation) return offContext(input.rotation, hardOffBucket, null);
  if (
    !isActivationMode(activation.mode)
    || !Number.isInteger(activation.activationRevision)
    || activation.activationRevision <= 0
    || !activation.schedulerVersion
    || !SHA256.test(activation.policyFingerprint)
  ) {
    return offContext(input.rotation, hardOffBucket, 'activation-row-invalid');
  }

  const row = activation.targetSnapshot;
  if (!row) {
    return offContext(input.rotation, hardOffBucket, 'snapshot-metadata-mismatch');
  }

  let definition: ExamTargetDefinition;
  try {
    definition = parseExamTargetDefinition(row.runtimeProjection);
  } catch {
    return offContext(input.rotation, hardOffBucket, 'runtime-projection-invalid');
  }

  if (!isSnapshotLifecycle(row.status) || !isTargetBasis(row.targetBasis)) {
    return offContext(input.rotation, hardOffBucket, 'snapshot-metadata-mismatch');
  }
  const targetVersion = examTargetVersionId(definition);
  if (
    row.targetId !== definition.targetId
    || row.revision !== definition.revision
    || row.schemaVersion !== definition.schema
    || row.rotation !== input.rotation
    || row.rotation !== definition.rotation
    || row.targetBasis !== definition.targetBasis
    || row.scorerVersion !== definition.scoringPolicyVersion
  ) {
    return offContext(input.rotation, hardOffBucket, 'snapshot-metadata-mismatch');
  }
  if (
    !SHA256.test(row.artifactHash)
    || hashExamTargetArtifact(definition) !== row.artifactHash
  ) {
    return offContext(input.rotation, hardOffBucket, 'artifact-hash-mismatch');
  }
  const now = input.now ?? new Date();
  if (row.validFrom && row.validFrom.getTime() > now.getTime()) {
    return offContext(input.rotation, hardOffBucket, 'snapshot-not-yet-valid');
  }

  const assignmentBucket = examTargetAssignmentBucket(input.assignmentKey, targetVersion);
  const resolved = resolveExamTargetActivation({
    hardOff: false,
    requestedRotation: input.rotation,
    activation: {
      mode: activation.mode,
      rolloutBasisPoints: activation.rolloutBasisPoints,
      targetVersion,
    },
    snapshot: {
      rotation: input.rotation,
      targetVersion,
      lifecycle: row.status,
      privacyValidated: row.privacyValidated,
    },
    assignmentBucket,
  });

  // Pure activation gates may still fail closed (built/retired/privacy/rollout
  // validation). Preserve the snapshot only for a usable shadow/active context.
  if (resolved.effectiveMode === 'off') {
    return {
      resolved,
      snapshot: null,
      activationRevision: activation.activationRevision,
      schedulerVersion: activation.schedulerVersion,
      policyDigest: activation.policyFingerprint,
      loadFailureReason: null,
    };
  }

  return {
    resolved,
    snapshot: {
      id: row.id,
      targetId: row.targetId,
      revision: row.revision,
      targetVersion,
      rotation: input.rotation,
      lifecycle: row.status,
      privacyValidated: true,
      targetBasis: row.targetBasis,
      scorerVersion: row.scorerVersion,
      artifactHash: row.artifactHash,
      definition,
    },
    activationRevision: activation.activationRevision,
    schedulerVersion: activation.schedulerVersion,
    policyDigest: activation.policyFingerprint,
    loadFailureReason: null,
  };
}
