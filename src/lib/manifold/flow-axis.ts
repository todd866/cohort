/**
 * Flow Axis — Directed Upstream/Downstream Manifold
 *
 * Computes a flow axis from prerequisite edges. Averages all (parent -> child)
 * direction vectors in embedding space, normalizes, and produces a single axis
 * where low = foundational/upstream, high = applied/downstream.
 *
 * Every existing embedding gets a depth score for free via dot product.
 *
 * Pattern: follows exam-target.ts — pure functions up top, DB function below,
 * cached wrapper at bottom.
 */

import { prisma } from '@/lib/prisma';
import { l2Normalize } from './exam-target';
import { batchLoadConceptEmbeddings } from './similarity';
import { cosineSimilarity } from '@/lib/math/vector-math';

// =============================================================================
// Pure functions (exported for testing)
// =============================================================================

/**
 * Compute the flow axis from prerequisite edges.
 *
 * For each (prereq, child) edge where both have embeddings, computes the
 * normalized direction vector (child_emb - prereq_emb). The flow axis is
 * the L2-normalized average of all such direction vectors.
 *
 * Returns a zero vector for empty or invalid input.
 */
export function computeFlowAxis(
  edges: Array<[string, string]>,
  embeddings: Map<string, number[]>
): number[] {
  if (edges.length === 0 || embeddings.size === 0) {
    // Return zero vector matching first embedding dimension, or 1024 default
    const firstEmb = embeddings.size > 0
      ? embeddings.values().next().value
      : undefined;
    const dim = firstEmb ? firstEmb.length : 1024;
    return new Array(dim).fill(0);
  }

  const firstEmbedding = embeddings.values().next().value;
  if (!firstEmbedding) return new Array(1024).fill(0);
  const dim = firstEmbedding.length;
  const sum = new Array(dim).fill(0);
  let validEdgeCount = 0;

  for (const [prereqId, childId] of edges) {
    const prereqEmb = embeddings.get(prereqId);
    const childEmb = embeddings.get(childId);
    if (!prereqEmb || !childEmb) continue;

    // Direction from prereq to child
    const diff = new Array(dim);
    for (let i = 0; i < dim; i++) {
      diff[i] = childEmb[i] - prereqEmb[i];
    }

    // Normalize the direction
    const normalized = l2Normalize(diff);

    // Accumulate
    for (let i = 0; i < dim; i++) {
      sum[i] += normalized[i];
    }
    validEdgeCount++;
  }

  if (validEdgeCount === 0) {
    return new Array(dim).fill(0);
  }

  // Average then normalize
  for (let i = 0; i < dim; i++) {
    sum[i] /= validEdgeCount;
  }

  return l2Normalize(sum);
}

// =============================================================================
// Quality scoring — measures how well embeddings support a set of edges
// =============================================================================

export interface FlowAxisQuality {
  /** Fraction of edges where child depth > prereq depth (0–1, higher is better) */
  edgeConsistency: number;
  /** Average (childDepth - prereqDepth) across consistent edges */
  meanSeparation: number;
  /** Fraction of transitive chains (A→B→C) where depth(A) < depth(B) < depth(C) */
  transitivity: number;
  /** Ratio of depth range to max possible range. 0 = all concepts at same depth. */
  spread: number;
  /** Fraction of un-edged concepts whose depth is consistent with their nearest
   *  edged neighbor (within 1 std-dev of the edged neighbor's depth) */
  interpolationQuality: number;
  /** Single composite score (0–1) */
  overall: number;
}

/**
 * Score how well a set of embeddings supports a set of prerequisite edges.
 *
 * This is the objective function for comparing embedding strategies:
 * generate embeddings, compute axis, score, compare.
 */
