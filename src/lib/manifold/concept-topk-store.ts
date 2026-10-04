/**
 * Read path for the precomputed concept top-K
 * (docs/designs/2026-10-02-neon-scale.md, section 1).
 *
 * resolveConceptTopK serves the precomputed top-K where it is valid and runs the
 * live scoreItemsAgainstConceptsTopK for everything else. The precompute is an
 * exact search; the live query ranks the same items but is approximate whenever
 * the planner chooses the HNSW index, so the two can differ at the margin. On
 * the tested snapshot (an isolated branch, 2 October) they agreed for CAH,
 * PAAM, critical care and PWH, cards and questions. The live path is taken:
 *
 * - the whole request goes live for a cluster-scoped session, a learner who
 *   owns private cards, open cross-source mapping, MD3_CONCEPT_TOPK=live,
 *   missing change-log triggers, or any store error (including the tables not
 *   existing yet);
 * - a partition whose manifest is behind the current epochs is stale, and the
 *   request goes live until the refresh rebuilds it;
 * - a concept with no list (a concept embedded after the last build) is
 *   computed live on its own and merged.
 *
 * Epochs are memoised per isolate for 30 s; a partition's lists are memoised
 * keyed by the epochs they were built from, so a warm isolate reads nothing
 * from the database for top-K.
 *
 * Epochs only move while the change-log triggers exist, so the trigger check
 * (concept-topk-triggers.ts) is memoised with them: while any trigger is
 * missing or disabled, nothing is served precomputed and no cache key is
 * issued, and the first detection in an isolate is logged as an error.
 *
 * Stale-if-error: the store is most likely to fail when the database is under
 * load, the worst moment to send every build to the live query. So when the
 * epochs, manifests or private-card probe cannot be read, the lists this
 * isolate last validated stay servable for CONCEPT_TOPK_STALE_IF_ERROR_MS after
 * that validation, a partition it never loaded goes live, and the store is not
 * queried again for CONCEPT_TOPK_STORE_BACKOFF_MS.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { findFirstCard, ownerPrivateOrSharedCardScope } from '@/lib/cards/read-repository.server';
import { describeTriggers, missingConceptTopKTriggers } from './concept-topk-triggers';
import {
  conceptTopKPartitionsFor,
  localeClassesFor,
  mergeTopKLists,
  parsePartitionKey,
  type ConceptTopKItemType,
  type ConceptTopKList,
  type ConceptTopKMappingMode,
} from './concept-topk';

export const CONCEPT_TOPK_EPOCH_TTL_MS = 30_000;
export const CONCEPT_TOPK_PRIVATE_CARD_TTL_MS = 5 * 60_000;
/** After a failed store read, the store is not queried again for this long. */
export const CONCEPT_TOPK_STORE_BACKOFF_MS = 15_000;
/** How long after its last validation a list may still be served while the store fails. */
export const CONCEPT_TOPK_STALE_IF_ERROR_MS = 5 * 60_000;
/**
 * A manifest older than this is not served whatever its epochs say, so any
 * invalidation path the triggers miss is bounded. The refresh rebuilds well
 * before it (CONCEPT_TOPK_REBUILD_AGE_MS).
 */
export const CONCEPT_TOPK_MAX_MANIFEST_AGE_MS = 26 * 60 * 60_000;
export const CONCEPT_TOPK_LIST_CACHE_ENTRIES = 32;
const CONCEPTS_SCOPE = 'concepts';

type StoreClient = Pick<typeof prisma, '$queryRaw'>;

export type ConceptTopKScores = Map<string, Map<string, number>>;

