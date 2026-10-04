/**
 * Precomputed concept top-K: the pure part.
 *
 * The scheduler's concept top-K (scoreItemsAgainstConceptsTopK) depends on the
 * concept, the item set and the item vectors, and on nothing about the learner
 * except owner-private cards and a cluster narrowing. So it is precomputed per
 * (item type, concept, partition, locale class) and merged at read time:
 *
 *   partition "S"    every shared item whose rotation is S (home sessions of S)
 *   partition "S>R"  shared items of rotation S mapped into session rotation R
 *                    (R = ANY(moduleNodes)): adjacent cross-source mapping
 *   locale class     "none" (practiceLocale IS NULL) or the literal locale
 *
 * The top-K of a union of disjoint sets is contained in the union of each
 * set's top-K, so merging the exact lists for a session's partitions and its
 * two locale classes gives the exact top-K of the session's item set. The live
 * query ranks the same set but is approximate whenever the planner chooses the
 * HNSW index, so the two can differ at the margin; on the tested snapshot they
 * agreed for CAH, PAAM, critical care and PWH, cards and questions. The design
 * and that measurement are in docs/designs/2026-10-02-neon-scale.md.
 */

export type ConceptTopKItemType = 'card' | 'question';
export type ConceptTopKMappingMode = 'adjacent' | 'open';

/** The class for items with no practiceLocale. Never a real locale code. */
export const NO_LOCALE_CLASS = 'none';

const PARTITION_SEPARATOR = '>';

function assertRotationName(rotation: string): void {
  if (!rotation || rotation.includes(PARTITION_SEPARATOR) || rotation.trim() !== rotation) {
    throw new TypeError(`Not a usable rotation name for a top-K partition: ${JSON.stringify(rotation)}`);
  }
}

export function homePartitionKey(rotation: string): string {
  assertRotationName(rotation);
  return rotation;
}

export function adjacentPartitionKey(itemRotation: string, sessionRotation: string): string {
  assertRotationName(itemRotation);
  assertRotationName(sessionRotation);
  return `${itemRotation}${PARTITION_SEPARATOR}${sessionRotation}`;
}

export function parsePartitionKey(key: string): { itemRotation: string; mappedTo: string | null } {
  const parts = key.split(PARTITION_SEPARATOR);
  if (parts.length === 1) return { itemRotation: parts[0], mappedTo: null };
  if (parts.length === 2 && parts[0] && parts[1]) return { itemRotation: parts[0], mappedTo: parts[1] };
  throw new TypeError(`Malformed top-K partition key: ${JSON.stringify(key)}`);
}

/**
 * The partitions whose lists, merged, give a session's top-K; null when the
 * precomputed pool cannot serve the session and the live query must run.
 *
 * Open mapping admits every item of an entitled rotation for the session's
 * concepts. Lists for "concept of R over all of S" are not built, so an open
 * session with any cross-source rotation is not servable from the pool.
 */
export function conceptTopKPartitionsFor(input: {
  sessionRotation: string;
  allowedCrossSourceRotations: readonly string[];
  mappingMode: ConceptTopKMappingMode;
}): string[] | null {
  const { sessionRotation, mappingMode } = input;
  const crossSource = [...new Set(input.allowedCrossSourceRotations)]
    .filter((rotation) => rotation !== sessionRotation);
  if (crossSource.length === 0) return [homePartitionKey(sessionRotation)];
  if (mappingMode === 'open') return null;
  return [
    homePartitionKey(sessionRotation),
    ...crossSource.map((rotation) => adjacentPartitionKey(rotation, sessionRotation)),
  ];
}

/** Items with no locale serve every learner; the learner's own locale is added. */
export function localeClassesFor(practiceLocale: string): string[] {
  if (!practiceLocale || practiceLocale === NO_LOCALE_CLASS) {
    throw new TypeError(`Not a practice locale: ${JSON.stringify(practiceLocale)}`);
  }
  return [NO_LOCALE_CLASS, practiceLocale];
}

export interface ConceptTopKList {
  readonly itemIds: readonly string[];
  readonly similarities: readonly number[];
}

/**
 * Top-K of the union of several lists for one concept, highest similarity
 * first, ties broken by item id (the precompute's own order). An item can sit
 * in only one partition and one locale class, but a duplicate is tolerated and
 * keeps its highest similarity.
 */
export function mergeTopKLists(lists: readonly ConceptTopKList[], topK: number): Map<string, number> {
  const best = new Map<string, number>();
  for (const list of lists) {
    if (list.itemIds.length !== list.similarities.length) {
      throw new TypeError('A top-K list must have one similarity per item id');
    }
    for (let i = 0; i < list.itemIds.length; i++) {
      const id = list.itemIds[i];
      const similarity = list.similarities[i];
      const previous = best.get(id);
      if (previous === undefined || similarity > previous) best.set(id, similarity);
    }
  }
  const ranked = [...best.entries()].sort((a, b) => (
    b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  ));
  return new Map(ranked.slice(0, Math.max(0, topK)));
}
