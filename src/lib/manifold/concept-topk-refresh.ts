/**
 * Builds the precomputed concept top-K (docs/designs/2026-10-02-neon-scale.md).
 *
 * Each partition is rebuilt in one transaction: take a transaction-scoped
 * advisory lock on the partition (a second runner skips it), read the epochs
 * FIRST, compute every list server-side (no vector leaves Postgres), replace
 * the partition's lists and upsert its manifest. Readers see the old partition
 * or the new one, never half of one. Reading the epochs before computing means
 * a change that lands mid-build leaves the manifest behind the current epoch:
 * stale, never wrong.
 *
 * The search is exact. The distance is computed once in a subquery fenced with
 * OFFSET 0, so the HNSW index cannot be chosen and no row is scored twice; ties
 * are broken by item id. The live query is approximate when the planner uses
 * HNSW, so the two are not equivalent in general; on the tested snapshot (an
 * isolated branch, 2 October) they agreed for CAH, PAAM, critical care and
 * PWH, cards and questions.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { setLocalLimits } from '@/lib/db/statement-budget';
import {
  NO_LOCALE_CLASS,
  adjacentPartitionKey,
  homePartitionKey,
  parsePartitionKey,
  type ConceptTopKItemType,
} from './concept-topk';
import { CARD_TOPK_ELIGIBILITY_SQL, QUESTION_TOPK_ELIGIBILITY_SQL } from './concept-topk-sql';
import { describeTriggers, missingConceptTopKTriggers } from './concept-topk-triggers';
import { conceptTopKListInsertSql } from './scoring';

/** Matches TOPK_CARDS_PER_CONCEPT / TOPK_QUESTIONS_PER_CONCEPT in bulk-candidates. */
export const CONCEPT_TOPK_DEPTH = 200;

/** Per-statement ceiling inside a partition build; the largest measured took ~22 s. */
const PARTITION_STATEMENT_TIMEOUT_MS = 90_000;

/** Client-side ceiling for a whole partition build when no deadline is given. */
const PARTITION_TRANSACTION_TIMEOUT_MS = 280_000;

/**
 * With a deadline, a partition is started only with at least this long left,
 * and its statements may not outlast the deadline, so the cron finishes inside
 * its function limit.
 */
const PARTITION_MIN_BUDGET_MS = 30_000;

/** Client-side ceiling for compacting the change log. */
export const CONCEPT_TOPK_COMPACTION_TIMEOUT_MS = 20_000;

/** A partition whose build failed is not retried for this long. */
export const CONCEPT_TOPK_FAILURE_COOLDOWN_MS = 30 * 60_000;

/** A plan is redone after this long even when nothing it depends on has moved. */
export const CONCEPT_TOPK_REPLAN_AFTER_MS = 6 * 60 * 60_000;

/**
 * A built partition older than this is rebuilt, ahead of the read path's cap
 * (CONCEPT_TOPK_MAX_MANIFEST_AGE_MS, 26 hours), so it never goes unserved.
 * Empty manifests are rewritten at every full plan instead.
 */
export const CONCEPT_TOPK_REBUILD_AGE_MS = 24 * 60 * 60_000;

/**
 * The item epoch of a planned partition that has not been built yet. Epochs
 * are sums of positive weights, so it never matches: the read path treats the
 * partition as stale and the refresh builds it, without having to plan again
 * to remember that it exists.
 */
const PENDING_EPOCH = -1;

/** Enough of a failure message to diagnose it from the table. */
const FAILURE_MESSAGE_LIMIT = 2_000;

type RawTransaction = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | '$executeRawUnsafe'>;