export interface ResolveConceptTopKInput {
  itemType: ConceptTopKItemType;
  sessionRotation: string;
  /** Concepts to score: those with an embedding (the live query's input). */
  conceptIds: readonly string[];
  allowedCrossSourceRotations: readonly string[];
  crossSourceMappingMode: ConceptTopKMappingMode;
  practiceLocale: string;
  topK: number;
  /** A cluster narrowing: the precompute is rotation-wide, so it cannot serve one. */
  clusterId?: string | null;
  /** The learner, for cards: owner-private cards are outside the precompute. */
  ownerUserId?: string | null;
  /** The live query for a subset of the concepts. */
  live: (conceptIds: readonly string[]) => Promise<ConceptTopKScores>;
  client?: StoreClient;
}

export interface ResolveConceptTopKResult {
  scores: ConceptTopKScores;
  source: 'precomputed' | 'live' | 'mixed';
  fallbackReason: string | null;
  liveConceptCount: number;
}

interface ManifestRow {
  itemType: string;
  partition: string;
  localeClasses: string[];
  itemEpoch: bigint | number | string;
  conceptEpoch: bigint | number | string;
  topK: number;
  builtAt: Date | string;
}

interface PartitionLists {
  /** conceptId → localeClass → list */
  byConcept: Map<string, Map<string, ConceptTopKList>>;
  localeClasses: string[];
  /** Depth the partition was built to (its manifest's topK). */
  depth: number;
  /** No eligible item maps into the session rotation: it contributes nothing. */
  empty: boolean;
  /** When the manifest was built (ms); past CONCEPT_TOPK_MAX_MANIFEST_AGE_MS it is not served. */
  builtAt: number;
}

const epochCache = new Map<string, { epoch: bigint; at: number }>();
/** The last private-card answer per learner, and when it was read. */
const privateCardCache = new Map<string, { has: boolean; at: number }>();
const listCache = new Map<string, PartitionLists>();
let triggerCheck: { missing: string[]; at: number } | null = null;
let missingTriggersLogged = false;
let storeBackoffUntil = 0;

/** Test seam: forget everything memoised in this isolate. */
export function resetConceptTopKStoreCaches(): void {
  epochCache.clear();
  privateCardCache.clear();
  listCache.clear();
  triggerCheck = null;
  missingTriggersLogged = false;
  storeBackoffUntil = 0;
}

function configuredMode(): 'precomputed' | 'live' {
  return process.env.MD3_CONCEPT_TOPK?.trim().toLowerCase() === 'live' ? 'live' : 'precomputed';
}

function shadowRate(): number {
  const raw = Number(process.env.MD3_CONCEPT_TOPK_SHADOW_RATE ?? 0);
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

async function currentEpochs(client: StoreClient, scopes: readonly string[], now: number): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  const missing: string[] = [];
  for (const scope of new Set(scopes)) {
    const cached = epochCache.get(scope);
    if (cached && now - cached.at <= CONCEPT_TOPK_EPOCH_TTL_MS) result.set(scope, cached.epoch);
    else missing.push(scope);
  }
  if (missing.length > 0) {
    const rows = await client.$queryRaw<Array<{ scope: string; epoch: bigint | number | string }>>`
      SELECT s.scope, COALESCE((
        SELECT sum(c.weight) FROM "CandidatePoolChange" c WHERE c.scope = s.scope
      ), 0)::bigint AS epoch
      FROM unnest(${missing}::text[]) AS s(scope)
    `;
    for (const row of rows) {
      const epoch = BigInt(row.epoch);
      epochCache.set(row.scope, { epoch, at: now });
      result.set(row.scope, epoch);
    }
  }
  return result;
}

/** The change-log triggers that are missing or disabled; memoised like an epoch. */
async function readMissingTriggers(client: StoreClient, now: number): Promise<string[]> {
  if (triggerCheck && now - triggerCheck.at <= CONCEPT_TOPK_EPOCH_TTL_MS) return triggerCheck.missing;
  const missing = describeTriggers(await missingConceptTopKTriggers(client));
  triggerCheck = { missing, at: now };
  if (missing.length > 0 && !missingTriggersLogged) {
    missingTriggersLogged = true;
    logger.error('manifold.concept_topk change-log triggers missing: precomputed top-K and cached pools are off', {
      missing,
    });
  }
  return missing;
}

