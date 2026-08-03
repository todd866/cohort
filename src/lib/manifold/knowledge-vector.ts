/**
 * User Knowledge Vector
 *
 * Computes a user's current knowledge state as a vector in embedding space.
 * Each concept contributes to the vector weighted by its recall probability,
 * so the vector points toward content the user knows well.
 *
 * The gap between the exam target centroid and this knowledge vector
 * reveals what the user needs to study.
 */

import { prisma } from '@/lib/prisma';
import { batchLoadConceptEmbeddings } from '@/lib/manifold/similarity';
import { applyDecay } from '@/lib/knowledge/state';
import { l2Normalize, truncateToManifoldDim } from './exam-target';

// =============================================================================
// Pure functions (exported for testing)
// =============================================================================

/**
 * Compute a weighted centroid from embedding + weight pairs.
 * Result is L2-normalized. Returns empty array for empty input.
 */
export function computeWeightedCentroid(
  entries: Array<{ embedding: number[]; weight: number }>
): number[] {
  if (entries.length === 0) return [];

  const dim = entries[0].embedding.length;
  const weighted = new Array(dim).fill(0);
  let totalWeight = 0;

  for (const { embedding, weight } of entries) {
    for (let i = 0; i < dim; i++) {
      weighted[i] += weight * embedding[i];
    }
    totalWeight += weight;
  }

  if (totalWeight === 0) return new Array(dim).fill(0);

  for (let i = 0; i < dim; i++) {
    weighted[i] /= totalWeight;
  }

  return l2Normalize(weighted);
}

// =============================================================================
// Database functions
// =============================================================================

export interface UserKnowledge {
  /** Knowledge vector — points toward known content */
  knowledgeVector: number[];
  /** Number of concepts with embeddings used */
  conceptCount: number;
  /** Average recall across concepts */
  avgRecall: number;
}

/**
 * Compute knowledge vector from pre-loaded data (no DB queries).
 * Use this when the caller already has concepts, states, and embeddings.
 */
export function computeKnowledgeVectorFromData(
  conceptIds: string[],
  stateMap: Map<string, { recallProbability: number; confidence: number; lastExposureAt: Date | null }>,
  embeddings: Map<string, number[]>
): UserKnowledge {
  if (conceptIds.length === 0) {
    return { knowledgeVector: [], conceptCount: 0, avgRecall: 0 };
  }

  const now = new Date();
  const entries: Array<{ embedding: number[]; weight: number }> = [];
  let totalRecall = 0;

  for (const conceptId of conceptIds) {
    const rawEmbedding = embeddings.get(conceptId);
    if (!rawEmbedding) continue;

    const embedding = truncateToManifoldDim(rawEmbedding);

    const state = stateMap.get(conceptId);
    if (!state) continue;

    const daysSinceExposure = state.lastExposureAt
      ? (now.getTime() - state.lastExposureAt.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;

    const currentRecall =
      daysSinceExposure < Infinity
        ? applyDecay(state.recallProbability, daysSinceExposure, state.confidence)
        : 0;

    if (currentRecall > 0) {
      entries.push({ embedding, weight: currentRecall });
      totalRecall += currentRecall;
    }
  }

  if (entries.length === 0) {
    return { knowledgeVector: [], conceptCount: 0, avgRecall: 0 };
  }

  return {
    knowledgeVector: computeWeightedCentroid(entries),
    conceptCount: entries.length,
    avgRecall: totalRecall / entries.length,
  };
}

/**
 * Compute a user's knowledge vector for a rotation.
 *
 * 1. Load ConceptStates for user + rotation
 * 2. Apply decay to get current recall probability
 * 3. Load concept embeddings
 * 4. Weighted centroid: SUM(recall_i * emb_i) / SUM(recall_i)
 * 5. L2-normalize
 */
export async function computeUserKnowledgeVector(
  userId: string,
  rotation: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _examDate: Date
): Promise<UserKnowledge> {
  // Load concepts for this rotation
  const concepts = await prisma.concept.findMany({
    where: { rotation },
    select: { id: true },
  });

  if (concepts.length === 0) {
    return { knowledgeVector: [], conceptCount: 0, avgRecall: 0 };
  }

  const conceptIds = concepts.map((c) => c.id);

  // Load concept states and embeddings in parallel
  const [states, embeddings] = await Promise.all([
    prisma.conceptState.findMany({
      where: { userId, conceptId: { in: conceptIds } },
    }),
    batchLoadConceptEmbeddings(conceptIds),
  ]);

  const stateMap = new Map(states.map((s) => [s.conceptId, s]));
  return computeKnowledgeVectorFromData(conceptIds, stateMap, embeddings);
}
