/**
 * Knowledge Dimensionality
 *
 * Measures the effective dimensionality of a user's knowledge state.
 * As memories decay, low-stability items lose weight and the knowledge
 * representation undergoes spectral collapse — concentrating on the
 * principal axes of the user's most stable memories.
 *
 * Two measures:
 * - participationRatio: cheap proxy using weight distribution only
 * - spectralDimensionality: full covariance eigenspectrum
 *
 * Also: hub-ness (how many subspaces a concept connects) and
 * distractor gap direction (which subspace failed on MCQ error).
 *
 * See docs/MATH_MODEL.md §6-7 for the theory.
 */

import { computePCA } from './pca';
import { cosineSimilarity } from '@/lib/math/vector-math';

// =============================================================================
// Cheap proxy: participation ratio of weight distribution
// =============================================================================

/**
 * Participation ratio of a weight distribution.
 *
 *   D̃_eff = (Σ w_i)² / Σ w_i²
 *
 * When one weight dominates: D̃_eff → 1.
 * When N weights are equal: D̃_eff → N.
 *
 * Negative weights are clamped to 0.
 */
export function participationRatio(weights: number[]): number {
  if (weights.length === 0) return 0;

  let sum = 0;
  let sumSq = 0;

  for (const w of weights) {
    const clamped = Math.max(0, w);
    sum += clamped;
    sumSq += clamped * clamped;
  }

  if (sumSq === 0) return 0;

  return (sum * sum) / sumSq;
}

// =============================================================================
// Full spectral: eigenspectrum of weighted covariance
// =============================================================================

export interface DimensionalityResult {
  /** Effective dimensionality (participation ratio of eigenspectrum) */
  dEff: number;
  /** Eigenvalues from PCA (variance in each principal direction) */
  eigenspectrum: number[];
}

/**
 * Compute effective dimensionality from weighted embeddings via PCA.
 *
 * 1. Scale each embedding by sqrt(weight) (so covariance reflects mastery)
 * 2. Run PCA to get eigenspectrum
 * 3. Participation ratio of eigenvalues = effective dimensionality
 *
 * This captures how many independent directions the user's knowledge spans,
 * weighted by how well they remember content in each direction.
 */
export function spectralDimensionality(
  entries: Array<{ embedding: number[]; weight: number }>,
): DimensionalityResult {
  if (entries.length < 2) {
    return { dEff: 0, eigenspectrum: [] };
  }

  // Scale embeddings by sqrt(weight) so the covariance matrix is
  // C = Σ w_i (e_i - μ)(e_i - μ)^T, which weights mastery correctly
  const scaled: number[][] = [];
  for (const { embedding, weight } of entries) {
    const w = Math.max(0, weight);
    if (w < 1e-10) continue; // skip zero-weight items
    const sqrtW = Math.sqrt(w);
    scaled.push(embedding.map((v) => v * sqrtW));
  }

  if (scaled.length < 2) {
    return { dEff: 0, eigenspectrum: [] };
  }

  // PCA returns explained variance ratios — these are the normalized eigenvalues
  const k = Math.min(scaled.length, scaled[0].length);
  const pca = computePCA(scaled, k);

  if (pca.explainedVariance.length === 0) {
    return { dEff: 0, eigenspectrum: [] };
  }

  // Participation ratio of eigenspectrum
  const eigenspectrum = pca.explainedVariance;
  let sum = 0;
  let sumSq = 0;
  for (const ev of eigenspectrum) {
    sum += ev;
    sumSq += ev * ev;
  }

  const dEff = sumSq > 0 ? (sum * sum) / sumSq : 0;

  return { dEff, eigenspectrum };
}

// =============================================================================
// Concept hub-ness: how many subspaces a concept connects
// =============================================================================

export interface HubnessResult {
  /** Hub-ness score — participation ratio of neighborhood eigenspectrum */
  hubness: number;
  /** Number of neighbors used */
  neighborCount: number;
  /** Eigenspectrum of the neighborhood PCA */
  eigenspectrum: number[];
}

/**
 * Compute hub-ness of a concept from its neighborhood embeddings.
 *
 * A concept is a hub if its local neighborhood spans many principal
 * directions. hub(c) = participation_ratio(PCA(neighbors)).
 *
 * High hub-ness → integrating concept (connects many subspaces).
 * Low hub-ness → isolated fact (sits in one cluster).
 *
 * @param neighbors - embeddings of the k nearest neighbors (NOT including the concept itself)
 */
export function computeHubness(neighbors: number[][]): HubnessResult {
  if (neighbors.length < 2) {
    return { hubness: neighbors.length, neighborCount: neighbors.length, eigenspectrum: [] };
  }

  const k = Math.min(neighbors.length, neighbors[0].length);
  const pca = computePCA(neighbors, k);

  if (pca.explainedVariance.length === 0) {
    return { hubness: 1, neighborCount: neighbors.length, eigenspectrum: [] };
  }

  const eigenspectrum = pca.explainedVariance;
  let sum = 0;
  let sumSq = 0;
  for (const ev of eigenspectrum) {
    sum += ev;
    sumSq += ev * ev;
  }

  const hubness = sumSq > 0 ? (sum * sum) / sumSq : 1;

  return { hubness, neighborCount: neighbors.length, eigenspectrum };
}

/**
 * Find the k nearest neighbors of a concept embedding from a pool.
 *
 * Pure function — no DB access. Use this with pre-loaded embeddings.
 */
export function findNeighborEmbeddings(
  conceptEmbedding: number[],
  pool: Array<{ id: string; embedding: number[] }>,
  k: number,
): number[][] {
  const scored = pool
    .map((item) => ({
      embedding: item.embedding,
      similarity: cosineSimilarity(conceptEmbedding, item.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);

  return scored.map((s) => s.embedding);
}

// =============================================================================
// MCQ distractor gap direction
// =============================================================================

/**
 * Compute the gap direction from an MCQ error.
 *
 * When a user chooses the wrong option, the error vector points
 * from the correct answer toward the misconception — identifying
 * which subspace is weak.
 *
 *   gap = normalize(e_chosen - e_correct)
 *
 * Returns null if either embedding is missing or vectors are identical.
 */
export function distractorGapDirection(
  correctEmbedding: number[],
  chosenEmbedding: number[],
): number[] | null {
  if (correctEmbedding.length !== chosenEmbedding.length) return null;
  if (correctEmbedding.length === 0) return null;

  const diff = new Array(correctEmbedding.length);
  let normSq = 0;

  for (let i = 0; i < correctEmbedding.length; i++) {
    diff[i] = chosenEmbedding[i] - correctEmbedding[i];
    normSq += diff[i] * diff[i];
  }

  const norm = Math.sqrt(normSq);
  if (norm < 1e-10) return null; // identical embeddings

  for (let i = 0; i < diff.length; i++) {
    diff[i] /= norm;
  }

  return diff;
}