/** Structural, so the app client and the scripts' client both satisfy it. */
export interface ConceptTopKRefreshClient extends RawTransaction {
  $transaction<T>(
    operation: (transaction: RawTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export interface PlannedPartition {
  itemType: ConceptTopKItemType;
  partition: string;
  sessionRotation: string;
  /**
   * An adjacent pair with no eligible item mapped into the session rotation.
   * It gets a manifest with no locale classes and no lists, so a session that
   * is entitled to the item rotation is served precomputed (the pair adds
   * nothing) instead of going live for a partition that was never built.
   */
  empty?: boolean;
}

export interface PartitionBuildResult extends PlannedPartition {
  outcome: 'built' | 'locked' | 'failed';
  conceptCount?: number;
  localeClasses?: string[];
  buildMs: number;
  error?: string;
}

export interface ConceptTopKRefreshReport {
  planned: number;
  needingBuild: number;
  results: PartitionBuildResult[];
  deadlineReached: boolean;
  removedPartitions: number;
  compactedScopes: number;
  durationMs: number;
  /** Change-log triggers found missing or disabled; non-empty means nothing was built. */
  triggersMissing: string[];
  /** Empty-partition manifests written (or rewritten) by this run. */
  emptyPartitions: number;
  /** The plan was empty or under half the existing manifests, so nothing was pruned. */
  pruneRefused: boolean;
  /** Partitions needing a build that were skipped because they failed recently, as `itemType:partition`. */
  skippedAfterFailure: string[];
  /** Why the parent tables were scanned to plan again; null when the last plan still held. */
  planReason: PlanReason | null;
}

export type PlanReason =
  | 'scoped'
  | 'forced'
  | 'no-plan'
  | 'plan-expired'
  | 'items-changed'
  | 'concept-rotations-changed'
  | 'manifests-missing';

/** The last full plan and the state it saw ("ConceptTopKPlan"). */
export interface ConceptTopKPlanRecord {
  itemEpochTotal: bigint;
  sessionRotations: readonly string[];
  partitionCount: number;
  plannedAt: number;
}

interface ItemTableSpec {
  embeddings: Prisma.Sql;
  idColumn: Prisma.Sql;
  parent: Prisma.Sql;
  eligibility: Prisma.Sql;
}

const ITEM_TABLES: Record<ConceptTopKItemType, ItemTableSpec> = {
  card: {
    embeddings: Prisma.raw('card_embeddings'),
    idColumn: Prisma.raw('card_id'),
    parent: Prisma.raw('"Card"'),
    // The precompute is the SHARED catalog: owner-private cards never enter it,
    // and a learner who owns any is served by the live query instead.
    eligibility: Prisma.sql`p."ownerUserId" IS NULL AND ${CARD_TOPK_ELIGIBILITY_SQL}`,
  },
  question: {
    embeddings: Prisma.raw('question_embeddings'),
    idColumn: Prisma.raw('question_id'),
    parent: Prisma.raw('"Question"'),
    eligibility: QUESTION_TOPK_ELIGIBILITY_SQL,
  },
};

export function itemScope(itemType: ConceptTopKItemType, itemRotation: string): string {
  return `${itemType}:${itemRotation}`;
}

export const CONCEPTS_SCOPE = 'concepts';

function partitionPredicate(partition: string): Prisma.Sql {
  const { itemRotation, mappedTo } = parsePartitionKey(partition);
  return mappedTo === null
    ? Prisma.sql`p.rotation = ${itemRotation}`
    : Prisma.sql`p.rotation = ${itemRotation} AND ${mappedTo} = ANY(p."moduleNodes")`;
}

function localeClassPredicate(localeClass: string): Prisma.Sql {
  return localeClass === NO_LOCALE_CLASS
    ? Prisma.sql`p."practiceLocale" IS NULL`
    : Prisma.sql`p."practiceLocale" = ${localeClass}`;
}

/** Every scope's epoch, read in one pass over the (compacted) change log. */
export async function readAllCandidatePoolEpochs(
  client: Pick<ConceptTopKRefreshClient, '$queryRaw'>,
): Promise<Map<string, bigint>> {
  const rows = await client.$queryRaw<Array<{ scope: string; epoch: bigint | number | string }>>`
    SELECT scope, sum(weight)::bigint AS epoch FROM "CandidatePoolChange" GROUP BY scope
  `;
  return new Map(rows.map((row) => [row.scope, BigInt(row.epoch)]));
}

/** Epoch of each scope: SUM(weight) of its change rows, 0 when it has none. */
export async function readCandidatePoolEpochs(
  client: Pick<ConceptTopKRefreshClient, '$queryRaw'>,
  scopes: readonly string[],
): Promise<Map<string, bigint>> {
  const unique = [...new Set(scopes)];
  if (unique.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ scope: string; epoch: bigint | number | string }>>`
    SELECT s.scope, COALESCE((
      SELECT sum(c.weight) FROM "CandidatePoolChange" c WHERE c.scope = s.scope
    ), 0)::bigint AS epoch
    FROM unnest(${unique}::text[]) AS s(scope)
  `;
  return new Map(rows.map((row) => [row.scope, BigInt(row.epoch)]));
}

/**
 * Every partition the read path can ask for: the home partition of each
 * rotation that has embedded concepts, plus one adjacent partition for every
 * (item rotation with eligible items, other session rotation) pair, marked
 * empty when no eligible item of that rotation maps into the session rotation.
 * One scan of each parent table finds both the rotations and their mappings.
 */
export async function planConceptTopKPartitions(
  client: Pick<ConceptTopKRefreshClient, '$queryRaw'>,
  options: { itemTypes?: readonly ConceptTopKItemType[]; sessionRotations?: readonly string[] } = {},
): Promise<PlannedPartition[]> {
  const itemTypes = options.itemTypes ?? ['card', 'question'];
  const rotationRows = await client.$queryRaw<Array<{ rotation: string }>>`
    SELECT DISTINCT c.rotation
    FROM "Concept" c
    JOIN concept_embeddings ce ON ce.concept_id = c.id
    ORDER BY c.rotation
  `;
  const wanted = options.sessionRotations ? new Set(options.sessionRotations) : null;
  const sessionRotations = rotationRows
    .map((row) => row.rotation)
    .filter((rotation) => (wanted ? wanted.has(rotation) : true))
    .filter((rotation) => isPartitionableRotation(rotation));
  if (sessionRotations.length === 0) return [];

  const planned: PlannedPartition[] = [];
  for (const itemType of itemTypes) {
    for (const rotation of sessionRotations) {
      planned.push({ itemType, partition: homePartitionKey(rotation), sessionRotation: rotation });
    }
    const spec = ITEM_TABLES[itemType];
    const itemRotations = await client.$queryRaw<Array<{ item_rotation: string; targets: string[] }>>`
      SELECT p.rotation AS item_rotation,
             COALESCE(array_agg(DISTINCT t.target) FILTER (WHERE t.target IS NOT NULL), '{}') AS targets
      FROM ${spec.parent} p
      LEFT JOIN LATERAL (
        SELECT u.target FROM unnest(p."moduleNodes") AS u(target)
        WHERE u.target = ANY(${sessionRotations}::text[]) AND u.target <> p.rotation
      ) t ON true
      WHERE ${spec.eligibility}
      GROUP BY p.rotation
    `;
    for (const row of [...itemRotations].sort((a, b) => (a.item_rotation < b.item_rotation ? -1 : 1))) {
      if (!isPartitionableRotation(row.item_rotation)) continue;
      const mapped = new Set(row.targets);
      for (const sessionRotation of sessionRotations) {
        if (sessionRotation === row.item_rotation) continue;
        planned.push({
          itemType,
          partition: adjacentPartitionKey(row.item_rotation, sessionRotation),
          sessionRotation,
          ...(mapped.has(sessionRotation) ? {} : { empty: true }),
        });
      }
    }
  }
  return planned;
}

/** A rotation name that cannot be encoded in a partition key is never planned. */
function isPartitionableRotation(rotation: string): boolean {
  return Boolean(rotation) && !rotation.includes('>') && rotation.trim() === rotation;
}

interface ManifestRow {
  itemType: string;
  partition: string;
  sessionRotation: string;
  localeClassCount: number;
  itemEpoch: bigint | number | string;
  conceptEpoch: bigint | number | string;
  conceptCount: number;
  topK: number;
  builtAt: Date | string;
}

function readManifests(client: Pick<ConceptTopKRefreshClient, '$queryRaw'>): Promise<ManifestRow[]> {
  return client.$queryRaw<ManifestRow[]>`
    SELECT "itemType", "partition", "sessionRotation", cardinality("localeClasses")::int AS "localeClassCount",
           "itemEpoch", "conceptEpoch", "conceptCount", "topK", "builtAt"
    FROM "ConceptTopKPartition"
  `;
}

function manifestAsPlanned(manifest: ManifestRow): PlannedPartition {
  return {
    itemType: manifest.itemType as ConceptTopKItemType,
    partition: manifest.partition,
    sessionRotation: manifest.sessionRotation,
    ...(manifest.localeClassCount === 0 ? { empty: true } : {}),
  };
}

/** The sum of every card and question epoch: it moves whenever any item scope does. */
function itemEpochTotal(epochs: ReadonlyMap<string, bigint>): bigint {
  let total = BigInt(0);
  for (const [scope, epoch] of epochs) {
    if (scope.startsWith('card:') || scope.startsWith('question:')) total += epoch;
  }
  return total;
}

/** The session rotations a full plan covers: those with embedded concepts. */
function plannableSessionRotations(conceptCounts: ReadonlyMap<string, number>): string[] {
  return [...conceptCounts.keys()].filter((rotation) => isPartitionableRotation(rotation)).sort();
}

/**
 * Why the last full plan may no longer hold, or null when it still does. The
 * partitions depend on the item rows (summarised by the item epochs) and on
 * which rotations have concepts; a manifest that has gone missing, or a plan
 * older than CONCEPT_TOPK_REPLAN_AFTER_MS, also calls for a fresh scan.
 */
export function planMayHaveChanged(input: {
  lastPlan: ConceptTopKPlanRecord | null;
  epochs: ReadonlyMap<string, bigint>;
  sessionRotations: readonly string[];
  manifestCount: number;
  now: number;
}): PlanReason | null {
  const { lastPlan } = input;
  if (!lastPlan) return 'no-plan';
  if (input.now - lastPlan.plannedAt > CONCEPT_TOPK_REPLAN_AFTER_MS) return 'plan-expired';
  if (itemEpochTotal(input.epochs) !== lastPlan.itemEpochTotal) return 'items-changed';
  const recorded = [...lastPlan.sessionRotations].sort();
  const current = [...input.sessionRotations].sort();
  if (recorded.length !== current.length || recorded.some((rotation, i) => rotation !== current[i])) {
    return 'concept-rotations-changed';
  }
  if (input.manifestCount < lastPlan.partitionCount) return 'manifests-missing';
  return null;
}

async function readLastPlan(client: Pick<ConceptTopKRefreshClient, '$queryRaw'>): Promise<ConceptTopKPlanRecord | null> {
  const rows = await client.$queryRaw<Array<{
    itemEpochTotal: bigint | number | string;
    sessionRotations: string[];
    partitionCount: number;
    plannedAt: Date | string;
  }>>`
    SELECT "itemEpochTotal", "sessionRotations", "partitionCount", "plannedAt"
    FROM "ConceptTopKPlan" WHERE "id" = 'current'
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    itemEpochTotal: BigInt(row.itemEpochTotal),
    sessionRotations: row.sessionRotations,
    partitionCount: Number(row.partitionCount),
    plannedAt: new Date(row.plannedAt).getTime(),
  };
}

async function recordPlan(
  client: Pick<ConceptTopKRefreshClient, '$executeRaw'>,
  plan: Omit<ConceptTopKPlanRecord, 'plannedAt'>,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO "ConceptTopKPlan" ("id", "itemEpochTotal", "sessionRotations", "partitionCount", "plannedAt")
    VALUES ('current', ${String(plan.itemEpochTotal)}::bigint, ${[...plan.sessionRotations]}::text[],
            ${plan.partitionCount}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "itemEpochTotal" = EXCLUDED."itemEpochTotal",
      "sessionRotations" = EXCLUDED."sessionRotations",
      "partitionCount" = EXCLUDED."partitionCount",
      "plannedAt" = EXCLUDED."plannedAt"
  `;
}

/**
 * A manifest for every planned partition that has none yet, at PENDING_EPOCH,
 * so later runs see it (as stale) without planning again.
 */
async function writePendingManifests(
  client: Pick<ConceptTopKRefreshClient, '$executeRaw'>,
  entries: readonly PlannedPartition[],
): Promise<void> {
  if (entries.length === 0) return;
  await client.$executeRaw`
    INSERT INTO "ConceptTopKPartition"
      ("itemType", "partition", "sessionRotation", "localeClasses", "itemEpoch", "conceptEpoch",
       "topK", "conceptCount", "buildMs", "builtAt")
    SELECT e.item_type, e.part, e.session, ${[NO_LOCALE_CLASS]}::text[], ${PENDING_EPOCH}, ${PENDING_EPOCH},
           0, 0, 0, CURRENT_TIMESTAMP
    FROM unnest(${entries.map((entry) => entry.itemType)}::text[], ${entries.map((entry) => entry.partition)}::text[],
                ${entries.map((entry) => entry.sessionRotation)}::text[]) AS e(item_type, part, session)
    ON CONFLICT ("itemType", "partition") DO NOTHING
  `;
}

/**
 * Partitions whose manifest is missing, behind an epoch, or short of concepts.
 * An empty partition depends only on its item rotation's rows, so only its item
 * epoch (and whether it was empty) decides. `known` lets the caller supply what
 * it already read; an empty manifest must record epochs read before the plan.
 */
export async function partitionsNeedingBuild(
  client: Pick<ConceptTopKRefreshClient, '$queryRaw'>,
  planned: readonly PlannedPartition[],
  depth = CONCEPT_TOPK_DEPTH,
  known: {
    epochs?: ReadonlyMap<string, bigint>;
    manifests?: readonly ManifestRow[];
    conceptCounts?: ReadonlyMap<string, number>;
    now?: number;
  } = {},
): Promise<PlannedPartition[]> {
  if (planned.length === 0) return [];
  const manifests = known.manifests ?? await readManifests(client);
  const byKey = new Map(manifests.map((row) => [`${row.itemType}|${row.partition}`, row]));
  let current = known.epochs;
  if (!current) {
    const scopes = new Set<string>([CONCEPTS_SCOPE]);
    for (const entry of planned) scopes.add(itemScope(entry.itemType, parsePartitionKey(entry.partition).itemRotation));
    current = await readCandidatePoolEpochs(client, [...scopes]);
  }
  const conceptCounts = known.conceptCounts ?? await embeddedConceptCounts(client);
  return planned.filter((entry) => {
    const manifest = byKey.get(`${entry.itemType}|${entry.partition}`);
    if (!manifest) return true;
    const scope = itemScope(entry.itemType, parsePartitionKey(entry.partition).itemRotation);
    if (BigInt(manifest.itemEpoch) !== (current.get(scope) ?? BigInt(0))) return true;
    if (entry.empty) return manifest.localeClassCount !== 0;
    if (manifest.localeClassCount === 0) return true;
    if (BigInt(manifest.conceptEpoch) !== (current.get(CONCEPTS_SCOPE) ?? BigInt(0))) return true;
    if (manifest.topK < depth) return true;
    if (!((known.now ?? Date.now()) - new Date(manifest.builtAt).getTime() <= CONCEPT_TOPK_REBUILD_AGE_MS)) return true;
    return manifest.conceptCount !== (conceptCounts.get(entry.sessionRotation) ?? 0);
  });
}

/**
 * Write manifests for empty partitions (no locale classes, so no lists) and
 * drop any lists left from when they were not empty, in one transaction. The
 * epochs must have been read before the scan that found the pairs empty: a
 * change after that read moves the epoch past the one recorded here.
 */
async function writeEmptyPartitions(
  client: Pick<ConceptTopKRefreshClient, '$transaction'>,
  entries: readonly PlannedPartition[],
  epochs: ReadonlyMap<string, bigint>,
  depth: number,
): Promise<number> {
  if (entries.length === 0) return 0;
  const itemTypes = entries.map((entry) => entry.itemType);
  const partitions = entries.map((entry) => entry.partition);
  const sessions = entries.map((entry) => entry.sessionRotation);
  const itemEpochs = entries.map((entry) => String(
    epochs.get(itemScope(entry.itemType, parsePartitionKey(entry.partition).itemRotation)) ?? BigInt(0),
  ));
  const conceptEpoch = String(epochs.get(CONCEPTS_SCOPE) ?? BigInt(0));
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "ConceptTopKPartition"
        ("itemType", "partition", "sessionRotation", "localeClasses", "itemEpoch", "conceptEpoch",
         "topK", "conceptCount", "buildMs", "builtAt")
      SELECT e.item_type, e.part, e.session, '{}'::text[], e.item_epoch, ${conceptEpoch}::bigint,
             ${depth}, 0, 0, CURRENT_TIMESTAMP
      FROM unnest(${itemTypes}::text[], ${partitions}::text[], ${sessions}::text[], ${itemEpochs}::bigint[])
        AS e(item_type, part, session, item_epoch)
      ON CONFLICT ("itemType", "partition") DO UPDATE SET
        "sessionRotation" = EXCLUDED."sessionRotation",
        "localeClasses" = EXCLUDED."localeClasses",
        "itemEpoch" = EXCLUDED."itemEpoch",
        "conceptEpoch" = EXCLUDED."conceptEpoch",
        "topK" = EXCLUDED."topK",
        "conceptCount" = EXCLUDED."conceptCount",
        "buildMs" = EXCLUDED."buildMs",
        "builtAt" = EXCLUDED."builtAt"
    `;
    await tx.$executeRaw`
      DELETE FROM "ConceptTopKList" l
      USING unnest(${itemTypes}::text[], ${partitions}::text[]) AS e(item_type, part)
      WHERE l."itemType" = e.item_type AND l."partition" = e.part
    `;
  }, { timeout: 60_000, maxWait: 10_000 });
  return entries.length;
}

async function embeddedConceptCounts(
  client: Pick<ConceptTopKRefreshClient, '$queryRaw'>,
): Promise<Map<string, number>> {
  const rows = await client.$queryRaw<Array<{ rotation: string; n: number }>>`
    SELECT c.rotation, count(*)::int AS n
    FROM "Concept" c
    JOIN concept_embeddings ce ON ce.concept_id = c.id
    GROUP BY c.rotation
  `;
  return new Map(rows.map((row) => [row.rotation, Number(row.n)]));
}

/** Partitions whose last build failed within the cooldown, as `itemType|partition`. */
async function recentlyFailedPartitions(client: Pick<ConceptTopKRefreshClient, '$queryRaw'>): Promise<Set<string>> {
  const rows = await client.$queryRaw<Array<{ itemType: string; partition: string }>>`
    SELECT "itemType", "partition" FROM "ConceptTopKBuildFailure"
    WHERE "failedAt" > CURRENT_TIMESTAMP - ${CONCEPT_TOPK_FAILURE_COOLDOWN_MS} * interval '1 millisecond'
  `;
  return new Set(rows.map((row) => `${row.itemType}|${row.partition}`));
}

async function recordBuildFailure(
  client: Pick<ConceptTopKRefreshClient, '$executeRaw'>,
  entry: PlannedPartition,
  message: string,
): Promise<void> {
  try {
    await client.$executeRaw`
      INSERT INTO "ConceptTopKBuildFailure" ("itemType", "partition", "error", "failedAt")
      VALUES (${entry.itemType}, ${entry.partition}, ${message.slice(0, FAILURE_MESSAGE_LIMIT)}, CURRENT_TIMESTAMP)
      ON CONFLICT ("itemType", "partition") DO UPDATE SET
        "error" = EXCLUDED."error",
        "failedAt" = EXCLUDED."failedAt"
    `;
  } catch (error) {
    // The build failure is already reported; losing the cooldown only costs a retry.
    logger.warn('manifold.concept_topk could not record a build failure', { error: String(error) });
  }
}

/**
 * Rebuild one partition atomically. Returns 'locked' if another runner holds
 * it. A failure is recorded so the refresh skips the partition for the
 * cooldown; a success clears any such record in the same transaction.
 */
export async function buildConceptTopKPartition(
  client: Pick<ConceptTopKRefreshClient, '$transaction' | '$executeRaw'>,
  entry: PlannedPartition,
  depth = CONCEPT_TOPK_DEPTH,
  options: { deadlineAt?: number } = {},
): Promise<PartitionBuildResult> {
  const startedAt = Date.now();
  // No statement may outlast the caller's deadline; without one, the default.
  const budgetMs = options.deadlineAt === undefined ? undefined : Math.max(1_000, options.deadlineAt - startedAt);
  const statementTimeoutMs = Math.min(PARTITION_STATEMENT_TIMEOUT_MS, budgetMs ?? PARTITION_STATEMENT_TIMEOUT_MS);
  const transactionTimeoutMs = budgetMs === undefined ? PARTITION_TRANSACTION_TIMEOUT_MS : budgetMs + 5_000;
  const spec = ITEM_TABLES[entry.itemType];
  const { itemRotation } = parsePartitionKey(entry.partition);
  const scope = itemScope(entry.itemType, itemRotation);
  const lockKey = `concept_topk:${entry.itemType}:${entry.partition}`;
  try {
    const outcome = await client.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS locked
      `;
      if (!locked) return { outcome: 'locked' as const };
      // SET LOCAL, inside the transaction: a role default would not reach an
      // already-warm PgBouncer backend (see src/lib/db/statement-budget.ts).
      await setLocalLimits(tx, { statementTimeoutMs });

      // Epochs FIRST: a change that commits during the build leaves this
      // manifest behind and the partition is rebuilt on the next run.
      const epochs = await readCandidatePoolEpochs(tx, [scope, CONCEPTS_SCOPE]);
      const classRows = await tx.$queryRaw<Array<{ locale_class: string }>>`
        SELECT DISTINCT COALESCE(p."practiceLocale", ${NO_LOCALE_CLASS}) AS locale_class
        FROM ${spec.parent} p
        WHERE ${partitionPredicate(entry.partition)} AND ${spec.eligibility}
      `;
      const localeClasses = [...new Set([NO_LOCALE_CLASS, ...classRows.map((row) => row.locale_class)])].sort();

      await tx.$executeRaw`
        DELETE FROM "ConceptTopKList"
        WHERE "itemType" = ${entry.itemType} AND "partition" = ${entry.partition}
      `;
      for (const localeClass of localeClasses) {
        await tx.$executeRaw(conceptTopKListInsertSql({
          itemType: entry.itemType,
          partition: entry.partition,
          sessionRotation: entry.sessionRotation,
          localeClass,
          embeddingsTable: spec.embeddings,
          idColumn: spec.idColumn,
          parentTable: spec.parent,
          itemPredicate: Prisma.sql`${partitionPredicate(entry.partition)}
            AND ${localeClassPredicate(localeClass)}
            AND ${spec.eligibility}`,
          depth,
        }));
      }
      const [{ concepts }] = await tx.$queryRaw<Array<{ concepts: number }>>`
        SELECT count(*)::int AS concepts
        FROM "Concept" c
        JOIN concept_embeddings ce ON ce.concept_id = c.id
        WHERE c.rotation = ${entry.sessionRotation}
      `;
      const buildMs = Date.now() - startedAt;
      await tx.$executeRaw`
        INSERT INTO "ConceptTopKPartition"
          ("itemType", "partition", "sessionRotation", "localeClasses", "itemEpoch", "conceptEpoch",
           "topK", "conceptCount", "buildMs", "builtAt")
        VALUES (${entry.itemType}, ${entry.partition}, ${entry.sessionRotation}, ${localeClasses}::text[],
                ${epochs.get(scope) ?? BigInt(0)}, ${epochs.get(CONCEPTS_SCOPE) ?? BigInt(0)},
                ${depth}, ${concepts}, ${buildMs}, CURRENT_TIMESTAMP)
        ON CONFLICT ("itemType", "partition") DO UPDATE SET
          "sessionRotation" = EXCLUDED."sessionRotation",
          "localeClasses" = EXCLUDED."localeClasses",
          "itemEpoch" = EXCLUDED."itemEpoch",
          "conceptEpoch" = EXCLUDED."conceptEpoch",
          "topK" = EXCLUDED."topK",
          "conceptCount" = EXCLUDED."conceptCount",
          "buildMs" = EXCLUDED."buildMs",
          "builtAt" = EXCLUDED."builtAt"
      `;
      await tx.$executeRaw`
        DELETE FROM "ConceptTopKBuildFailure"
        WHERE "itemType" = ${entry.itemType} AND "partition" = ${entry.partition}
      `;
      return { outcome: 'built' as const, conceptCount: concepts, localeClasses };
    }, { timeout: transactionTimeoutMs, maxWait: 10_000 });
    return { ...entry, ...outcome, buildMs: Date.now() - startedAt };
  } catch (error) {
    logger.warn('manifold.concept_topk partition build failed', {
      itemType: entry.itemType,
      partition: entry.partition,
      error: String(error),
    });
    await recordBuildFailure(client, entry, String(error));
    return { ...entry, outcome: 'failed', buildMs: Date.now() - startedAt, error: String(error) };
  }
}