export function scoreFlowAxis(
  edges: Array<[string, string]>,
  embeddings: Map<string, number[]>
): FlowAxisQuality {
  const axis = computeFlowAxis(edges, embeddings);
  const isZero = axis.every((v) => v === 0);

  if (isZero || edges.length === 0) {
    return {
      edgeConsistency: 0,
      meanSeparation: 0,
      transitivity: 0,
      spread: 0,
      interpolationQuality: 0,
      overall: 0,
    };
  }

  // Compute depths for all concepts
  const depths = new Map<string, number>();
  for (const [id, emb] of embeddings) {
    depths.set(id, getFlowDepth(emb, axis));
  }

  // Edge consistency: fraction of edges where child > prereq
  let consistent = 0;
  let totalSep = 0;
  const validEdges: Array<[string, string]> = [];

  for (const [prereqId, childId] of edges) {
    const pDepth = depths.get(prereqId);
    const cDepth = depths.get(childId);
    if (pDepth === undefined || cDepth === undefined) continue;
    validEdges.push([prereqId, childId]);
    if (cDepth > pDepth) {
      consistent++;
      totalSep += cDepth - pDepth;
    }
  }

  const edgeConsistency = validEdges.length > 0 ? consistent / validEdges.length : 0;
  const meanSeparation = consistent > 0 ? totalSep / consistent : 0;

  // Transitivity: for chains A→B→C, check depth(A) < depth(B) < depth(C)
  const children = new Map<string, string[]>();
  for (const [p, c] of validEdges) {
    if (!children.has(p)) children.set(p, []);
    const pChildren = children.get(p);
    if (pChildren) pChildren.push(c);
  }

  let transitiveTotal = 0;
  let transitiveConsistent = 0;
  for (const [a, bList] of children) {
    for (const b of bList) {
      const cList = children.get(b);
      if (!cList) continue;
      for (const c of cList) {
        transitiveTotal++;
        const dA = depths.get(a);
        const dB = depths.get(b);
        const dC = depths.get(c);
        if (dA !== undefined && dB !== undefined && dC !== undefined) {
          if (dA < dB && dB < dC) transitiveConsistent++;
        }
      }
    }
  }
  const transitivity = transitiveTotal > 0 ? transitiveConsistent / transitiveTotal : 1;

  // Spread: how much of the depth range is used
  const allDepths = [...depths.values()];
  const minDepth = Math.min(...allDepths);
  const maxDepth = Math.max(...allDepths);
  const range = maxDepth - minDepth;
  // Max possible range for unit vectors projected onto unit axis is 2 (-1 to 1)
  const spread = range / 2;

  // Interpolation quality: concepts without edges should have depths consistent
  // with their nearest neighbors that do have edges
  const edgedIds = new Set<string>();
  for (const [p, c] of validEdges) {
    edgedIds.add(p);
    edgedIds.add(c);
  }
  const unedgedIds = [...depths.keys()].filter((id) => !edgedIds.has(id));

  let interpTotal = 0;
  let interpConsistent = 0;
  if (unedgedIds.length > 0 && edgedIds.size > 0) {
    // Compute std-dev of edged concept depths
    const edgedDepths = [...edgedIds].map((id) => depths.get(id)).filter((d): d is number => d !== undefined);
    const edgedMean = edgedDepths.reduce((s, d) => s + d, 0) / edgedDepths.length;
    const edgedStd = Math.sqrt(
      edgedDepths.reduce((s, d) => s + (d - edgedMean) ** 2, 0) / edgedDepths.length
    );
    const tolerance = Math.max(edgedStd, 0.05); // at least 0.05

    for (const uid of unedgedIds) {
      const uEmb = embeddings.get(uid);
      if (!uEmb) continue;

      // Find nearest edged neighbor by cosine similarity
      let bestSim = -Infinity;
      let bestNeighborDepth = 0;
      for (const eid of edgedIds) {
        const eEmb = embeddings.get(eid);
        if (!eEmb) continue;
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < uEmb.length; i++) {
          dot += uEmb[i] * eEmb[i];
          nA += uEmb[i] ** 2;
          nB += eEmb[i] ** 2;
        }
        const sim = (Math.sqrt(nA) * Math.sqrt(nB)) > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
        if (sim > bestSim) {
          bestSim = sim;
          bestNeighborDepth = depths.get(eid) ?? 0;
        }
      }

      interpTotal++;
      const uDepth = depths.get(uid) ?? 0;
      if (Math.abs(uDepth - bestNeighborDepth) <= tolerance) {
        interpConsistent++;
      }
    }
  }
  const interpolationQuality = interpTotal > 0 ? interpConsistent / interpTotal : 1;

  // Composite: weighted combination
  const overall =
    edgeConsistency * 0.40 +
    Math.min(meanSeparation / 0.3, 1) * 0.20 + // normalize: 0.3 separation = perfect
    transitivity * 0.20 +
    spread * 0.10 +
    interpolationQuality * 0.10;

  return {
    edgeConsistency,
    meanSeparation: Math.round(meanSeparation * 1000) / 1000,
    transitivity,
    spread: Math.round(spread * 1000) / 1000,
    interpolationQuality,
    overall: Math.round(overall * 1000) / 1000,
  };
}

/**
 * Get the flow depth of an embedding projected onto the flow axis.
 * Higher values = more downstream/applied.
 */
export function getFlowDepth(embedding: number[], flowAxis: number[]): number {
  let dot = 0;
  const len = Math.min(embedding.length, flowAxis.length);
  for (let i = 0; i < len; i++) {
    dot += embedding[i] * flowAxis[i];
  }
  return dot;
}

