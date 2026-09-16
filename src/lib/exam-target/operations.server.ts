import { hashExamTargetArtifact } from './artifact';
import { examTargetVersionId, parseExamTargetDefinition } from './contract';
import { USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT } from '../curriculum/usyd-md3-2026-topic-aliases';
import { compiledRuntimeCurriculumDispositionPolicy } from '../curriculum/usyd-md3-2026-item-dispositions';
import {
  parseExamTargetDecisionReplaySnapshot,
  replayExamTargetDecision,
} from './decision-set';
import { getExamTargetDefinition } from './registry';
import { USYD_MD3_2026 } from '../curriculum/usyd-md3-2026';
import type {
  ExamTargetBasis,
  ExamTargetDefinition,
  ExamTargetRotation,
} from './types';

const REACHABILITY_THRESHOLD = 0.95;
const CURRICULUM_MAPPING_THRESHOLD = 0.95;
const MAX_MIN_APPLIED_QUESTION_COUNT = 20;
const SHA256 = /^[a-f0-9]{64}$/;

interface OperationalSnapshotRow {
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
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  sourceManifestHash: string;
  artifactHash: string;
  itemRowsHash: string;
  conceptRowsHash: string;
  manifestHash: string;
  buildManifest: unknown;
  runtimeProjection: unknown;
}