/**
 * Remove manifests and lists for partitions that are no longer planned, and
 * lists whose concept no longer belongs to the partition's session rotation.
 */
async function removeUnplannedPartitions(
  client: Pick<ConceptTopKRefreshClient, '$executeRaw'>,
  planned: readonly PlannedPartition[],
): Promise<number> {
  const keys = planned.map((entry) => `${entry.itemType}|${entry.partition}`);
  const removed = await client.$executeRaw`
    DELETE FROM "ConceptTopKPartition" m
    WHERE NOT ((m."itemType" || '|' || m."partition") = ANY(${keys}::text[]))
  `;
  await client.$executeRaw`
    DELETE FROM "ConceptTopKBuildFailure" f
    WHERE NOT ((f."itemType" || '|' || f."partition") = ANY(${keys}::text[]))
  `;
  await client.$executeRaw`
    DELETE FROM "ConceptTopKList" l
    WHERE NOT EXISTS (
      SELECT 1 FROM "ConceptTopKPartition" m
      WHERE m."itemType" = l."itemType" AND m."partition" = l."partition"
    )
    OR NOT EXISTS (
      SELECT 1 FROM "ConceptTopKPartition" m
      JOIN "Concept" c ON c.rotation = m."sessionRotation"
      WHERE m."itemType" = l."itemType" AND m."partition" = l."partition" AND c.id = l."conceptId"
    )
  `;
  return Number(removed);
}