/**
 * Generate synthetic week-ordering edges for concepts in the same rotation.
 *
 * For concepts with overlapping topics and different weeks, creates
 * (earlierWeek, laterWeek) edges where cosine similarity > threshold.
 * Augments sparse prerequisite DAGs.
 */
export function generateWeekEdges(
  concepts: Array<{ id: string; week: number | null; topics: string[] }>,
  embeddings: Map<string, number[]>,
  minSimilarity: number = 0.3
): Array<[string, string]> {
  const edges: Array<[string, string]> = [];

  // Only consider concepts with a week and an embedding
  const withWeek = concepts.filter(
    (c) => c.week !== null && embeddings.has(c.id)
  );

  for (let i = 0; i < withWeek.length; i++) {
    for (let j = i + 1; j < withWeek.length; j++) {
      const a = withWeek[i];
      const b = withWeek[j];

      // Must be different weeks
      if (a.week === b.week) continue;

      // Must have overlapping topics
      const aTopics = new Set(a.topics);
      const hasOverlap = b.topics.some((t) => aTopics.has(t));
      if (!hasOverlap) continue;

      // Check embedding similarity
      const embA = embeddings.get(a.id);
      const embB = embeddings.get(b.id);
      if (!embA || !embB) continue;
      const sim = cosineSimilarity(embA, embB);
      if (sim < minSimilarity) continue;

      // Edge goes from earlier week to later week
      // (a.week and b.week are guaranteed non-null by the withWeek filter above)
      if ((a.week ?? 0) < (b.week ?? 0)) {
        edges.push([a.id, b.id]);
      } else {
        edges.push([b.id, a.id]);
      }
    }
  }

  return edges;
}

// =============================================================================
// Database functions
// =============================================================================

export interface FlowAxisResult {
  /** 1024D normalized flow direction */
  axis: number[];
  /** Explicit prerequisite edges used */
  edgeCount: number;
  /** Week-ordering edges added */
  syntheticEdgeCount: number;
  /** conceptId -> depth score */
  conceptDepths: Map<string, number>;
}

/**
 * Compute the flow axis for a rotation from prerequisite edges + optional
 * synthetic week-ordering edges.
 */
export async function computeRotationFlowAxis(
  rotation: string
): Promise<FlowAxisResult> {
  // 1. Load concepts with prerequisiteIds + week + topics
  const concepts = await prisma.concept.findMany({
    where: { rotation },
    select: {
      id: true,
      prerequisiteIds: true,
      week: true,
      topics: true,
    },
  });

  if (concepts.length === 0) {
    return {
      axis: [],
      edgeCount: 0,
      syntheticEdgeCount: 0,
      conceptDepths: new Map(),
    };
  }

  // 2. Load concept embeddings
  const conceptIds = concepts.map((c) => c.id);
  const embeddings = await batchLoadConceptEmbeddings(conceptIds);

  // 3. Collect explicit prerequisite edges
  const explicitEdges: Array<[string, string]> = [];
  for (const concept of concepts) {
    for (const prereqId of concept.prerequisiteIds) {
      explicitEdges.push([prereqId, concept.id]);
    }
  }

  // 4. Generate synthetic week edges if explicit edges are sparse
  let syntheticEdges: Array<[string, string]> = [];
  if (explicitEdges.length < 10) {
    syntheticEdges = generateWeekEdges(concepts, embeddings);
  }

  // 5. Compute flow axis from all edges
  const allEdges = [...explicitEdges, ...syntheticEdges];
  const axis = computeFlowAxis(allEdges, embeddings);

  // 6. Project all concepts onto axis -> conceptDepths map
  const conceptDepths = new Map<string, number>();
  for (const concept of concepts) {
    const emb = embeddings.get(concept.id);
    if (emb) {
      conceptDepths.set(concept.id, getFlowDepth(emb, axis));
    }
  }

  return {
    axis,
    edgeCount: explicitEdges.length,
    syntheticEdgeCount: syntheticEdges.length,
    conceptDepths,
  };
}

// =============================================================================
// Cached wrapper
// =============================================================================

const cache = new Map<string, { result: FlowAxisResult; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get flow axis with 1-hour caching.
 */
export async function getFlowAxis(rotation: string): Promise<FlowAxisResult> {
  const now = Date.now();
  const cached = cache.get(rotation);

  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await computeRotationFlowAxis(rotation);
  cache.set(rotation, { result, expiresAt: now + CACHE_TTL_MS });
  return result;
}