interface StoreSnapshot {
  epochs: Map<string, bigint>;
  missingTriggers: string[];
}

/** Current epochs and trigger state, each memoised for the epoch TTL; throws if unreadable. */
async function readSnapshot(client: StoreClient, scopes: readonly string[], now: number): Promise<StoreSnapshot> {
  const [epochs, missingTriggers] = await Promise.all([
    currentEpochs(client, scopes, now),
    readMissingTriggers(client, now),
  ]);
  return { epochs, missingTriggers };
}

/**
 * The epochs and trigger state as this isolate last read them, when every part
 * was read within the stale-if-error window; null otherwise.
 */
function lastSnapshot(scopes: readonly string[], now: number): StoreSnapshot | null {
  if (!triggerCheck || now - triggerCheck.at > CONCEPT_TOPK_STALE_IF_ERROR_MS) return null;
  const epochs = new Map<string, bigint>();
  for (const scope of new Set(scopes)) {
    const cached = epochCache.get(scope);
    if (!cached || now - cached.at > CONCEPT_TOPK_STALE_IF_ERROR_MS) return null;
    epochs.set(scope, cached.epoch);
  }
  return { epochs, missingTriggers: triggerCheck.missing };
}

/**
 * Whether the learner owns any non-deleted private card. Shared, precomputed
 * and cached candidate data covers the shared catalog only, so such a learner
 * is served by the live queries. Only a yes is memoised (five minutes): a
 * stale yes merely keeps the learner on the live path, which is always
 * correct, while a stale no would hide their first private card. A no is
 * re-read every time; the query is an indexed probe. If the probe fails, or the
 * store is backing off, an answer read within the stale-if-error window stands
 * in; with none, it throws and the caller treats the learner as live.
 */
export async function learnerOwnsPrivateCards(ownerUserId: string): Promise<boolean> {
  return ownerHasPrivateCards(ownerUserId, Date.now());
}

/**
 * A stable tag for the current epochs of `scopes` (e.g. 'card:cah'), for
 * keying caches of eligibility-dependent data; null when the change log cannot
 * be read or its triggers are missing, in which case the caller must not cache.
 */
export async function candidatePoolEpochTag(
  scopes: readonly string[],
  client: StoreClient = prisma,
): Promise<string | null> {
  try {
    const { epochs, missingTriggers } = await readSnapshot(client, scopes, Date.now());
    if (missingTriggers.length > 0) return null;
    return [...new Set(scopes)].sort().map((scope) => `${scope}=${epochs.get(scope) ?? BigInt(0)}`).join('|');
  } catch {
    return null;
  }
}

async function ownerHasPrivateCards(ownerUserId: string, now: number): Promise<boolean> {
  const known = privateCardCache.get(ownerUserId);
  if (known?.has && now - known.at <= CONCEPT_TOPK_PRIVATE_CARD_TTL_MS) return true;
  const recent = known && now - known.at <= CONCEPT_TOPK_STALE_IF_ERROR_MS ? known.has : null;
  if (now < storeBackoffUntil) {
    if (recent !== null) return recent;
    throw new Error('concept top-K store is backing off after a failed read');
  }
  try {
    const card = await findFirstCard(ownerPrivateOrSharedCardScope(ownerUserId), {
      where: { ownerUserId, deletedAt: null },
      select: { id: true },
    });
    const has = card !== null;
    privateCardCache.set(ownerUserId, { has, at: now });
    return has;
  } catch (error) {
    storeBackoffUntil = now + CONCEPT_TOPK_STORE_BACKOFF_MS;
    if (recent !== null) return recent;
    throw error;
  }
}

function listCacheKey(itemType: string, partition: string, itemEpoch: bigint, conceptEpoch: bigint): string {
  return `${itemType}|${partition}|${itemEpoch}|${conceptEpoch}`;
}

