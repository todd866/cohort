/**
 * Manifold Configuration
 *
 * Canonical constants for the MD3 Knowledge Manifold.
 * Aligning all runtime consumers to the Gemini Embedding 2 space.
 */

/** The canonical model used for all embeddings in the platform. */
export const MANIFOLD_MODEL = 'gemini-embedding-2-preview';

/** The raw dimensionality of the stored vectors in Postgres (Gemini 2 default). */
export const STORED_MANIFOLD_DIM = 3072;

/**
 * The dimensionality used for runtime math, PCA, and scheduler ranking.
 * Using 1024 for a balance of performance and precision (Matryoshka).
 */
export const RUNTIME_MANIFOLD_DIM = 1024;

/**
 * Helper to truncate a 3072D vector to the runtime dimension.
 * Assumes Matryoshka-compatible embeddings where early dimensions carry the most signal.
 */
export function toRuntimeVector(v: number[]): number[] {
  if (v.length <= RUNTIME_MANIFOLD_DIM) return v;
  return v.slice(0, RUNTIME_MANIFOLD_DIM);
}