interface OperationalItemScoreHashRow {
  itemType: 'card' | 'question';
  itemId: string;
  sourceRotation: string;
  embeddingHash: string;
  domainCode: string;
  assignmentMethod: 'curated' | 'centroid';
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

interface OperationalConceptScoreHashRow {
  conceptId: string;
  primaryDomainCode: string;
  domainMix: unknown;
  mappingMethod: string;
  targetIndex: number;
  mappingConfidence: number;
  mappingHash: string;
  artifactHash: string;
}

type ReachabilityItemType = 'card' | 'question' | 'concept';

interface ReachabilityAggregateRow {
  itemType: ReachabilityItemType;
  eligibleItemCount: bigint | number;
  reachableItemCount: bigint | number;
  nativeEligibleItemCount?: bigint | number;
  nativeReachableItemCount?: bigint | number;
  crossSourceEligibleItemCount?: bigint | number;
  crossSourceReachableItemCount?: bigint | number;
  curriculumEligibleItemCount?: bigint | number;
  curriculumMappedItemCount?: bigint | number;
  curriculumReviewedNeutralItemCount?: bigint | number;
  appliedItemCount?: bigint | number;
  staleScoreCount: bigint | number;
  orphanScoreCount: bigint | number;
  domainCodes: string[] | null;
}

interface SchemaDependencyRow {
  dependency: string;
}

export interface ExamTargetSchemaReadinessReport {
  ready: boolean;
  missingDependencies: readonly string[];
}

export interface ExamTargetOperationsReadClient {
  examTargetSnapshot: {
    findUnique(args: unknown): Promise<OperationalSnapshotRow | null>;
  };
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface ExactExamTargetOperationInput {
  client: ExamTargetOperationsReadClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
}

export interface ExamTargetOperationsMutationClient
  extends Omit<ExamTargetOperationsReadClient, 'examTargetSnapshot'> {
  examTargetSnapshot: ExamTargetOperationsReadClient['examTargetSnapshot'] & {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface ExamTargetActivationMutationClient
  extends ExamTargetOperationsReadClient {
  examTargetActivation: {
    upsert(args: unknown): Promise<{ activationRevision: number }>;
  };
}

interface OperationalActivationIdentity {
  id: string;
  targetSnapshotId: string;
  mode: string;
  activationRevision: number;
}

export interface ExamTargetRollbackClient extends ExamTargetOperationsReadClient {
  examTargetActivation: {
    findUnique(args: unknown): Promise<OperationalActivationIdentity | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

interface ExamTargetRetirementTransaction {
  examTargetActivation: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  examTargetSnapshot: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface ExamTargetRetirementClient extends ExamTargetOperationsReadClient {
  $transaction(
    work: (transaction: ExamTargetRetirementTransaction) => Promise<unknown>,
  ): Promise<unknown>;
}

interface OperationalShadowDecisionRow {
  sessionId: string;
  decisionPath: string;
  mode: string;
  assignment: string;
  targetEligibleCount: number;
  pairedTargetLift: number | null;
  controlAllocationError: number | null;
  targetAllocationError: number | null;
  targetComputeMs: number | null;
  fallbackReason: string | null;
  replaySnapshot: unknown | null;
  masteryTelemetry?: unknown | null;
}

export interface ExamTargetShadowAuditClient extends ExamTargetOperationsReadClient {
  schedulerDecisionSet: {
    findMany(args: unknown): Promise<OperationalShadowDecisionRow[]>;
  };
}

export interface ExamTargetItemReachability {
  eligibleItemCount: number;
  reachableItemCount: number;
  /** Exact current target-relative score rows. */
  mappedItemCount: number;
  /** Eligible candidates served neutrally because no current score row exists. */
  neutralCoverageDebtCount: number;
  nativeEligibleItemCount: number;
  nativeReachableItemCount: number;
  crossSourceEligibleItemCount: number;
  crossSourceReachableItemCount: number;
  curriculumEligibleItemCount: number;
  curriculumMappedItemCount: number;
  curriculumReviewedNeutralItemCount: number;
  curriculumMappingCoverage: number;
  /** Distinct canonical topics represented by prerequisite-backed applied questions. */
  appliedItemCount: number;
  staleScoreCount: number;
  orphanScoreCount: number;
  reachability: number;
  nativeReachability: number;
  crossSourceReachability: number | null;
  domainCodes: readonly string[];
  passed: boolean;
}

export interface ExamTargetCurriculumItemReadiness {
  eligibleItemCount: number;
  mappedItemCount: number;
  reviewedNeutralItemCount: number;
  coverage: number;
  passed: boolean;
}

export interface ExamTargetCurriculumReadinessReport {
  schema: 'md3.exam-target-curriculum-readiness/v1';
  threshold: 0.95;
  minimumAppliedQuestionCount: number;
  targetCardLedgerAvailable: boolean;
  card: ExamTargetCurriculumItemReadiness;
  question: ExamTargetCurriculumItemReadiness;
  /** Distinct canonical topics represented by prerequisite-backed applied questions. */
  appliedQuestionCount: number;
  issues: readonly string[];
  releaseReady: boolean;
}

export interface ExamTargetReachabilityReport {
  schema: 'md3.exam-target-reachability-report/v1';
  rotation: ExamTargetRotation;
  targetVersion: string;
  snapshotId: string | null;
  snapshotStatus: string | null;
  schemaReadiness: ExamTargetSchemaReadinessReport;
  artifactValid: boolean;
  privacyValidated: boolean;
  threshold: 0.95;
  curriculumReadiness: ExamTargetCurriculumReadinessReport;
  items: {
    card: ExamTargetItemReachability;
    question: ExamTargetItemReachability;
    concept: ExamTargetItemReachability;
  };
  issues: readonly string[];
  passed: boolean;
}

export interface AuditExamTargetArtifactInput extends ExactExamTargetOperationInput {
  now?: Date;
}

export interface ExamTargetArtifactAuditReport {
  schema: 'md3.exam-target-artifact-report/v1';
  rotation: ExamTargetRotation;
  targetVersion: string;
  snapshotId: string | null;
  snapshotStatus: string | null;
  schemaReadiness: ExamTargetSchemaReadinessReport;
  artifactValid: boolean;
  rowSetValid: boolean;
  privacyValidated: boolean;
  issues: readonly string[];
  passed: boolean;
}

const REACHABILITY_QUERY = String.raw`
/* exam-target:reachability */
WITH reviewed_topic_aliases AS (
  SELECT alias_slug, canonical_topic
  FROM unnest($3::text[], $4::text[])
    AS reviewed(alias_slug, canonical_topic)
), reviewed_neutral_rules AS (
  SELECT inventory, match_kind, value
  FROM jsonb_to_recordset(($5::jsonb)->'neutral_rules')
    AS rule(inventory text, match_kind text, value text)
), reviewed_item_topic_overrides AS (
  SELECT override.inventory, override.item_id,
    canonical_topic.value AS canonical_topic
  FROM jsonb_to_recordset(($5::jsonb)->'item_topic_overrides')
    AS override(inventory text, item_id text, canonical_topic_ids jsonb)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    override.canonical_topic_ids
  ) AS canonical_topic(value)
), eligible_cards AS (
  SELECT
    c.id,
    c.rotation AS source_rotation,
    (c.rotation <> $2) AS is_cross_source,
    CASE WHEN e.card_id IS NULL THEN NULL
      ELSE encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex')
    END AS embedding_hash,
    ARRAY(
      SELECT DISTINCT candidate.canonical_topic
      FROM (
        SELECT reviewed.canonical_topic
        FROM unnest(c.topics) AS source_topic(value)
        JOIN reviewed_topic_aliases reviewed
          ON reviewed.alias_slug = trim(both '-' from regexp_replace(
            lower(replace(btrim(source_topic.value), '&', ' and ')),
            '[^a-z0-9]+', '-', 'g'
          ))
        UNION ALL
        SELECT override.canonical_topic
        FROM reviewed_item_topic_overrides override
        WHERE override.inventory = 'card' AND override.item_id = c.id
      ) candidate
      ORDER BY candidate.canonical_topic
    )::text[] AS curriculum_topics,
    EXISTS (
      SELECT 1
      FROM reviewed_neutral_rules neutral
      WHERE neutral.inventory = 'card'
        AND neutral.match_kind = 'id-exact'
        AND c.id = neutral.value
    ) AS curriculum_reviewed_neutral
  FROM "Card" c
  LEFT JOIN card_embeddings e ON e.card_id = c.id
  WHERE (c.rotation = $2 OR $2 = ANY(c."moduleNodes"))
    AND c."deletedAt" IS NULL
    AND c."shelvedAt" IS NULL
    AND c."ownerUserId" IS NULL
), eligible_questions AS (
  SELECT
    q.id,
    q.rotation AS source_rotation,
    (q.rotation <> $2) AS is_cross_source,
    CASE WHEN e.question_id IS NULL THEN NULL
      ELSE encode(digest(halfvec_send(e.embedding), 'sha256'), 'hex')
    END AS embedding_hash,
    ARRAY(
      SELECT DISTINCT candidate.canonical_topic
      FROM (
        SELECT reviewed.canonical_topic
        FROM unnest(q.topics) AS source_topic(value)
        JOIN reviewed_topic_aliases reviewed
          ON reviewed.alias_slug = trim(both '-' from regexp_replace(
            lower(replace(btrim(source_topic.value), '&', ' and ')),
            '[^a-z0-9]+', '-', 'g'
          ))
        UNION ALL
        SELECT override.canonical_topic
        FROM reviewed_item_topic_overrides override
        WHERE override.inventory = 'question' AND override.item_id = q.id
      ) candidate
      ORDER BY candidate.canonical_topic
    )::text[] AS curriculum_topics,
    EXISTS (
      SELECT 1
      FROM reviewed_neutral_rules neutral
      WHERE neutral.inventory = 'question'
        AND neutral.match_kind = 'id-exact'
        AND q.id = neutral.value
    ) AS curriculum_reviewed_neutral,
    (
      lower(btrim(q."questionType")) IN (
        'mechanism', 'management', 'next-step', 'diagnosis', 'image-interpretation'
      )
      OR lower(btrim(COALESCE(q.format, ''))) IN (
        'mechanism', 'trap', 'comparison', 'interpretation'
      )
    ) AS applied
  FROM "Question" q
  LEFT JOIN question_embeddings e ON e.question_id = q.id
  WHERE (q.rotation = $2 OR $2 = ANY(q."moduleNodes"))
    AND q.excluded = false
    AND q."contentState" NOT IN ('shelved', 'retired')
), eligible_concepts AS (
  SELECT c.id
  FROM "Concept" c
  WHERE c.rotation = $2
  UNION
  SELECT c."conceptId" AS id
  FROM "Card" c
  JOIN eligible_cards e ON e.id = c.id
  WHERE c."conceptId" IS NOT NULL
  UNION
  SELECT qc."conceptId" AS id
  FROM "QuestionConcept" qc
  JOIN eligible_questions e ON e.id = qc."questionId"
), card_scores AS (
  SELECT s."itemId" AS id, s."sourceRotation" AS source_rotation,
    s."embeddingHash" AS embedding_hash,
    s."domainCode" AS domain_code
  FROM "ItemExamTargetScore" s
  WHERE s."targetSnapshotId" = $1 AND s."itemType"::text = 'card'
), question_scores AS (
  SELECT s."itemId" AS id, s."sourceRotation" AS source_rotation,
    s."embeddingHash" AS embedding_hash,
    s."domainCode" AS domain_code
  FROM "ItemExamTargetScore" s
  WHERE s."targetSnapshotId" = $1 AND s."itemType"::text = 'question'
), concept_scores AS (
  SELECT s."conceptId" AS id, s."primaryDomainCode" AS domain_code
  FROM "ConceptExamTargetScore" s
  WHERE s."targetSnapshotId" = $1
)
SELECT
  'card'::text AS "itemType",
  (SELECT count(*) FROM eligible_cards)::bigint AS "eligibleItemCount",
  (SELECT count(*) FROM eligible_cards e JOIN card_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash)::bigint
    AS "reachableItemCount",
  (SELECT count(*) FROM eligible_cards WHERE NOT is_cross_source)::bigint
    AS "nativeEligibleItemCount",
  (SELECT count(*) FROM eligible_cards e JOIN card_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash
    WHERE NOT e.is_cross_source)::bigint AS "nativeReachableItemCount",
  (SELECT count(*) FROM eligible_cards WHERE is_cross_source)::bigint
    AS "crossSourceEligibleItemCount",
  (SELECT count(*) FROM eligible_cards e JOIN card_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash
    WHERE e.is_cross_source)::bigint AS "crossSourceReachableItemCount",
  (SELECT count(*) FROM card_scores s JOIN eligible_cards e ON e.id = s.id
    WHERE e.source_rotation IS DISTINCT FROM s.source_rotation
      OR e.embedding_hash IS DISTINCT FROM s.embedding_hash)::bigint
    AS "staleScoreCount",
  (SELECT count(*) FROM card_scores s LEFT JOIN eligible_cards e ON e.id = s.id
    WHERE e.id IS NULL)::bigint AS "orphanScoreCount",
  (SELECT count(*) FROM eligible_cards WHERE NOT is_cross_source)::bigint
    AS "curriculumEligibleItemCount",
  (SELECT count(*) FROM eligible_cards
    WHERE NOT is_cross_source AND cardinality(curriculum_topics) > 0)::bigint
    AS "curriculumMappedItemCount",
  (SELECT count(*) FROM eligible_cards
    WHERE NOT is_cross_source
      AND cardinality(curriculum_topics) = 0
      AND curriculum_reviewed_neutral)::bigint
    AS "curriculumReviewedNeutralItemCount",
  0::bigint AS "appliedItemCount",
  COALESCE((SELECT array_agg(DISTINCT domain_code ORDER BY domain_code)
    FROM card_scores), ARRAY[]::text[]) AS "domainCodes"
UNION ALL
SELECT
  'question'::text,
  (SELECT count(*) FROM eligible_questions)::bigint,
  (SELECT count(*) FROM eligible_questions e JOIN question_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash)::bigint,
  (SELECT count(*) FROM eligible_questions WHERE NOT is_cross_source)::bigint,
  (SELECT count(*) FROM eligible_questions e JOIN question_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash
    WHERE NOT e.is_cross_source)::bigint,
  (SELECT count(*) FROM eligible_questions WHERE is_cross_source)::bigint,
  (SELECT count(*) FROM eligible_questions e JOIN question_scores s
    ON s.id = e.id AND s.source_rotation = e.source_rotation
      AND s.embedding_hash = e.embedding_hash
    WHERE e.is_cross_source)::bigint,
  (SELECT count(*) FROM question_scores s JOIN eligible_questions e ON e.id = s.id
    WHERE e.source_rotation IS DISTINCT FROM s.source_rotation
      OR e.embedding_hash IS DISTINCT FROM s.embedding_hash)::bigint,
  (SELECT count(*) FROM question_scores s LEFT JOIN eligible_questions e ON e.id = s.id
    WHERE e.id IS NULL)::bigint,
  (SELECT count(*) FROM eligible_questions WHERE NOT is_cross_source)::bigint,
  (SELECT count(*) FROM eligible_questions
    WHERE NOT is_cross_source AND cardinality(curriculum_topics) > 0)::bigint,
  (SELECT count(*) FROM eligible_questions
    WHERE NOT is_cross_source
      AND cardinality(curriculum_topics) = 0
      AND curriculum_reviewed_neutral)::bigint,
  (SELECT count(DISTINCT applied_topic.value)
    FROM eligible_questions q
    CROSS JOIN LATERAL unnest(q.curriculum_topics) AS applied_topic(value)
    WHERE NOT q.is_cross_source
      AND q.applied
      AND cardinality(q.curriculum_topics) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(q.curriculum_topics) AS mapped_question_topic(value)
        WHERE NOT EXISTS (
          SELECT 1
          FROM eligible_cards c
          WHERE NOT c.is_cross_source
            AND mapped_question_topic.value = ANY(c.curriculum_topics)
        )
      ))::bigint,
  COALESCE((SELECT array_agg(DISTINCT domain_code ORDER BY domain_code)
    FROM question_scores), ARRAY[]::text[])
UNION ALL
SELECT
  'concept'::text,
  (SELECT count(*) FROM eligible_concepts)::bigint,
  (SELECT count(*) FROM eligible_concepts e JOIN concept_scores s
    ON s.id = e.id)::bigint,
  (SELECT count(*) FROM eligible_concepts)::bigint,
  (SELECT count(*) FROM eligible_concepts e JOIN concept_scores s
    ON s.id = e.id)::bigint,
  0::bigint,
  0::bigint,
  0::bigint,
  (SELECT count(*) FROM concept_scores s LEFT JOIN eligible_concepts e ON e.id = s.id
    WHERE e.id IS NULL)::bigint,
  0::bigint,
  0::bigint,
  0::bigint,
  0::bigint,
  COALESCE((SELECT array_agg(DISTINCT domain_code ORDER BY domain_code)
    FROM concept_scores), ARRAY[]::text[])
ORDER BY "itemType"
`;

const SCHEMA_READINESS_QUERY = String.raw`
/* exam-target:schema-readiness */
WITH required_migrations(migration_name) AS (
  VALUES
    ('20260808170000_anki_portability_foundation'),
    ('20260808210000_anki_bridge_foundation'),
    ('20260808220000_exam_target_scheduler_v2_foundation'),
    ('20260808220500_exam_target_scheduler_v2_serve_indexes'),
    ('20260808222000_exam_target_attempt_ledger')
), missing_migrations AS (
  SELECT 'migration:' || required.migration_name AS dependency
  FROM required_migrations required
  WHERE NOT EXISTS (
    SELECT 1
    FROM "_prisma_migrations" applied
    WHERE applied.migration_name = required.migration_name
      AND applied.finished_at IS NOT NULL
      AND applied.rolled_back_at IS NULL
  )
), required_tables(table_name) AS (
  VALUES
    ('AnkiCollection'),
    ('AnkiBridgePairing'),
    ('ExamTargetSnapshot'),
    ('ItemExamTargetScore'),
    ('ConceptExamTargetScore'),
    ('ExamTargetActivation'),
    ('ExamTargetDecisionAttempt'),
    ('SchedulerDecisionSet')
), missing_tables AS (
  SELECT 'table:' || required.table_name AS dependency
  FROM required_tables required
  WHERE to_regclass(format('%I.%I', current_schema(), required.table_name)) IS NULL
), required_columns(table_name, column_name) AS (
  VALUES
    ('Card', 'ownerUserId'),
    ('Card', 'studyDeckId'),
    ('ExamTargetSnapshot', 'itemRowsHash'),
    ('ExamTargetSnapshot', 'conceptRowsHash'),
    ('ExamTargetSnapshot', 'manifestHash'),
    ('ExamTargetSnapshot', 'buildManifest'),
    ('SchedulerDecisionSet', 'replaySnapshot'),
    ('SchedulerDecisionSet', 'masteryTelemetry'),
    ('SchedulerDecisionSet', 'attemptId'),
    ('ServeDecision', 'examTargetSnapshotId')
), missing_columns AS (
  SELECT 'column:' || required.table_name || '.' || required.column_name AS dependency
  FROM required_columns required
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns existing
    WHERE existing.table_schema = current_schema()
      AND existing.table_name = required.table_name
      AND existing.column_name = required.column_name
  )
)
SELECT dependency FROM missing_migrations
UNION ALL
SELECT dependency FROM missing_tables
UNION ALL
SELECT dependency FROM missing_columns
ORDER BY dependency
`;

const ITEM_ROW_HASH_QUERY = String.raw`
/* exam-target:item-row-hash-inputs */
SELECT
  s."itemType"::text AS "itemType",
  s."itemId",
  s."sourceRotation",
  s."embeddingHash",
  s."domainCode",
  s."assignmentMethod"::text AS "assignmentMethod",
  s."rawSimilarity",
  s."zSimilarity",
  s."runnerUpDomainCode",
  s."assignmentMargin",
  s."assignmentConfidence",
  s."geometryConfidence",
  s."fitPercentile",
  s."effectiveDomainWeight",
  s."weightProvenance",
  s."domainPriorityIndex",
  s."itemTargetIndex"
FROM "ItemExamTargetScore" s
WHERE s."targetSnapshotId" = $1
ORDER BY s."itemType"::text, s."itemId"
`;

const CONCEPT_ROW_HASH_QUERY = String.raw`
/* exam-target:concept-row-hash-inputs */
SELECT
  s."conceptId",
  s."primaryDomainCode",
  s."domainMix",
  s."mappingMethod",
  s."targetIndex",
  s."mappingConfidence",
  s."mappingHash",
  s."artifactHash"
FROM "ConceptExamTargetScore" s
WHERE s."targetSnapshotId" = $1
ORDER BY s."conceptId"
`;

function exactReviewedDefinition(
  rotation: ExamTargetRotation,
  targetVersion: string,
): ExamTargetDefinition {
  const definition = getExamTargetDefinition(rotation);
  if (!definition || examTargetVersionId(definition) !== targetVersion) {
    throw new Error(
      `target version must exactly match the reviewed ${rotation} registry entry`,
    );
  }
  return definition;
}

function normalizedCurriculumTopic(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('en-AU')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function reviewedCurriculumTopicVocabulary(rotation: ExamTargetRotation): {
  canonicalTopicCount: number;
  acceptedTopicSlugs: string[];
  acceptedCanonicalTopicSlugs: string[];
} {
  const block = USYD_MD3_2026.blocks.find(candidate => candidate.id === rotation);
  if (!block || block.topics.length === 0) {
    throw new Error(`canonical curriculum topics missing for ${rotation}`);
  }
  const canonicalByAlias = new Map<string, string>();
  const addAlias = (rawAlias: string, rawCanonical: string) => {
    const alias = normalizedCurriculumTopic(rawAlias);
    const canonical = normalizedCurriculumTopic(rawCanonical);
    const existing = canonicalByAlias.get(alias);
    if (existing && existing !== canonical) {
      throw new Error(`ambiguous reviewed curriculum alias ${rotation}:${alias}`);
    }
    canonicalByAlias.set(alias, canonical);
  };
  block.topics.forEach(topic => addAlias(topic, topic));
  USYD_MD3_2026_TOPIC_ALIAS_ARTIFACT.groups[rotation].forEach(group => {
    [group.canonicalTopic, ...group.aliases].forEach(alias => {
      addAlias(alias, group.canonicalTopic);
    });
  });
  const acceptedAliases = [...canonicalByAlias.keys()].sort();
  return {
    canonicalTopicCount: block.topics.length,
    acceptedTopicSlugs: acceptedAliases,
    acceptedCanonicalTopicSlugs: acceptedAliases.map(
      alias => canonicalByAlias.get(alias)!,
    ),
  };
}

function safeCount(value: bigint | number): number {
  const count = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('exam-target audit returned an invalid count');
  }
  return count;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyReachability(): ExamTargetItemReachability {
  return {
    eligibleItemCount: 0,
    reachableItemCount: 0,
    mappedItemCount: 0,
    neutralCoverageDebtCount: 0,
    nativeEligibleItemCount: 0,
    nativeReachableItemCount: 0,
    crossSourceEligibleItemCount: 0,
    crossSourceReachableItemCount: 0,
    curriculumEligibleItemCount: 0,
    curriculumMappedItemCount: 0,
    curriculumReviewedNeutralItemCount: 0,
    curriculumMappingCoverage: 0,
    appliedItemCount: 0,
    staleScoreCount: 0,
    orphanScoreCount: 0,
    reachability: 0,
    nativeReachability: 0,
    crossSourceReachability: null,
    domainCodes: [],
    passed: false,
  };
}

function curriculumItemReadiness(
  item: ExamTargetItemReachability,
): ExamTargetCurriculumItemReadiness {
  const reviewedNeutralItemCount = item.curriculumReviewedNeutralItemCount;
  const covered = item.curriculumMappedItemCount + reviewedNeutralItemCount;
  const coverage = item.curriculumEligibleItemCount === 0
    ? 0
    : covered / item.curriculumEligibleItemCount;
  return {
    eligibleItemCount: item.curriculumEligibleItemCount,
    mappedItemCount: item.curriculumMappedItemCount,
    reviewedNeutralItemCount,
    coverage,
    passed: item.curriculumEligibleItemCount > 0
      && coverage >= CURRICULUM_MAPPING_THRESHOLD,
  };
}

function curriculumReadiness(
  items: ExamTargetReachabilityReport['items'],
  targetCardLedgerAvailable: boolean,
  canonicalTopicCount: number,
): ExamTargetCurriculumReadinessReport {
  const card = curriculumItemReadiness(items.card);
  const question = curriculumItemReadiness(items.question);
  const appliedQuestionCount = items.question.appliedItemCount;
  const minimumAppliedQuestionCount = Math.min(
    MAX_MIN_APPLIED_QUESTION_COUNT,
    canonicalTopicCount,
  );
  const issues: string[] = [];
  if (!targetCardLedgerAvailable) issues.push('target_card_ledger_unavailable');
  if (!card.passed) issues.push('card_curriculum_mapping_below_threshold');
  if (!question.passed) issues.push('question_curriculum_mapping_below_threshold');
  if (appliedQuestionCount < minimumAppliedQuestionCount) {
    issues.push('applied_question_inventory_below_minimum');
  }
  return {
    schema: 'md3.exam-target-curriculum-readiness/v1',
    threshold: CURRICULUM_MAPPING_THRESHOLD,
    minimumAppliedQuestionCount,
    targetCardLedgerAvailable,
    card,
    question,
    appliedQuestionCount,
    issues,
    releaseReady: issues.length === 0,
  };
}

export async function auditExamTargetSchemaReadiness(
  client: Pick<ExamTargetOperationsReadClient, '$queryRawUnsafe'>,
): Promise<ExamTargetSchemaReadinessReport> {
  try {
    const rawRows = await client.$queryRawUnsafe(SCHEMA_READINESS_QUERY);
    if (!Array.isArray(rawRows)) {
      return {
        ready: false,
        missingDependencies: ['preflight:schema-query-invalid'],
      };
    }
    const missingDependencies = rawRows.map((value): string => {
      const dependency = (value as Partial<SchemaDependencyRow>)?.dependency;
      if (
        typeof dependency !== 'string'
        || dependency.length === 0
        || dependency.length > 191
        || !/^[A-Za-z0-9_.:-]+$/.test(dependency)
      ) {
        throw new Error('invalid schema readiness dependency');
      }
      return dependency;
    });
    const unique = [...new Set(missingDependencies)].sort();
    if (unique.length !== missingDependencies.length) {
      return {
        ready: false,
        missingDependencies: ['preflight:schema-query-invalid'],
      };
    }
    return { ready: unique.length === 0, missingDependencies: unique };
  } catch {
    return {
      ready: false,
      missingDependencies: ['preflight:schema-query-failed'],
    };
  }
}

function validateSnapshotArtifact(
  row: OperationalSnapshotRow,
  reviewed: ExamTargetDefinition,
): boolean {
  let projection: ExamTargetDefinition;
  try {
    projection = parseExamTargetDefinition(row.runtimeProjection);
  } catch {
    return false;
  }
  return row.targetId === reviewed.targetId
    && row.revision === reviewed.revision
    && row.schemaVersion === reviewed.schema
    && row.rotation === reviewed.rotation
    && row.targetBasis === reviewed.targetBasis
    && row.scorerVersion === reviewed.scoringPolicyVersion
    && row.embeddingModel === reviewed.embeddingModel
    && row.embeddingDimensions === reviewed.embeddingDimensions
    && hashExamTargetArtifact(projection) === hashExamTargetArtifact(reviewed)
    && row.artifactHash === hashExamTargetArtifact(reviewed);
}

async function loadExactSnapshot(
  input: ExactExamTargetOperationInput,
  definition: ExamTargetDefinition,
): Promise<OperationalSnapshotRow | null> {
  return input.client.examTargetSnapshot.findUnique({
    where: {
      targetId_revision: {
        targetId: definition.targetId,
        revision: definition.revision,
      },
    },
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
      embeddingModel: true,
      embeddingDimensions: true,
      sourceManifestHash: true,
      artifactHash: true,
      itemRowsHash: true,
      conceptRowsHash: true,
      manifestHash: true,
      buildManifest: true,
      runtimeProjection: true,
    },
  });
}

function parseReachabilityRow(
  row: ReachabilityAggregateRow,
  allowedDomains: ReadonlySet<string>,
): ExamTargetItemReachability {
  const eligibleItemCount = safeCount(row.eligibleItemCount);
  const reachableItemCount = safeCount(row.reachableItemCount);
  const staleScoreCount = safeCount(row.staleScoreCount);
  const orphanScoreCount = safeCount(row.orphanScoreCount);
  const nativeEligibleItemCount = row.nativeEligibleItemCount == null
    ? eligibleItemCount
    : safeCount(row.nativeEligibleItemCount);
  const nativeReachableItemCount = row.nativeReachableItemCount == null
    ? reachableItemCount
    : safeCount(row.nativeReachableItemCount);
  const crossSourceEligibleItemCount = row.crossSourceEligibleItemCount == null
    ? 0
    : safeCount(row.crossSourceEligibleItemCount);
  const crossSourceReachableItemCount = row.crossSourceReachableItemCount == null
    ? 0
    : safeCount(row.crossSourceReachableItemCount);
  const curriculumEligibleItemCount = row.curriculumEligibleItemCount == null
    ? nativeEligibleItemCount
    : safeCount(row.curriculumEligibleItemCount);
  const curriculumMappedItemCount = row.curriculumMappedItemCount == null
    ? 0
    : safeCount(row.curriculumMappedItemCount);
  const curriculumReviewedNeutralItemCount = row.curriculumReviewedNeutralItemCount == null
    ? 0
    : safeCount(row.curriculumReviewedNeutralItemCount);
  const appliedItemCount = row.appliedItemCount == null
    ? 0
    : safeCount(row.appliedItemCount);
  if (reachableItemCount > eligibleItemCount) {
    throw new Error('exam-target audit reachable count exceeds eligible count');
  }
  if (curriculumMappedItemCount + curriculumReviewedNeutralItemCount
    > curriculumEligibleItemCount) {
    throw new Error('exam-target audit curriculum count exceeds eligible count');
  }
  const domainCodes = [...new Set(row.domainCodes ?? [])].sort();
  const reachability = eligibleItemCount === 0
    ? 0
    : reachableItemCount / eligibleItemCount;
  const nativeReachability = nativeEligibleItemCount === 0
    ? 0
    : nativeReachableItemCount / nativeEligibleItemCount;
  const crossSourceReachability = crossSourceEligibleItemCount === 0
    ? null
    : crossSourceReachableItemCount / crossSourceEligibleItemCount;
  const curriculumMappingCoverage = curriculumEligibleItemCount === 0
    ? 0
    : (curriculumMappedItemCount + curriculumReviewedNeutralItemCount)
      / curriculumEligibleItemCount;
  const passed = eligibleItemCount > 0
    && reachableItemCount > 0
    && reachability >= REACHABILITY_THRESHOLD
    && nativeEligibleItemCount > 0
    && nativeReachability >= REACHABILITY_THRESHOLD
    && staleScoreCount === 0
    && orphanScoreCount === 0
    && (crossSourceReachability == null
      || crossSourceReachability >= REACHABILITY_THRESHOLD)
    && domainCodes.every(code => allowedDomains.has(code));
  return {
    eligibleItemCount,
    reachableItemCount,
    mappedItemCount: reachableItemCount,
    neutralCoverageDebtCount: eligibleItemCount - reachableItemCount,
    nativeEligibleItemCount,
    nativeReachableItemCount,
    crossSourceEligibleItemCount,
    crossSourceReachableItemCount,
    curriculumEligibleItemCount,
    curriculumMappedItemCount,
    curriculumReviewedNeutralItemCount,
    curriculumMappingCoverage,
    appliedItemCount,
    staleScoreCount,
    orphanScoreCount,
    reachability,
    nativeReachability,
    crossSourceReachability,
    domainCodes,
    passed,
  };
}

export async function auditExamTargetArtifact(
  input: AuditExamTargetArtifactInput,
): Promise<ExamTargetArtifactAuditReport> {
  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const schemaReadiness = await auditExamTargetSchemaReadiness(input.client);
  if (!schemaReadiness.ready) {
    return {
      schema: 'md3.exam-target-artifact-report/v1',
      rotation: input.rotation,
      targetVersion: input.targetVersion,
      snapshotId: null,
      snapshotStatus: null,
      schemaReadiness,
      artifactValid: false,
      rowSetValid: false,
      privacyValidated: false,
      issues: ['schema_not_ready'],
      passed: false,
    };
  }
  const snapshot = await loadExactSnapshot(input, definition);
  if (!snapshot) {
    return {
      schema: 'md3.exam-target-artifact-report/v1',
      rotation: input.rotation,
      targetVersion: input.targetVersion,
      snapshotId: null,
      snapshotStatus: null,
      schemaReadiness,
      artifactValid: false,
      rowSetValid: false,
      privacyValidated: false,
      issues: ['snapshot_missing'],
      passed: false,
    };
  }
  const artifactValid = validateSnapshotArtifact(snapshot, definition);
  const issues: string[] = [];
  if (!artifactValid) issues.push('artifact_invalid');
  if (!['built', 'validated', 'active', 'retired'].includes(snapshot.status)) {
    issues.push('snapshot_status_invalid');
  } else if (snapshot.status === 'retired') {
    issues.push('snapshot_retired');
  }
  if (
    snapshot.validFrom != null
    && snapshot.validFrom.getTime() > (input.now ?? new Date()).getTime()
  ) issues.push('snapshot_not_yet_valid');

  let rowSetValid = false;
  if (artifactValid) {
    const [rawItemRows, rawConceptRowsValue] = await Promise.all([
      input.client.$queryRawUnsafe(
        ITEM_ROW_HASH_QUERY,
        snapshot.id,
      ),
      input.client.$queryRawUnsafe(
        CONCEPT_ROW_HASH_QUERY,
        snapshot.id,
      ),
    ]);
    const itemRows = rawItemRows as OperationalItemScoreHashRow[];
    const rawConceptRows = rawConceptRowsValue as OperationalConceptScoreHashRow[];
    const conceptRows = rawConceptRows.map(row => ({
      ...row,
      domainMix: isPlainRecord(row.domainMix)
        ? Object.fromEntries(
            Object.entries(row.domainMix).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          )
        : row.domainMix,
    }));
    const actualItemRowsHash = hashExamTargetArtifact(itemRows);
    const actualConceptRowsHash = hashExamTargetArtifact(conceptRows);
    if (actualItemRowsHash !== snapshot.itemRowsHash) {
      issues.push('item_rows_hash_mismatch');
    }
    if (actualConceptRowsHash !== snapshot.conceptRowsHash) {
      issues.push('concept_rows_hash_mismatch');
    }

    let manifestValid = false;
    if (isPlainRecord(snapshot.buildManifest)) {
      const { manifestHash, ...manifestBase } = snapshot.buildManifest;
      const counts = snapshot.buildManifest.counts;
      manifestValid = manifestHash === snapshot.manifestHash
        && snapshot.buildManifest.schema === 'md3.exam-target-snapshot-manifest/v1'
        && snapshot.buildManifest.targetId === definition.targetId
        && snapshot.buildManifest.revision === definition.revision
        && snapshot.buildManifest.itemRowsHash === snapshot.itemRowsHash
        && snapshot.buildManifest.conceptRowsHash === snapshot.conceptRowsHash
        && snapshot.buildManifest.artifactHash === snapshot.artifactHash
        && snapshot.buildManifest.sourceManifestHash === snapshot.sourceManifestHash
        && snapshot.buildManifest.targetVersion === input.targetVersion
        && snapshot.buildManifest.targetRotation === input.rotation
        && snapshot.buildManifest.status === 'built'
        && snapshot.buildManifest.privacyValidated === false
        && isPlainRecord(counts)
        && counts.domainCount === definition.domains.length
        && counts.scoredItemCount === itemRows.length
        && counts.conceptScoreCount === conceptRows.length
        && SHA256.test(snapshot.itemRowsHash)
        && SHA256.test(snapshot.conceptRowsHash)
        && SHA256.test(snapshot.manifestHash)
        && hashExamTargetArtifact(manifestBase) === snapshot.manifestHash;
    }
    if (!manifestValid) issues.push('manifest_hash_mismatch');
    rowSetValid = actualItemRowsHash === snapshot.itemRowsHash
      && actualConceptRowsHash === snapshot.conceptRowsHash
      && manifestValid;
  }
  return {
    schema: 'md3.exam-target-artifact-report/v1',
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    snapshotId: snapshot.id,
    snapshotStatus: snapshot.status,
    schemaReadiness,
    artifactValid,
    rowSetValid,
    privacyValidated: snapshot.privacyValidated,
    issues,
    passed: issues.length === 0,
  };
}

export async function auditExamTargetReachability(
  input: ExactExamTargetOperationInput,
): Promise<ExamTargetReachabilityReport> {
  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const curriculumVocabulary = reviewedCurriculumTopicVocabulary(input.rotation);
  const initial = {
    card: emptyReachability(),
    question: emptyReachability(),
    concept: emptyReachability(),
  };
  const schemaReadiness = await auditExamTargetSchemaReadiness(input.client);
  if (!schemaReadiness.ready) {
    return {
      schema: 'md3.exam-target-reachability-report/v1',
      rotation: input.rotation,
      targetVersion: input.targetVersion,
      snapshotId: null,
      snapshotStatus: null,
      schemaReadiness,
      artifactValid: false,
      privacyValidated: false,
      threshold: REACHABILITY_THRESHOLD,
      curriculumReadiness: curriculumReadiness(
        initial,
        false,
        curriculumVocabulary.canonicalTopicCount,
      ),
      items: initial,
      issues: ['schema_not_ready'],
      passed: false,
    };
  }
  const snapshot = await loadExactSnapshot(input, definition);
  if (!snapshot) {
    return {
      schema: 'md3.exam-target-reachability-report/v1',
      rotation: input.rotation,
      targetVersion: input.targetVersion,
      snapshotId: null,
      snapshotStatus: null,
      schemaReadiness,
      artifactValid: false,
      privacyValidated: false,
      threshold: REACHABILITY_THRESHOLD,
      curriculumReadiness: curriculumReadiness(
        initial,
        true,
        curriculumVocabulary.canonicalTopicCount,
      ),
      items: initial,
      issues: ['snapshot_missing'],
      passed: false,
    };
  }

  const aggregateRows = await input.client.$queryRawUnsafe(
    REACHABILITY_QUERY,
    snapshot.id,
    input.rotation,
    curriculumVocabulary.acceptedTopicSlugs,
    curriculumVocabulary.acceptedCanonicalTopicSlugs,
    JSON.stringify(compiledRuntimeCurriculumDispositionPolicy(input.rotation)),
  ) as ReachabilityAggregateRow[];
  const allowedDomains = new Set(definition.domains.map(domain => domain.code));
  const items = { ...initial };
  for (const row of aggregateRows) {
    if (row.itemType !== 'card'
      && row.itemType !== 'question'
      && row.itemType !== 'concept') {
      throw new Error('exam-target audit returned an invalid item type');
    }
    items[row.itemType] = parseReachabilityRow(row, allowedDomains);
  }

  const artifactValid = validateSnapshotArtifact(snapshot, definition);
  const issues: string[] = [];
  if (!artifactValid) issues.push('artifact_invalid');
  if (snapshot.status === 'retired') issues.push('snapshot_retired');
  for (const itemType of ['card', 'question', 'concept'] as const) {
    const entry = items[itemType];
    if (entry.eligibleItemCount === 0) issues.push(`${itemType}_eligible_empty`);
    if (entry.reachability < REACHABILITY_THRESHOLD) {
      issues.push(`${itemType}_reachability_below_threshold`);
    }
    if (entry.nativeReachability < REACHABILITY_THRESHOLD) {
      issues.push(`${itemType}_native_reachability_below_threshold`);
    }
    if (
      entry.crossSourceReachability != null
      && entry.crossSourceReachability < REACHABILITY_THRESHOLD
    ) issues.push(`${itemType}_cross_source_reachability_below_threshold`);
    if (entry.staleScoreCount > 0) issues.push(`${itemType}_stale_scores`);
    if (entry.orphanScoreCount > 0) issues.push(`${itemType}_orphan_scores`);
    if (entry.domainCodes.some(code => !allowedDomains.has(code))) {
      issues.push(`${itemType}_unknown_domains`);
    }
  }
  const curriculum = curriculumReadiness(
    items,
    true,
    curriculumVocabulary.canonicalTopicCount,
  );
  issues.push(...curriculum.issues);
  const passed = artifactValid
    && snapshot.status !== 'retired'
    && items.card.passed
    && items.question.passed
    && items.concept.passed
    && curriculum.releaseReady;

  return {
    schema: 'md3.exam-target-reachability-report/v1',
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    snapshotId: snapshot.id,
    snapshotStatus: snapshot.status,
    schemaReadiness,
    artifactValid,
    privacyValidated: snapshot.privacyValidated,
    threshold: REACHABILITY_THRESHOLD,
    curriculumReadiness: curriculum,
    items,
    issues,
    passed,
  };
}

export const EXAM_TARGET_SCHEDULER_VERSION = 'exam-target-scheduler-v2';

export function examTargetPolicyFingerprint(
  definition: ExamTargetDefinition,
): string {
  return hashExamTargetArtifact({
    schema: 'md3.exam-target-activation-policy/v1',
    targetVersion: examTargetVersionId(definition),
    scorerVersion: definition.scoringPolicyVersion,
    targetBasis: definition.targetBasis as ExamTargetBasis,
    influence: definition.influence,
  });
}

export interface ExamTargetPrivacyAuditGates {
  runtimeArtifactContract: boolean;
  targetTraceAllowlist: boolean;
  embeddingEgress: boolean;
}

export interface MarkExamTargetPrivacyValidatedInput {
  client: ExamTargetOperationsMutationClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
  mode?: 'dry-run' | 'apply';
  auditedBy: string;
  auditGates: ExamTargetPrivacyAuditGates;
  now?: Date;
}

export interface MarkExamTargetPrivacyValidatedResult {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  auditReceiptHash: string;
  readiness: ExamTargetReachabilityReport;
}

function assertStableOperator(value: string): void {
  if (
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
    || value.length > 128
  ) {
    throw new Error('auditedBy must be a stable operator identifier');
  }
}

/**
 * Promote a built snapshot to validated only after the three privacy audits and
 * DB reachability all pass. This never creates an activation.
 */
export async function markExamTargetPrivacyValidated(
  input: MarkExamTargetPrivacyValidatedInput,
): Promise<MarkExamTargetPrivacyValidatedResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error('privacy validation mode must be dry-run or apply');
  }
  assertStableOperator(input.auditedBy);
  if (
    input.auditGates.runtimeArtifactContract !== true
    || input.auditGates.targetTraceAllowlist !== true
    || input.auditGates.embeddingEgress !== true
  ) {
    throw new Error('all privacy audit gates must explicitly pass');
  }

  const artifactAudit = await auditExamTargetArtifact({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    now: input.now,
  });
  if (!artifactAudit.schemaReadiness.ready) {
    throw new Error(
      `privacy validation schema readiness failed: ${artifactAudit.schemaReadiness.missingDependencies.join(',')}`,
    );
  }
  if (!artifactAudit.passed) {
    throw new Error(
      'snapshot cannot be privacy-validated until the immutable artifact and row-set audit passes',
    );
  }

  const readiness = await auditExamTargetReachability({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
  });
  if (!readiness.snapshotId) {
    throw new Error('snapshot cannot be privacy-validated before reachability passes');
  }
  if (!readiness.curriculumReadiness.releaseReady) {
    throw new Error(
      'snapshot cannot be privacy-validated before curriculum readiness passes',
    );
  }
  if (!readiness.passed) {
    throw new Error('snapshot cannot be privacy-validated before reachability passes');
  }
  if (
    readiness.snapshotStatus !== 'built'
    && readiness.snapshotStatus !== 'validated'
  ) {
    throw new Error('only a built snapshot can enter validated lifecycle');
  }

  const now = input.now ?? new Date();
  const auditReceiptHash = hashExamTargetArtifact({
    schema: 'md3.exam-target-privacy-audit-receipt/v1',
    targetVersion: input.targetVersion,
    rotation: input.rotation,
    auditedBy: input.auditedBy,
    auditedAt: now.toISOString(),
    gates: input.auditGates,
    readiness: {
      snapshotId: readiness.snapshotId,
      cardReachability: readiness.items.card.reachability,
      questionReachability: readiness.items.question.reachability,
      conceptReachability: readiness.items.concept.reachability,
    },
  });
  if (mode === 'dry-run' || readiness.privacyValidated) {
    return {
      mode,
      applied: false,
      auditReceiptHash,
      readiness,
    };
  }

  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const updated = await input.client.examTargetSnapshot.updateMany({
    where: {
      id: readiness.snapshotId,
      targetId: definition.targetId,
      revision: definition.revision,
      rotation: input.rotation,
      artifactHash: hashExamTargetArtifact(definition),
      status: 'built',
      privacyValidated: false,
    },
    data: {
      status: 'validated',
      privacyValidated: true,
      validatedAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new Error('privacy validation lost its exact snapshot precondition');
  }
  return {
    mode: 'apply',
    applied: true,
    auditReceiptHash,
    readiness,
  };
}

export interface EnterExamTargetShadowInput {
  client: ExamTargetActivationMutationClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
  mode?: 'dry-run' | 'apply';
  operatedBy: string;
  decisionHmacReady: boolean;
  reason?: string;
  now?: Date;
}

export interface EnterExamTargetShadowResult {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  targetSnapshotId: string;
  activationMode: 'shadow';
  rolloutBasisPoints: 0;
  activationRevision: number | null;
  policyFingerprint: string;
  readiness: ExamTargetReachabilityReport;
}

function safeReason(value: string | undefined, fallback: string): string {
  const reason = value ?? fallback;
  if (!reason.trim() || reason.length > 512 || /[\r\n]/.test(reason)) {
    throw new Error('operator reason must be a bounded single line');
  }
  return reason;
}

/**
 * Point one rotation at an exact validated snapshot in 100% control shadow.
 * There is intentionally no active-treatment option in this operator.
 */
export async function enterExamTargetShadow(
  input: EnterExamTargetShadowInput,
): Promise<EnterExamTargetShadowResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error('shadow operation mode must be dry-run or apply');
  }
  assertStableOperator(input.operatedBy);
  if (input.decisionHmacReady !== true) {
    throw new Error('shadow apply requires a passing decision HMAC preflight');
  }
  const reason = safeReason(input.reason, 'exam-target-v2 controlled shadow');
  const artifactAudit = await auditExamTargetArtifact({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    now: input.now,
  });
  if (!artifactAudit.schemaReadiness.ready) {
    throw new Error(
      `shadow schema readiness failed: ${artifactAudit.schemaReadiness.missingDependencies.join(',')}`,
    );
  }
  if (!artifactAudit.passed) {
    throw new Error(
      'shadow requires a current immutable artifact and row-set audit',
    );
  }
  const readiness = await auditExamTargetReachability({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
  });
  if (
    !readiness.snapshotId
    || !readiness.privacyValidated
    || (
      readiness.snapshotStatus !== 'validated'
      && readiness.snapshotStatus !== 'active'
    )
  ) {
    throw new Error('shadow requires a validated, privacy-safe reachable snapshot');
  }
  if (!readiness.curriculumReadiness.releaseReady) {
    throw new Error('shadow requires passing curriculum readiness');
  }
  if (!readiness.passed) {
    throw new Error('shadow requires a validated, privacy-safe reachable snapshot');
  }
  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const policyFingerprint = examTargetPolicyFingerprint(definition);
  if (mode === 'dry-run') {
    return {
      mode: 'dry-run',
      applied: false,
      targetSnapshotId: readiness.snapshotId,
      activationMode: 'shadow',
      rolloutBasisPoints: 0,
      activationRevision: null,
      policyFingerprint,
      readiness,
    };
  }

  const now = input.now ?? new Date();
  const policyConfig = {
    schema: 'md3.exam-target-activation-policy/v1',
    targetVersion: input.targetVersion,
    schedulerVersion: EXAM_TARGET_SCHEDULER_VERSION,
    scorerVersion: definition.scoringPolicyVersion,
    influence: definition.influence,
  };
  const activation = await input.client.examTargetActivation.upsert({
    where: { rotation: input.rotation },
    create: {
      rotation: input.rotation,
      targetSnapshotId: readiness.snapshotId,
      mode: 'shadow',
      rolloutBasisPoints: 0,
      activationRevision: 1,
      schedulerVersion: EXAM_TARGET_SCHEDULER_VERSION,
      policyFingerprint,
      policyConfig,
      activatedAt: now,
      activatedBy: input.operatedBy,
      reason,
    },
    update: {
      targetSnapshotId: readiness.snapshotId,
      mode: 'shadow',
      rolloutBasisPoints: 0,
      activationRevision: { increment: 1 },
      schedulerVersion: EXAM_TARGET_SCHEDULER_VERSION,
      policyFingerprint,
      policyConfig,
      activatedAt: now,
      activatedBy: input.operatedBy,
      reason,
    },
    select: { activationRevision: true },
  });
  if (
    !Number.isSafeInteger(activation.activationRevision)
    || activation.activationRevision < 1
  ) {
    throw new Error('shadow activation returned an invalid revision');
  }
  return {
    mode: 'apply',
    applied: true,
    targetSnapshotId: readiness.snapshotId,
    activationMode: 'shadow',
    rolloutBasisPoints: 0,
    activationRevision: activation.activationRevision,
    policyFingerprint,
    readiness,
  };
}

export interface RollbackExamTargetToControlInput {
  client: ExamTargetRollbackClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
  mode?: 'dry-run' | 'apply';
  operatedBy: string;
  reason?: string;
  now?: Date;
}

export interface RollbackExamTargetToControlResult {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  targetSnapshotId: string | null;
  activationMode: 'off';
  rolloutBasisPoints: 0;
  priorActivationRevision: number | null;
}

/** Restore the legacy control scheduler for one exact target pointer. */
export async function rollbackExamTargetToControl(
  input: RollbackExamTargetToControlInput,
): Promise<RollbackExamTargetToControlResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error('rollback mode must be dry-run or apply');
  }
  assertStableOperator(input.operatedBy);
  const reason = safeReason(input.reason, 'exam-target-v2 operator rollback');
  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const snapshot = await loadExactSnapshot({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
  }, definition);
  if (!snapshot) throw new Error('exact rollback snapshot does not exist');

  const activation = await input.client.examTargetActivation.findUnique({
    where: { rotation: input.rotation },
    select: {
      id: true,
      targetSnapshotId: true,
      mode: true,
      activationRevision: true,
    },
  });
  if (!activation) {
    return {
      mode,
      applied: false,
      targetSnapshotId: snapshot.id,
      activationMode: 'off',
      rolloutBasisPoints: 0,
      priorActivationRevision: null,
    };
  }
  if (activation.targetSnapshotId !== snapshot.id) {
    throw new Error('rollback target does not match the current activation pointer');
  }
  if (activation.mode === 'off' || mode === 'dry-run') {
    return {
      mode,
      applied: false,
      targetSnapshotId: snapshot.id,
      activationMode: 'off',
      rolloutBasisPoints: 0,
      priorActivationRevision: activation.activationRevision,
    };
  }
  if (activation.mode !== 'shadow' && activation.mode !== 'active') {
    throw new Error('current activation mode is invalid');
  }

  const updated = await input.client.examTargetActivation.updateMany({
    where: {
      id: activation.id,
      rotation: input.rotation,
      targetSnapshotId: snapshot.id,
      mode: activation.mode,
      activationRevision: activation.activationRevision,
    },
    data: {
      mode: 'off',
      rolloutBasisPoints: 0,
      activationRevision: { increment: 1 },
      activatedAt: input.now ?? new Date(),
      activatedBy: input.operatedBy,
      reason,
    },
  });
  if (updated.count !== 1) {
    throw new Error('rollback lost its exact activation precondition');
  }
  return {
    mode: 'apply',
    applied: true,
    targetSnapshotId: snapshot.id,
    activationMode: 'off',
    rolloutBasisPoints: 0,
    priorActivationRevision: activation.activationRevision,
  };
}

export interface RetireExamTargetSnapshotInput {
  client: ExamTargetRetirementClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
  mode?: 'dry-run' | 'apply';
  operatedBy: string;
  reason?: string;
  now?: Date;
}

export interface RetireExamTargetSnapshotResult {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  snapshotId: string;
  rolledBackPointer: boolean;
}

/**
 * Soft-retire an immutable snapshot. If it is still the current pointer, that
 * pointer is moved to control/off in the same transaction before retirement.
 */
export async function retireExamTargetSnapshot(
  input: RetireExamTargetSnapshotInput,
): Promise<RetireExamTargetSnapshotResult> {
  const mode = input.mode ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new Error('retirement mode must be dry-run or apply');
  }
  assertStableOperator(input.operatedBy);
  const reason = safeReason(input.reason, 'exam-target-v2 snapshot retirement');
  const definition = exactReviewedDefinition(input.rotation, input.targetVersion);
  const snapshot = await loadExactSnapshot({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
  }, definition);
  if (!snapshot) throw new Error('exact retirement snapshot does not exist');
  if (
    snapshot.targetId !== definition.targetId
    || snapshot.revision !== definition.revision
    || snapshot.rotation !== input.rotation
  ) {
    throw new Error('retirement snapshot identity is inconsistent');
  }
  if (snapshot.status === 'retired' || mode === 'dry-run') {
    return {
      mode,
      applied: false,
      snapshotId: snapshot.id,
      rolledBackPointer: false,
    };
  }

  const now = input.now ?? new Date();
  const rawResult = await input.client.$transaction(async transaction => {
    const rolledBack = await transaction.examTargetActivation.updateMany({
      where: {
        rotation: input.rotation,
        targetSnapshotId: snapshot.id,
        mode: { in: ['shadow', 'active'] },
      },
      data: {
        mode: 'off',
        rolloutBasisPoints: 0,
        activationRevision: { increment: 1 },
        activatedAt: now,
        activatedBy: input.operatedBy,
        reason,
      },
    });
    const retired = await transaction.examTargetSnapshot.updateMany({
      where: {
        id: snapshot.id,
        targetId: definition.targetId,
        revision: definition.revision,
        rotation: input.rotation,
        status: snapshot.status,
      },
      data: { status: 'retired' },
    });
    if (retired.count !== 1) {
      throw new Error('retirement lost its exact snapshot precondition');
    }
    return rolledBack.count;
  });
  const result = rawResult as number;

  return {
    mode: 'apply',
    applied: true,
    snapshotId: snapshot.id,
    rolledBackPointer: result === 1,
  };
}

export interface AuditExamTargetShadowInput {
  client: ExamTargetShadowAuditClient;
  rotation: ExamTargetRotation;
  targetVersion: string;
  now?: Date;
  days?: number;
}

export interface ExamTargetShadowAuditReport {
  schema: 'md3.exam-target-shadow-report/v1';
  rotation: ExamTargetRotation;
  targetVersion: string;
  snapshotId: string | null;
  windowStart: string;
  /** All trace rows across scheduler paths. */
  decisionSetCount: number;
  /** Paired manifold rows eligible for causal/mechanical shadow measures. */
  manifoldDecisionSetCount: number;
  /** Protected due/relearn trace rows, excluded from paired measures. */
  protectedReviewDecisionSetCount: number;
  sessionCount: number;
  targetEligibleSlotCount: number;
  fallbackCount: number;
  fallbackRate: number;
  nominalControlReasonCount: number;
  meanPairedTargetLift: number | null;
  meanControlAllocationError: number | null;
  meanTargetAllocationError: number | null;
  allocationErrorImprovement: number | null;
  p95TargetComputeMs: number | null;
  replayCapturedCount: number;
  replayIntegrityPassedCount: number;
  /** Captured-snapshot integrity; independent policy re-execution is separate. */
  replayIntegrityRate: number | null;
  unexpectedControlPlaneCount: number;
  masteryTelemetryCapturedCount: number;
  masteryTelemetryCoverageRate: number;
  coreTargetSeatShortfallTotal: number;
  masteryWorkloadOffTrackCount: number;
  masteryWarningCount: number;
  masteryCoverageDebtDomainCodes: readonly string[];
  masteryChangedConceptMembershipCount: number;
  artifactAudit: ExamTargetArtifactAuditReport;
  reachability: ExamTargetReachabilityReport;
  mechanicalSignalsPassed: boolean;
  releaseQualificationPassed: false;
  issues: readonly string[];
  passed: boolean;
}

function finiteMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stableMetric(value: number): number {
  return Number(value.toFixed(12));
}

interface AuditedMasteryTelemetry {
  coreTargetSeatShortfall: number;
  workloadOnTrack: boolean | null;
  loadWarnings: readonly string[];
  coverageDebtDomainCodes: readonly string[];
  changedConceptMembershipCount: number;
  evaluationOnly: boolean;
}

function parseAuditedMasteryTelemetry(value: unknown): AuditedMasteryTelemetry | null {
  if (!isPlainRecord(value)) return null;
  const {
    coreTargetSeatShortfall,
    workloadOnTrack,
    loadWarnings,
    coverageDebtDomainCodes,
    changedConceptMembershipCount,
    evaluationOnly,
  } = value;
  if (
    !Number.isSafeInteger(coreTargetSeatShortfall)
    || (coreTargetSeatShortfall as number) < 0
    || (workloadOnTrack !== null && typeof workloadOnTrack !== 'boolean')
    || !Array.isArray(loadWarnings)
    || loadWarnings.some(warning => typeof warning !== 'string' || !warning)
    || !Array.isArray(coverageDebtDomainCodes)
    || coverageDebtDomainCodes.some(code => typeof code !== 'string' || !code)
    || !Number.isSafeInteger(changedConceptMembershipCount)
    || (changedConceptMembershipCount as number) < 0
    || typeof evaluationOnly !== 'boolean'
  ) return null;
  return {
    coreTargetSeatShortfall: coreTargetSeatShortfall as number,
    workloadOnTrack,
    loadWarnings,
    coverageDebtDomainCodes,
    changedConceptMembershipCount: changedConceptMembershipCount as number,
    evaluationOnly,
  };
}

function capturedReplayIntegrity(value: unknown): boolean {
  try {
    const replay = parseExamTargetDecisionReplaySnapshot(value);
    return replayExamTargetDecision(value, () => ({
      controlSelectionTokens: replay.expected.controlSelectionTokens,
      targetSelectionTokens: replay.expected.targetSelectionTokens,
    })).exactMatch;
  } catch {
    return false;
  }
}

/** Read-only mechanical audit of the latest exact-snapshot shadow evidence. */
export async function auditExamTargetShadow(
  input: AuditExamTargetShadowInput,
): Promise<ExamTargetShadowAuditReport> {
  const now = input.now ?? new Date();
  const days = input.days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('shadow audit days must be an integer from 1 to 90');
  }
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1_000);
  const artifactAudit = await auditExamTargetArtifact({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    now,
  });
  const reachability = await auditExamTargetReachability({
    client: input.client,
    rotation: input.rotation,
    targetVersion: input.targetVersion,
  });
  if (!reachability.snapshotId) {
    return {
      schema: 'md3.exam-target-shadow-report/v1',
      rotation: input.rotation,
      targetVersion: input.targetVersion,
      snapshotId: null,
      windowStart: windowStart.toISOString(),
      decisionSetCount: 0,
      manifoldDecisionSetCount: 0,
      protectedReviewDecisionSetCount: 0,
      sessionCount: 0,
      targetEligibleSlotCount: 0,
      fallbackCount: 0,
      fallbackRate: 0,
      nominalControlReasonCount: 0,
      meanPairedTargetLift: null,
      meanControlAllocationError: null,
      meanTargetAllocationError: null,
      allocationErrorImprovement: null,
      p95TargetComputeMs: null,
      replayCapturedCount: 0,
      replayIntegrityPassedCount: 0,
      replayIntegrityRate: null,
      unexpectedControlPlaneCount: 0,
      masteryTelemetryCapturedCount: 0,
      masteryTelemetryCoverageRate: 0,
      coreTargetSeatShortfallTotal: 0,
      masteryWorkloadOffTrackCount: 0,
      masteryWarningCount: 0,
      masteryCoverageDebtDomainCodes: [],
      masteryChangedConceptMembershipCount: 0,
      artifactAudit,
      reachability,
      mechanicalSignalsPassed: false,
      releaseQualificationPassed: false,
      issues: ['snapshot_missing'],
      passed: false,
    };
  }