function rememberLists(key: string, lists: PartitionLists): void {
  listCache.delete(key);
  listCache.set(key, lists);
  while (listCache.size > CONCEPT_TOPK_LIST_CACHE_ENTRIES) {
    const oldest = listCache.keys().next().value;
    if (oldest === undefined) break;
    listCache.delete(oldest);
  }
}

async function loadPartitionLists(
  client: StoreClient,
  itemType: string,
  partition: string,
  localeClasses: string[],
  depth: number,
  builtAt: number,
): Promise<PartitionLists> {
  const rows = await client.$queryRaw<Array<{
    conceptId: string;
    localeClass: string;
    itemIds: string[];
    similarities: number[];
  }>>`
    SELECT "conceptId", "localeClass", "itemIds", "similarities"
    FROM "ConceptTopKList"
    WHERE "itemType" = ${itemType} AND "partition" = ${partition}
  `;
  const byConcept = new Map<string, Map<string, ConceptTopKList>>();
  for (const row of rows) {
    let classes = byConcept.get(row.conceptId);
    if (!classes) {
      classes = new Map();
      byConcept.set(row.conceptId, classes);
    }
    classes.set(row.localeClass, {
      itemIds: row.itemIds,
      similarities: row.similarities.map(Number),
    });
  }
  return { byConcept, localeClasses, depth, empty: false, builtAt };
}

/** An empty partition's manifest has no locale classes and it has no lists to read. */
function emptyPartition(builtAt: number): PartitionLists {
  return { byConcept: new Map(), localeClasses: [], depth: Number.POSITIVE_INFINITY, empty: true, builtAt };
}

type PrecomputedOutcome =
  | {
    kind: 'served';
    scores: ConceptTopKScores;
    missingConceptIds: string[];
    /** Set when served from lists validated earlier because the store could not be read. */
    staleIfError: 'store-error' | 'store-backoff' | null;
  }
  | { kind: 'fallback'; reason: string };

function noteStoreFailure(error: unknown, now: number, servingLastValidated: boolean): void {
  storeBackoffUntil = now + CONCEPT_TOPK_STORE_BACKOFF_MS;
  logger.warn('manifold.concept_topk store unavailable', { error: String(error), servingLastValidated });
}

