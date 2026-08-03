/**
 * Exam Target Centroid (LEGACY / inert)
 *
 * Computes the centroid of all `courseware_embeddings` for a rotation. This was
 * the original "exam target", but it is a poor proxy (it targets what was
 * LECTURED, not what is TESTED) and is inert in prod — `courseware_embeddings`
 * has 0 rows, so this returns an empty centroid and the scheduler's
 * gapAlignmentBoost is always 0.
 *
 * SUPERSEDED (2026-06-19) by the per-domain exam model: each item is assigned an
 * official blueprint area + a discriminating within-rotation percentile
 * (examDomain / examRelevancePct), persisted by
 * scripts/manifold/exam-domain-backfill.ts and consumed by the scheduler via
 * candidate-ranking's examTargetRankBoost + src/lib/manifold/exam-blueprint.ts.
 * Keep this only if `courseware_embeddings` is ever repopulated for a DIFFERENT
 * job (content cold-spot / coverage), never as the exam target. See
 * docs/superpowers/specs/2026-06-19-exam-target-engine-design.md.
 */

import { prisma } from '@/lib/prisma';
import { RUNTIME_MANIFOLD_DIM, toRuntimeVector } from './config';

// =============================================================================
// Pure functions (exported for testing)
// =============================================================================

/**
 * Truncate a higher-dim embedding to RUNTIME_MANIFOLD_DIM and renormalize.
 * If already at or below RUNTIME_MANIFOLD_DIM, returns as-is (normalized).
 */
export function truncateToManifoldDim(v: number[]): number[] {
  if (v.length <= RUNTIME_MANIFOLD_DIM) return l2Normalize(v);
  return l2Normalize(toRuntimeVector(v));
}

/**
 * L2-normalize a vector. Returns zero vector if input is zero.
 */
export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return v.map(() => 0);
  return v.map((x) => x / norm);
}

/**
 * Compute the centroid (element-wise mean) of vectors, then L2-normalize.
 * Returns empty array for empty input.
 */
export function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];

  const dim = vectors[0].length;
  const mean = new Array(dim).fill(0);

  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      mean[i] += v[i];
    }
  }

  for (let i = 0; i < dim; i++) {
    mean[i] /= vectors.length;
  }

  return l2Normalize(mean);
}

// =============================================================================
// Database functions
// =============================================================================

export interface ExamTarget {
  /** Overall centroid of all courseware for this rotation */
  centroid: number[];
  /** Per-week centroids */
  weekCentroids: Map<number, number[]>;
  /** Number of chunks used to compute */
  chunkCount: number;
}

/**
 * Load exam target using SQL aggregation (AVG) instead of transferring all vectors.
 * Old approach transferred 5,249 × 12.7KB = 64MB per cold start.
 * New approach transfers ~13KB (one centroid) + per-week centroids.
 */
export async function computeExamTarget(rotation: string): Promise<ExamTarget> {
  // Get overall centroid and count via SQL AVG (pgvector supports this)
  const [overallResult, weekResults] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint; avg_emb: string | null }>>`
      SELECT COUNT(*) as count, AVG(embedding)::text as avg_emb
      FROM courseware_embeddings
      WHERE rotation = ${rotation}
    `,
    prisma.$queryRaw<Array<{ week: number; avg_emb: string }>>`
      SELECT week, AVG(embedding)::text as avg_emb
      FROM courseware_embeddings
      WHERE rotation = ${rotation} AND week IS NOT NULL
      GROUP BY week
    `,
  ]);

  const chunkCount = Number(overallResult[0]?.count ?? 0);
  if (chunkCount === 0 || !overallResult[0]?.avg_emb) {
    return { centroid: [], weekCentroids: new Map(), chunkCount: 0 };
  }

  const centroid = truncateToManifoldDim(JSON.parse(overallResult[0].avg_emb) as number[]);

  const weekCentroids = new Map<number, number[]>();
  for (const row of weekResults) {
    weekCentroids.set(row.week, truncateToManifoldDim(JSON.parse(row.avg_emb) as number[]));
  }

  return { centroid, weekCentroids, chunkCount };
}

// =============================================================================
// Cached wrapper
// =============================================================================

const cache = new Map<string, { target: ExamTarget; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get exam target with 1-hour caching.
 */
export async function getExamTarget(rotation: string): Promise<ExamTarget> {
  const now = Date.now();
  const cached = cache.get(rotation);

  if (cached && cached.expiresAt > now) {
    return cached.target;
  }

  const target = await computeExamTarget(rotation);
  cache.set(rotation, { target, expiresAt: now + CACHE_TTL_MS });
  return target;
}