  const decisions = await input.client.schedulerDecisionSet.findMany({
    where: {
      targetSnapshotId: reachability.snapshotId,
      rotation: input.rotation,
      decidedAt: { gte: windowStart, lte: now },
    },
    select: {
      sessionId: true,
      decisionPath: true,
      mode: true,
      assignment: true,
      targetEligibleCount: true,
      pairedTargetLift: true,
      controlAllocationError: true,
      targetAllocationError: true,
      targetComputeMs: true,
      fallbackReason: true,
      replaySnapshot: true,
      masteryTelemetry: true,
    },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    take: 50_000,
  });
  const manifoldDecisions = decisions.filter(
    decision => decision.decisionPath === 'manifold-walk',
  );
  const protectedReviewDecisionSetCount = decisions.filter(
    decision => decision.decisionPath === 'review-filter',
  ).length;
  let targetEligibleSlotCount = 0;
  let fallbackCount = 0;
  let nominalControlReasonCount = 0;
  let unexpectedControlPlaneCount = 0;
  const lifts: number[] = [];
  const controlErrors: number[] = [];
  const targetErrors: number[] = [];
  const computeTimes: number[] = [];
  const replaySnapshots: unknown[] = [];
  let masteryTelemetryCapturedCount = 0;
  let coreTargetSeatShortfallTotal = 0;
  let masteryWorkloadOffTrackCount = 0;
  let masteryWarningCount = 0;
  let masteryChangedConceptMembershipCount = 0;
  const masteryCoverageDebtDomainCodes = new Set<string>();
  const sessionIds = new Set<string>();
  let invalidMetricCount = 0;