async function readPrecomputed(input: ResolveConceptTopKInput, now: number): Promise<PrecomputedOutcome> {
  const client = input.client ?? prisma;
  const partitions = conceptTopKPartitionsFor({
    sessionRotation: input.sessionRotation,
    allowedCrossSourceRotations: input.allowedCrossSourceRotations,
    mappingMode: input.crossSourceMappingMode,
  });
  if (!partitions) return { kind: 'fallback', reason: 'open-cross-source' };

  const scopeFor = (partition: string) => `${input.itemType}:${parsePartitionKey(partition).itemRotation}`;
  const scopes = [...partitions.map(scopeFor), CONCEPTS_SCOPE];
  let snapshot: StoreSnapshot;
  let staleIfError: 'store-error' | 'store-backoff' | null = null;
  if (now < storeBackoffUntil) {
    const last = lastSnapshot(scopes, now);
    if (!last) return { kind: 'fallback', reason: 'store-backoff' };
    snapshot = last;
    staleIfError = 'store-backoff';
  } else {
    try {
      snapshot = await readSnapshot(client, scopes, now);
    } catch (error) {
      const last = lastSnapshot(scopes, now);
      noteStoreFailure(error, now, last !== null);
      if (!last) return { kind: 'fallback', reason: 'store-error' };
      snapshot = last;
      staleIfError = 'store-error';
    }
  }
  if (snapshot.missingTriggers.length > 0) return { kind: 'fallback', reason: 'triggers-missing' };
  const { epochs } = snapshot;
  const conceptEpoch = epochs.get(CONCEPTS_SCOPE) ?? BigInt(0);
  const keyFor = (partition: string) => listCacheKey(
    input.itemType,
    partition,
    epochs.get(scopeFor(partition)) ?? BigInt(0),
    conceptEpoch,
  );

  // Lists are cached only after their manifest validated against these exact
  // epochs, so a cache hit needs no manifest read at all.
  const uncached = partitions.filter((partition) => !listCache.has(keyFor(partition)));
  if (uncached.length > 0) {
    // Never loaded under these epochs: while the store fails there is nothing
    // validated to fall back on, so this request goes live.
    if (staleIfError) return { kind: 'fallback', reason: staleIfError };
    try {
      const manifests = await client.$queryRaw<ManifestRow[]>`
        SELECT "itemType", "partition", "localeClasses", "itemEpoch", "conceptEpoch", "topK", "builtAt"
        FROM "ConceptTopKPartition"
        WHERE "itemType" = ${input.itemType} AND "partition" = ANY(${uncached}::text[])
      `;
      const manifestByPartition = new Map(manifests.map((row) => [row.partition, row]));
      for (const partition of uncached) {
        const manifest = manifestByPartition.get(partition);
        if (!manifest) return { kind: 'fallback', reason: 'partition-missing' };
        const itemEpoch = epochs.get(scopeFor(partition)) ?? BigInt(0);
        if (BigInt(manifest.itemEpoch) !== itemEpoch) return { kind: 'fallback', reason: 'partition-stale' };
        const builtAt = new Date(manifest.builtAt).getTime();
        if (!(now - builtAt <= CONCEPT_TOPK_MAX_MANIFEST_AGE_MS)) return { kind: 'fallback', reason: 'partition-expired' };
        // An empty partition depends only on its item rotation's rows.
        if (manifest.localeClasses.length === 0) {
          rememberLists(keyFor(partition), emptyPartition(builtAt));
          continue;
        }
        if (BigInt(manifest.conceptEpoch) !== conceptEpoch) return { kind: 'fallback', reason: 'partition-stale' };
        if (manifest.topK < input.topK) return { kind: 'fallback', reason: 'partition-too-shallow' };
        rememberLists(keyFor(partition), await loadPartitionLists(
          client,
          input.itemType,
          partition,
          manifest.localeClasses,
          manifest.topK,
          builtAt,
        ));
      }
    } catch (error) {
      noteStoreFailure(error, now, false);
      return { kind: 'fallback', reason: 'store-error' };
    }
  }

  const partitionLists: PartitionLists[] = [];
  for (const partition of partitions) {
    const key = keyFor(partition);
    const lists = listCache.get(key);
    if (!lists) return { kind: 'fallback', reason: 'partition-evicted' };
    if (!(now - lists.builtAt <= CONCEPT_TOPK_MAX_MANIFEST_AGE_MS)) return { kind: 'fallback', reason: 'partition-expired' };
    if (lists.depth < input.topK) return { kind: 'fallback', reason: 'partition-too-shallow' };
    rememberLists(key, lists);
    partitionLists.push(lists);
  }

  const wantedClasses = localeClassesFor(input.practiceLocale);
  const scores: ConceptTopKScores = new Map();
  const missingConceptIds: string[] = [];
  for (const conceptId of input.conceptIds) {
    const pieces: ConceptTopKList[] = [];
    let complete = true;
    for (const lists of partitionLists) {
      if (lists.empty) continue;
      const classes = lists.byConcept.get(conceptId);
      if (!classes) {
        complete = false;
        break;
      }
      for (const localeClass of wantedClasses) {
        // A class the partition has no items in was never built: it is empty.
        if (!lists.localeClasses.includes(localeClass)) continue;
        const list = classes.get(localeClass);
        if (!list) {
          complete = false;
          break;
        }
        pieces.push(list);
      }
      if (!complete) break;
    }
    if (!complete) {
      missingConceptIds.push(conceptId);
      continue;
    }
    scores.set(conceptId, mergeTopKLists(pieces, input.topK));
  }
  return { kind: 'served', scores, missingConceptIds, staleIfError };
}

