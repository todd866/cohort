/**
 * Local Subspace Runtime Module
 *
 * Loads PCA subspaces per concept and provides functions for:
 * - Projecting items into local 32D space
 * - Computing gap directions between knowledge and content centroid
 * - Ranking candidates by alignment with the gap direction
 *
 * This is Layer 2 of the embedding architecture:
 * Layer 1 (Global, 1024D) → cross-concept routing
 * Layer 2 (Local, 32D PCA) → within-concept fine-grained ranking
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// =============================================================================
// Types
// =============================================================================

export interface ConceptSubspace {
  conceptId: string;
  mean: number[];      // 1024D PCA mean (for centering before projection)
  basis: number[][];   // k×1024 principal components
  localCentroid: number[]; // k-D centroid (mean of all projected items)
  itemCount: number;
}

interface SubspaceRow {
  concept_id: string;
  pca_mean: number[];
  pca_basis: number[][];
  local_centroid: number[];
  item_count: number;
}

// =============================================================================
// Cache (1h TTL, same pattern as exam-target)
// =============================================================================

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const subspaceCache = new Map<string, { data: ConceptSubspace | null; ts: number }>();

/** Clear the subspace cache (for testing). */
export function clearSubspaceCache(): void {
  subspaceCache.clear();
}

function getCached(conceptId: string): ConceptSubspace | null | undefined {
  const entry = subspaceCache.get(conceptId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    subspaceCache.delete(conceptId);
    return undefined;
  }
  return entry.data;
}

function setCache(conceptId: string, data: ConceptSubspace | null): void {
  subspaceCache.set(conceptId, { data, ts: Date.now() });
}

// =============================================================================
// Data loading
// =============================================================================

/**
 * Load a single concept's PCA subspace. Returns null if no subspace exists.
 * Results are cached for 1 hour.
 */
export async function loadConceptSubspace(
  conceptId: string
): Promise<ConceptSubspace | null> {
  const cached = getCached(conceptId);
  if (cached !== undefined) return cached;

  try {
    const rows = await prisma.$queryRaw<SubspaceRow[]>`
      SELECT concept_id, pca_mean, pca_basis, local_centroid, item_count
      FROM concept_subspaces
      WHERE concept_id = ${conceptId}
      LIMIT 1
    `;

    if (rows.length === 0) {
      setCache(conceptId, null);
      return null;
    }

    const row = rows[0];
    const subspace: ConceptSubspace = {
      conceptId: row.concept_id,
      mean: row.pca_mean,
      basis: row.pca_basis,
      localCentroid: row.local_centroid,
      itemCount: row.item_count,
    };

    setCache(conceptId, subspace);
    return subspace;
  } catch {
    setCache(conceptId, null);
    return null;
  }
}

/**
 * Batch-load subspaces for multiple concepts in a single query.
 * Returns a Map of conceptId → ConceptSubspace.
 */
export async function batchLoadSubspaces(
  conceptIds: string[]
): Promise<Map<string, ConceptSubspace>> {
  const result = new Map<string, ConceptSubspace>();
  if (conceptIds.length === 0) return result;

  // Check cache first
  const uncached: string[] = [];
  for (const id of conceptIds) {
    const cached = getCached(id);
    if (cached !== undefined) {
      if (cached) result.set(id, cached);
    } else {
      uncached.push(id);
    }
  }

  if (uncached.length === 0) return result;

  try {
    const rows = await prisma.$queryRaw<SubspaceRow[]>`
      SELECT concept_id, pca_mean, pca_basis, local_centroid, item_count
      FROM concept_subspaces
      WHERE concept_id = ANY(${uncached}::text[])
    `;

    const found = new Set<string>();
    for (const row of rows) {
      const subspace: ConceptSubspace = {
        conceptId: row.concept_id,
        mean: row.pca_mean,
        basis: row.pca_basis,
        localCentroid: row.local_centroid,
        itemCount: row.item_count,
      };
      result.set(row.concept_id, subspace);
      setCache(row.concept_id, subspace);
      found.add(row.concept_id);
    }

    // Cache misses as null
    for (const id of uncached) {
      if (!found.has(id)) {
        setCache(id, null);
      }
    }
  } catch (error) {
    logger.warn('Failed to batch-load concept subspaces', { error: String(error) });
  }

  return result;
}

// =============================================================================
// Pure functions
// =============================================================================

/**
 * Compute the gap direction from the user's current local knowledge
 * toward the concept's content centroid.
 *
 * Returns a normalized vector pointing from localKnowledge → localTarget.
 * If they're identical, returns a zero vector (no gap).
 */
export function computeLocalGapDirection(
  localTarget: number[],
  localKnowledge: number[]
): number[] {
  const k = localTarget.length;
  const gap = new Array<number>(k);

  let normSq = 0;
  for (let i = 0; i < k; i++) {
    gap[i] = localTarget[i] - localKnowledge[i];
    normSq += gap[i] * gap[i];
  }

  const norm = Math.sqrt(normSq);
  if (norm < 1e-15) {
    return new Array(k).fill(0);
  }

  for (let i = 0; i < k; i++) {
    gap[i] /= norm;
  }

  return gap;
}

/**
 * Rank candidate questions by their cosine alignment with the gap direction.
 *
 * Items whose local projection aligns most with the gap direction
 * (i.e., they cover content the user hasn't seen) rank highest.
 *
 * @param candidateProjections - Map of questionId → local k-D projection
 * @param localGap - normalized k-D gap direction
 * @returns Sorted array, highest gapAlignment first
 */
export function rankByLocalGap(
  candidateProjections: Map<string, number[]>,
  localGap: number[]
): Array<{ id: string; gapAlignment: number }> {
  const gapNorm = Math.sqrt(localGap.reduce((s, x) => s + x * x, 0));

  if (gapNorm < 1e-15) {
    // No gap → all items have zero alignment
    return Array.from(candidateProjections.entries()).map(([id]) => ({
      id,
      gapAlignment: 0,
    }));
  }

  const results: Array<{ id: string; gapAlignment: number }> = [];

  for (const [id, proj] of candidateProjections) {
    const projNorm = Math.sqrt(proj.reduce((s, x) => s + x * x, 0));
    if (projNorm < 1e-15) {
      results.push({ id, gapAlignment: 0 });
      continue;
    }

    let dot = 0;
    for (let i = 0; i < localGap.length; i++) {
      dot += localGap[i] * proj[i];
    }

    results.push({ id, gapAlignment: dot / (gapNorm * projNorm) });
  }

  results.sort((a, b) => b.gapAlignment - a.gapAlignment);
  return results;
}