  // Protected review-filter rows remain visible in the trace counts above, but
  // they are control-identical protected work rather than paired manifold
  // evidence. They must not contribute to causal lift, allocation, mastery,
  // latency, replay, fallback, or release-evidence denominators.
  for (const decision of manifoldDecisions) {
    if (typeof decision.sessionId === 'string' && decision.sessionId) {
      sessionIds.add(decision.sessionId);
    }
    if (
      !Number.isSafeInteger(decision.targetEligibleCount)
      || decision.targetEligibleCount < 0
    ) {
      invalidMetricCount += 1;
    } else {
      targetEligibleSlotCount += decision.targetEligibleCount;
    }
    if (decision.mode !== 'shadow' || decision.assignment !== 'control') {
      unexpectedControlPlaneCount += 1;
    }
    if (decision.fallbackReason != null) {
      if (
        decision.fallbackReason === 'shadow-serves-control'
        || decision.fallbackReason === 'control-assignment'
        || decision.fallbackReason === 'protected-lane-control-identical'
      ) nominalControlReasonCount += 1;
      else fallbackCount += 1;
    }
    for (const [value, destination] of [
      [decision.pairedTargetLift, lifts],
      [decision.controlAllocationError, controlErrors],
      [decision.targetAllocationError, targetErrors],
    ] as const) {
      if (value == null) continue;
      if (!Number.isFinite(value)) invalidMetricCount += 1;
      else destination.push(value);
    }
    if (decision.targetComputeMs != null) {
      if (
        !Number.isSafeInteger(decision.targetComputeMs)
        || decision.targetComputeMs < 0
      ) invalidMetricCount += 1;
      else computeTimes.push(decision.targetComputeMs);
    }
    if (decision.replaySnapshot != null) {
      replaySnapshots.push(decision.replaySnapshot);
    }
    if (decision.masteryTelemetry != null) {
      const mastery = parseAuditedMasteryTelemetry(decision.masteryTelemetry);
      if (!mastery) {
        invalidMetricCount += 1;
      } else {
        masteryTelemetryCapturedCount += 1;
        coreTargetSeatShortfallTotal += mastery.coreTargetSeatShortfall;
        if (mastery.workloadOnTrack === false) masteryWorkloadOffTrackCount += 1;
        masteryWarningCount += mastery.loadWarnings.length;
        masteryChangedConceptMembershipCount += mastery.changedConceptMembershipCount;
        mastery.coverageDebtDomainCodes.forEach(code => {
          masteryCoverageDebtDomainCodes.add(code);
        });
      }
    }
  }