async function runShadowComparison(input: ResolveConceptTopKInput, served: ConceptTopKScores): Promise<void> {
  const live = await input.live(input.conceptIds);
  let identical = 0;
  let minOverlap = 1;
  let sumOverlap = 0;
  for (const conceptId of input.conceptIds) {
    const a = served.get(conceptId) ?? new Map<string, number>();
    const b = live.get(conceptId) ?? new Map<string, number>();
    const shared = [...a.keys()].filter((id) => b.has(id)).length;
    const overlap = a.size === 0 && b.size === 0 ? 1 : shared / Math.max(a.size, b.size);
    if (overlap === 1 && a.size === b.size) identical += 1;
    minOverlap = Math.min(minOverlap, overlap);
    sumOverlap += overlap;
  }
  logger.info('manifold.concept_topk shadow', {
    itemType: input.itemType,
    rotation: input.sessionRotation,
    concepts: input.conceptIds.length,
    identical,
    minOverlap: Number(minOverlap.toFixed(4)),
    meanOverlap: Number((sumOverlap / Math.max(1, input.conceptIds.length)).toFixed(4)),
  });
}

export async function resolveConceptTopK(input: ResolveConceptTopKInput): Promise<ResolveConceptTopKResult> {
  const startedAt = Date.now();
  const goLive = async (reason: string): Promise<ResolveConceptTopKResult> => {
    const scores = await input.live(input.conceptIds);
    logger.info('manifold.concept_topk', {
      itemType: input.itemType,
      rotation: input.sessionRotation,
      source: 'live',
      fallbackReason: reason,
      concepts: input.conceptIds.length,
      durationMs: Date.now() - startedAt,
    });
    return { scores, source: 'live', fallbackReason: reason, liveConceptCount: input.conceptIds.length };
  };

  if (input.conceptIds.length === 0 || input.topK <= 0) {
    return { scores: new Map(), source: 'precomputed', fallbackReason: null, liveConceptCount: 0 };
  }
  if (configuredMode() === 'live') return goLive('configured-live');
  if (input.clusterId) return goLive('cluster-scope');

  let outcome: PrecomputedOutcome;
  try {
    // A failed probe with no recent answer throws: unknown ownership is live.
    if (input.itemType === 'card' && input.ownerUserId && await ownerHasPrivateCards(input.ownerUserId, startedAt)) {
      return goLive('private-cards');
    }
    outcome = await readPrecomputed(input, startedAt);
  } catch (error) {
    logger.warn('manifold.concept_topk precompute unusable; serving live', { error: String(error) });
    return goLive('store-error');
  }
  if (outcome.kind === 'fallback') return goLive(outcome.reason);

  const { scores, missingConceptIds, staleIfError } = outcome;
  if (missingConceptIds.length > 0) {
    const liveScores = await input.live(missingConceptIds);
    for (const conceptId of missingConceptIds) {
      scores.set(conceptId, liveScores.get(conceptId) ?? new Map());
    }
  }
  const source = missingConceptIds.length > 0 ? 'mixed' : 'precomputed';
  logger.info('manifold.concept_topk', {
    itemType: input.itemType,
    rotation: input.sessionRotation,
    source,
    concepts: input.conceptIds.length,
    liveConcepts: missingConceptIds.length,
    durationMs: Date.now() - startedAt,
    ...(staleIfError ? { staleIfError } : {}),
  });
  // No shadow query while the store is failing: that is load the database
  // cannot spare.
  if (!staleIfError && shadowRate() > 0 && Math.random() < shadowRate()) {
    try {
      await runShadowComparison(input, scores);
    } catch (error) {
      logger.warn('manifold.concept_topk shadow failed', { error: String(error) });
    }
  }
  return { scores, source, fallbackReason: null, liveConceptCount: missingConceptIds.length };
}