/**
 * Collapse each scope's change rows into one row carrying their summed weight.
 * The epoch (the sum) is unchanged, and rows a concurrent transaction has not
 * committed yet are not touched.
 */
export async function compactCandidatePoolChanges(
  client: Pick<ConceptTopKRefreshClient, '$transaction'>,
): Promise<number> {
  return client.$transaction(async (tx) => {
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('concept_topk:compact', 0)) AS locked
    `;
    if (!locked) return 0;
    const scopes = await tx.$queryRaw<Array<{ scope: string; max_id: bigint }>>`
      SELECT scope, max(id) AS max_id FROM "CandidatePoolChange" GROUP BY scope HAVING count(*) > 1
    `;
    for (const { scope, max_id: maxId } of scopes) {
      await tx.$executeRaw`
        WITH gone AS (
          DELETE FROM "CandidatePoolChange"
          WHERE scope = ${scope} AND id <= ${maxId}
          RETURNING weight
        )
        INSERT INTO "CandidatePoolChange" ("scope", "weight")
        SELECT ${scope}, sum(weight) FROM gone HAVING count(*) > 0
      `;
    }
    return scopes.length;
  }, { timeout: CONCEPT_TOPK_COMPACTION_TIMEOUT_MS, maxWait: 10_000 });
}

/**
 * Bring the precomputed top-K up to date. Builds only what is missing or stale,
 * starts no partition with under PARTITION_MIN_BUDGET_MS left before the
 * deadline and lets none outlast it (the next run resumes), and never throws
 * for a single partition's failure.
 *
 * Refuses to build anything while a change-log trigger is missing or disabled:
 * a manifest's epochs would then never move again, and the read path would
 * treat lists that go stale as fresh.
 *
 * A run reads the small tables first (epochs, manifests, concept counts, the
 * last plan) and scans "Card" and "Question" to plan again only when
 * planMayHaveChanged says the plan can have moved; otherwise the manifests are
 * the plan. So a run with nothing changed touches only the small tables.
 */
export async function refreshConceptTopK(options: {
  client?: ConceptTopKRefreshClient;
  deadlineAt?: number;
  itemTypes?: readonly ConceptTopKItemType[];
  sessionRotations?: readonly string[];
  force?: boolean;
  depth?: number;
} = {}): Promise<ConceptTopKRefreshReport> {
  const client = options.client ?? prisma;
  const depth = options.depth ?? CONCEPT_TOPK_DEPTH;
  const startedAt = Date.now();
  const triggersMissing = describeTriggers(await missingConceptTopKTriggers(client));
  if (triggersMissing.length > 0) {
    logger.error('manifold.concept_topk refresh refused: change-log triggers missing', { missing: triggersMissing });
    return {
      planned: 0,
      needingBuild: 0,
      results: [],
      deadlineReached: false,
      removedPartitions: 0,
      compactedScopes: 0,
      durationMs: Date.now() - startedAt,
      triggersMissing,
      emptyPartitions: 0,
      pruneRefused: false,
      skippedAfterFailure: [],
      planReason: null,
    };
  }
  // The small tables. Epochs come BEFORE any scan of the parent tables: empty
  // manifests and the plan record are stamped with them, so a change landing
  // during the scan leaves both behind the current epochs.
  const epochs = await readAllCandidatePoolEpochs(client);
  const manifests = await readManifests(client);
  const conceptCounts = await embeddedConceptCounts(client);
  const sessionRotations = plannableSessionRotations(conceptCounts);
  const scoped = Boolean(options.itemTypes || options.sessionRotations);
  const planReason: PlanReason | null = scoped ? 'scoped' : options.force ? 'forced' : planMayHaveChanged({
    lastPlan: await readLastPlan(client),
    epochs,
    sessionRotations,
    manifestCount: manifests.length,
    now: startedAt,
  });
  const fullPlan = planReason !== null && !scoped;
  const planned = planReason === null
    ? manifests.map(manifestAsPlanned)
    : await planConceptTopKPartitions(client, {
      itemTypes: options.itemTypes,
      sessionRotations: options.sessionRotations,
    });
  const needing = options.force
    ? planned
    : await partitionsNeedingBuild(client, planned, depth, { epochs, manifests, conceptCounts, now: startedAt });
  // A full plan has just re-verified every empty pair, so all of them are
  // rewritten, which keeps them young; otherwise only those that changed.
  const emptyPartitions = await writeEmptyPartitions(
    client,
    (fullPlan ? planned : needing).filter((entry) => entry.empty),
    epochs,
    depth,
  );
  if (fullPlan) {
    const known = new Set(manifests.map((manifest) => `${manifest.itemType}|${manifest.partition}`));
    await writePendingManifests(
      client,
      planned.filter((entry) => !entry.empty && !known.has(`${entry.itemType}|${entry.partition}`)),
    );
  }
  // A partition that failed within the cooldown is left for a later run (a
  // forced run retries it): retrying it every run would spend the statement
  // ceiling on the same failure each time.
  const recentlyFailed = options.force ? new Set<string>() : await recentlyFailedPartitions(client);
  const skippedAfterFailure: string[] = [];
  const toBuild = needing.filter((entry) => {
    if (entry.empty) return false;
    if (!recentlyFailed.has(`${entry.itemType}|${entry.partition}`)) return true;
    skippedAfterFailure.push(`${entry.itemType}:${entry.partition}`);
    return false;
  });
  const results: PartitionBuildResult[] = [];
  let deadlineReached = false;
  for (const entry of toBuild) {
    if (options.deadlineAt !== undefined && options.deadlineAt - Date.now() < PARTITION_MIN_BUDGET_MS) {
      deadlineReached = true;
      break;
    }
    results.push(await buildConceptTopKPartition(client, entry, depth, { deadlineAt: options.deadlineAt }));
  }
  // Only a full plan may prune: a scoped run does not know the other rotations.
  // Nor may a plan that came back empty or under half the existing manifests:
  // that is far likelier a broken input (the concept vectors truncated, a
  // planning query gone wrong) than half the catalogue retired at once, and
  // pruning would throw away every list a recovery could otherwise reuse.
  const pruneRefused = fullPlan && manifests.length > 0
    && (planned.length === 0 || planned.length * 2 < manifests.length);
  if (pruneRefused) {
    logger.error('manifold.concept_topk refresh refused to prune: the plan shrank too far', {
      planned: planned.length,
      manifests: manifests.length,
    });
  }
  const removedPartitions = fullPlan && !pruneRefused ? await removeUnplannedPartitions(client, planned) : 0;
  // A refused prune is not recorded, so the next run plans again and notices
  // when the broken input recovers.
  if (fullPlan && !pruneRefused) {
    await recordPlan(client, {
      itemEpochTotal: itemEpochTotal(epochs),
      sessionRotations,
      partitionCount: planned.length,
    });
  }
  const compactedScopes = await compactCandidatePoolChanges(client);
  const report: ConceptTopKRefreshReport = {
    planned: planned.length,
    needingBuild: needing.length,
    results,
    deadlineReached,
    removedPartitions,
    compactedScopes,
    durationMs: Date.now() - startedAt,
    triggersMissing,
    emptyPartitions,
    pruneRefused,
    skippedAfterFailure,
    planReason,
  };
  logger.info('manifold.concept_topk refresh', {
    planReason,
    planned: report.planned,
    needingBuild: report.needingBuild,
    emptyPartitions,
    built: results.filter((r) => r.outcome === 'built').length,
    locked: results.filter((r) => r.outcome === 'locked').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    skippedAfterFailure: skippedAfterFailure.length,
    deadlineReached,
    removedPartitions,
    pruneRefused,
    compactedScopes,
    durationMs: report.durationMs,
  });
  return report;
}