  const meanPairedTargetLift = finiteMean(lifts);
  const meanControlAllocationError = finiteMean(controlErrors);
  const meanTargetAllocationError = finiteMean(targetErrors);
  const allocationErrorImprovement = meanControlAllocationError != null
    && meanTargetAllocationError != null
    && meanControlAllocationError > 0
    ? (meanControlAllocationError - meanTargetAllocationError)
      / meanControlAllocationError
    : meanControlAllocationError === 0 && meanTargetAllocationError === 0
      ? 0
      : null;
  const sortedComputeTimes = [...computeTimes].sort((left, right) => left - right);
  const p95TargetComputeMs = sortedComputeTimes.length === 0
    ? null
    : sortedComputeTimes[
      Math.max(0, Math.ceil(sortedComputeTimes.length * 0.95) - 1)
    ];
  const replayIntegrityPassedCount = replaySnapshots.filter(
    capturedReplayIntegrity,
  ).length;
  const replayIntegrityRate = replaySnapshots.length === 0
    ? null
    : replayIntegrityPassedCount / replaySnapshots.length;
  const fallbackRate = manifoldDecisions.length === 0
    ? 0
    : fallbackCount / manifoldDecisions.length;
  const masteryTelemetryCoverageRate = manifoldDecisions.length === 0
    ? 0
    : masteryTelemetryCapturedCount / manifoldDecisions.length;
  const mechanicalIssues: string[] = [];
  if (!artifactAudit.artifactValid) mechanicalIssues.push('artifact_invalid');
  if (!artifactAudit.rowSetValid) mechanicalIssues.push('artifact_row_set_failed');
  if (!artifactAudit.passed) mechanicalIssues.push('artifact_audit_failed');
  if (!reachability.passed) mechanicalIssues.push('reachability_failed');
  if (!reachability.privacyValidated) mechanicalIssues.push('privacy_validation_missing');
  if (
    reachability.snapshotStatus !== 'validated'
    && reachability.snapshotStatus !== 'active'
  ) mechanicalIssues.push('snapshot_not_validated');
  if (sessionIds.size < 20) mechanicalIssues.push('insufficient_shadow_sessions');
  if (targetEligibleSlotCount < 500) mechanicalIssues.push('insufficient_target_eligible_slots');
  if (fallbackRate >= 0.005) mechanicalIssues.push('fallback_rate_too_high');
  if (meanPairedTargetLift == null || meanPairedTargetLift < 0.05) {
    mechanicalIssues.push('paired_target_lift_too_low');
  }
  if (
    allocationErrorImprovement == null
    || allocationErrorImprovement < 0.2
  ) mechanicalIssues.push('allocation_error_improvement_too_low');
  if (replaySnapshots.length === 0) mechanicalIssues.push('replay_sample_missing');
  if (replayIntegrityRate !== 1) mechanicalIssues.push('replay_integrity_failed');
  if (unexpectedControlPlaneCount > 0) {
    mechanicalIssues.push('unexpected_shadow_control_plane');
  }
  if (invalidMetricCount > 0) mechanicalIssues.push('invalid_shadow_metrics');
  if (p95TargetComputeMs == null) mechanicalIssues.push('target_compute_latency_missing');
  if (masteryTelemetryCoverageRate < 0.995) {
    mechanicalIssues.push('mastery_telemetry_incomplete');
  }
  if (coreTargetSeatShortfallTotal > 0) {
    mechanicalIssues.push('core_target_seat_shortfall');
  }
  if (masteryWorkloadOffTrackCount > 0) {
    mechanicalIssues.push('mastery_workload_off_track');
  }
  if (masteryWarningCount > 0) mechanicalIssues.push('mastery_load_warnings');

  // SchedulerDecisionSet rows are successful writes. They do not provide the
  // target-capable attempt denominator or the control guardrails required for
  // release qualification, and the captured replay lacks enough policy state
  // for independent re-execution. Keep this report explicitly non-qualifying.
  const issues = [
    ...mechanicalIssues,
    ...reachability.curriculumReadiness.issues,
    'independent_policy_replay_not_available',
    'release_guardrail_metrics_not_available',
    'attempt_denominator_not_available',
  ];

  return {
    schema: 'md3.exam-target-shadow-report/v1',
    rotation: input.rotation,
    targetVersion: input.targetVersion,
    snapshotId: reachability.snapshotId,
    windowStart: windowStart.toISOString(),
    decisionSetCount: decisions.length,
    manifoldDecisionSetCount: manifoldDecisions.length,
    protectedReviewDecisionSetCount,
    sessionCount: sessionIds.size,
    targetEligibleSlotCount,
    fallbackCount,
    fallbackRate: stableMetric(fallbackRate),
    nominalControlReasonCount,
    meanPairedTargetLift: meanPairedTargetLift == null
      ? null
      : stableMetric(meanPairedTargetLift),
    meanControlAllocationError: meanControlAllocationError == null
      ? null
      : stableMetric(meanControlAllocationError),
    meanTargetAllocationError: meanTargetAllocationError == null
      ? null
      : stableMetric(meanTargetAllocationError),
    allocationErrorImprovement: allocationErrorImprovement == null
      ? null
      : stableMetric(allocationErrorImprovement),
    p95TargetComputeMs,
    replayCapturedCount: replaySnapshots.length,
    replayIntegrityPassedCount,
    replayIntegrityRate: replayIntegrityRate == null
      ? null
      : stableMetric(replayIntegrityRate),
    unexpectedControlPlaneCount,
    masteryTelemetryCapturedCount,
    masteryTelemetryCoverageRate: stableMetric(masteryTelemetryCoverageRate),
    coreTargetSeatShortfallTotal,
    masteryWorkloadOffTrackCount,
    masteryWarningCount,
    masteryCoverageDebtDomainCodes: [...masteryCoverageDebtDomainCodes].sort(),
    masteryChangedConceptMembershipCount,
    artifactAudit,
    reachability,
    mechanicalSignalsPassed: mechanicalIssues.length === 0,
    releaseQualificationPassed: false,
    issues,
    passed: false,
  };
}
