/**
 * Local Flow Field — Directional Manifold with Per-Region Gravity
 *
 * Instead of a single global flow axis, each edge creates gravitational
 * pull in its neighborhood. The total flow at any point is the superposition
 * of nearby edge directions, weighted by Gaussian distance to edge midpoints.
 *
 * This means:
 * - A concept near respiratory edges gets the respiratory flow direction
 * - A concept near cardiac edges gets the cardiac flow direction
 * - "Upstream of X" uses the local flow at X's region, not a global direction
 *
 * Pure functions up top, DB function below.
 */

import { l2Normalize } from './exam-target';
import { cosineSimilarity } from '@/lib/math/vector-math';
import { prisma } from '@/lib/prisma';
import { batchLoadConceptEmbeddings } from './similarity';
import { logger } from '@/lib/logger';

// =============================================================================
// Types
// =============================================================================

export interface UpstreamGap {
  conceptId: string;
  conceptName: string;
  dagDistance: number | null; // null = geometric only
  alignment: number; // local flow alignment (-1 to 1)
  flowMagnitude: number; // local flow strength at this region
  recallProbability: number;
  recentFailRate: number;
  confidence: number;
  gapScore: number;
}

export interface ConceptNode {
  id: string;
  name: string;
  prerequisiteIds: string[];
}

export interface ConceptHealth {
  recallProbability: number;
  recentFailRate: number;
  confidence: number;
  responseVariance: number | null;
  probeCount: number;
}

// =============================================================================
// Core: localFlowDirection
// =============================================================================

/**
 * Compute the local flow direction at a point in embedding space.
 * Interpolates nearby edge directions weighted by Gaussian distance to edge midpoints.
 *
 * Returns the (unnormalized) local flow vector. Magnitude indicates flow strength
 * at this point — zero means no nearby edges, large means many aligned edges nearby.
 */
export function localFlowDirection(
  point: number[],
  edges: Array<[string, string]>,
  embeddings: Map<string, number[]>,
  sigma?: number
): number[] {
  const dim = point.length;
  const flow = new Array(dim).fill(0);

  // Collect valid edges with their midpoints
  const validEdges: Array<{ direction: number[]; midpoint: number[] }> = [];
  for (const [srcId, tgtId] of edges) {
    const srcEmb = embeddings.get(srcId);
    const tgtEmb = embeddings.get(tgtId);
    if (!srcEmb || !tgtEmb) continue;

    const diff = new Array(dim).fill(0);
    const midpoint = new Array(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      diff[i] = tgtEmb[i] - srcEmb[i];
      midpoint[i] = (srcEmb[i] + tgtEmb[i]) / 2;
    }

    validEdges.push({
      direction: l2Normalize(diff),
      midpoint,
    });
  }

  if (validEdges.length === 0) return flow;

  // Auto-calibrate sigma from median distance between edge midpoints
  const effectiveSigma = sigma ?? autoSigma(validEdges.map((e) => e.midpoint));

  if (effectiveSigma <= 0) return flow;

  const twoSigmaSq = 2 * effectiveSigma * effectiveSigma;

  for (const { direction, midpoint } of validEdges) {
    // Squared distance from point to edge midpoint
    let distSq = 0;
    for (let i = 0; i < dim; i++) {
      const d = point[i] - midpoint[i];
      distSq += d * d;
    }

    const weight = Math.exp(-distSq / twoSigmaSq);

    for (let i = 0; i < dim; i++) {
      flow[i] += weight * direction[i];
    }
  }

  return flow;
}

/**
 * Compute sigma as median pairwise distance between midpoints.
 * Falls back to 1.0 if fewer than 2 midpoints.
 */
function autoSigma(midpoints: number[][]): number {
  if (midpoints.length < 2) return 1.0;

  const distances: number[] = [];
  for (let i = 0; i < midpoints.length; i++) {
    for (let j = i + 1; j < midpoints.length; j++) {
      let distSq = 0;
      for (let d = 0; d < midpoints[i].length; d++) {
        const diff = midpoints[i][d] - midpoints[j][d];
        distSq += diff * diff;
      }
      distances.push(Math.sqrt(distSq));
    }
  }

  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)] || 1.0;
}

// =============================================================================
// Upstream test: isLocallyUpstream
// =============================================================================

/**
 * Check if candidate is upstream of target using the local flow field.
 * Uses the flow direction at the midpoint between candidate and target.
 */
export function isLocallyUpstream(
  targetEmb: number[],
  candidateEmb: number[],
  edges: Array<[string, string]>,
  embeddings: Map<string, number[]>,
  sigma?: number
): { upstream: boolean; alignment: number; flowMagnitude: number } {
  const dim = targetEmb.length;

  // Midpoint between candidate and target
  const mid = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    mid[i] = (targetEmb[i] + candidateEmb[i]) / 2;
  }

  const flow = localFlowDirection(mid, edges, embeddings, sigma);

  // Direction from candidate toward target
  const direction = new Array(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    direction[i] = targetEmb[i] - candidateEmb[i];
  }
  const dirNorm = l2Normalize(direction);

  // Flow magnitude
  let flowMag = 0;
  for (let i = 0; i < dim; i++) {
    flowMag += flow[i] * flow[i];
  }
  flowMag = Math.sqrt(flowMag);

  const EPSILON = 1e-8;
  const FLOW_THRESHOLD = 0.01;

  if (flowMag < EPSILON) {
    return { upstream: false, alignment: 0, flowMagnitude: flowMag };
  }

  const alignment = cosineSimilarity(dirNorm, flow);
  const upstream = alignment > 0.1 && flowMag > FLOW_THRESHOLD;

  return { upstream, alignment, flowMagnitude: flowMag };
}

// =============================================================================
// Gap ranking: findUpstreamGaps
// =============================================================================

/**
 * Find upstream knowledge gaps for a struggling concept.
 * Combines DAG-structural prerequisites with geometric upstream detection.
 */
export function findUpstreamGaps(
  conceptId: string,
  conceptMap: Map<string, ConceptNode>,
  healthMap: Map<string, ConceptHealth>,
  embeddings: Map<string, number[]>,
  edges: Array<[string, string]>,
  sigma?: number,
  options?: { maxDepth?: number; minGapScore?: number }
): UpstreamGap[] {
  const concept = conceptMap.get(conceptId);
  if (!concept) return [];

  const maxDepth = options?.maxDepth ?? 3;
  const minGapScore = options?.minGapScore ?? 0;

  // 1. Structural upstream: BFS walk of prerequisite DAG (depth-capped)
  const dagUpstream = new Map<string, number>(); // conceptId → distance
  const queue: Array<{ id: string; depth: number }> = [];

  for (const prereqId of concept.prerequisiteIds) {
    if (conceptMap.has(prereqId)) {
      queue.push({ id: prereqId, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (dagUpstream.has(id)) continue;
    dagUpstream.set(id, depth);

    if (depth < maxDepth) {
      const node = conceptMap.get(id);
      if (node) {
        for (const prereqId of node.prerequisiteIds) {
          if (!dagUpstream.has(prereqId) && conceptMap.has(prereqId)) {
            queue.push({ id: prereqId, depth: depth + 1 });
          }
        }
      }
    }
  }

  // 2. Geometric upstream: find concepts upstream via local flow
  const geometricUpstream = new Map<string, { alignment: number; flowMagnitude: number }>();
  const targetEmb = embeddings.get(conceptId);

  if (targetEmb && edges.length > 0) {
    for (const [candidateId, candidateEmb] of embeddings) {
      if (candidateId === conceptId) continue;
      if (!conceptMap.has(candidateId)) continue;

      // Cosine similarity filter: skip candidates that are too dissimilar
      const sim = cosineSimilarity(targetEmb, candidateEmb);
      if (sim < 0.3) continue;

      const result = isLocallyUpstream(targetEmb, candidateEmb, edges, embeddings, sigma);
      if (result.upstream) {
        geometricUpstream.set(candidateId, {
          alignment: result.alignment,
          flowMagnitude: result.flowMagnitude,
        });
      }
    }
  }

  // 3. Merge: DAG prereqs always included, geometric candidates added
  const allUpstreamIds = new Set([...dagUpstream.keys(), ...geometricUpstream.keys()]);

  // Compute median flow magnitude for normalization
  const allMagnitudes = [...geometricUpstream.values()].map((v) => v.flowMagnitude);
  allMagnitudes.sort((a, b) => a - b);
  const medianMagnitude = allMagnitudes.length > 0
    ? allMagnitudes[Math.floor(allMagnitudes.length / 2)]
    : 1;

  // 4. Score each upstream candidate
  const gaps: UpstreamGap[] = [];

  for (const upId of allUpstreamIds) {
    const node = conceptMap.get(upId);
    if (!node) continue;

    const health = healthMap.get(upId);
    const dagDist = dagUpstream.get(upId) ?? null;
    const geo = geometricUpstream.get(upId);

    const recall = health?.recallProbability ?? 0;
    const failRate = health?.recentFailRate ?? 0;
    const conf = health?.confidence ?? 0;
    const probeCount = health?.probeCount ?? 0;
    const untested = probeCount === 0 ? 1 : 0;

    // Weakness signal
    const weakness = (1 - recall) * 0.4 + failRate * 0.3 + (1 - conf) * 0.2 + untested * 0.1;

    // DAG boost: closer prereqs matter more
    const dagBoost = dagDist != null ? 1.5 / dagDist : 1.0;

    // Alignment factor: floor for DAG prereqs
    const alignment = geo?.alignment ?? 0;
    const alignmentFactor = dagDist != null ? Math.max(alignment, 0.1) : Math.max(alignment, 0.1);

    // Flow confidence: how much to trust the geometric signal
    const flowMag = geo?.flowMagnitude ?? 0;
    const flowConfidence = medianMagnitude > 0 ? Math.min(flowMag / medianMagnitude, 1) : 0;

    // For DAG prereqs without geometric signal, trust the DAG
    const effectiveFlowConfidence = dagDist != null ? Math.max(flowConfidence, 0.5) : flowConfidence;

    const score = weakness * dagBoost * alignmentFactor * effectiveFlowConfidence;

    if (score >= minGapScore) {
      gaps.push({
        conceptId: upId,
        conceptName: node.name,
        dagDistance: dagDist,
        alignment,
        flowMagnitude: flowMag,
        recallProbability: recall,
        recentFailRate: failRate,
        confidence: conf,
        gapScore: score,
      });
    }
  }

  // Sort by gap score descending
  gaps.sort((a, b) => b.gapScore - a.gapScore);

  return gaps;
}

// =============================================================================
// DB function: getUpstreamGapsForConcept
// =============================================================================

/**
 * Load all data and compute upstream gaps for a concept.
 * This is the entry point for the intervention system.
 */
export async function getUpstreamGapsForConcept(
  userId: string,
  conceptId: string,
  rotation: string
): Promise<UpstreamGap[]> {
  try {
    // 1. Load all concepts for this rotation (with prerequisiteIds)
    const concepts = await prisma.concept.findMany({
      where: { rotation },
      select: { id: true, name: true, prerequisiteIds: true },
    });

    if (concepts.length === 0) return [];

    const conceptMap = new Map<string, ConceptNode>();
    const allIds: string[] = [];
    const allEdges: Array<[string, string]> = [];

    for (const c of concepts) {
      conceptMap.set(c.id, { id: c.id, name: c.name, prerequisiteIds: c.prerequisiteIds });
      allIds.push(c.id);

      // Each prerequisite edge: prereq → concept
      for (const prereqId of c.prerequisiteIds) {
        allEdges.push([prereqId, c.id]);
      }
    }

    // 2. Load concept embeddings
    const embeddings = await batchLoadConceptEmbeddings(allIds);

    // 3. Load ConceptState for this user
    const states = await prisma.conceptState.findMany({
      where: { userId, conceptId: { in: allIds } },
      select: {
        conceptId: true,
        recallProbability: true,
        recentFailRate: true,
        confidence: true,
        responseVariance: true,
        probeCount: true,
      },
    });

    const healthMap = new Map<string, ConceptHealth>();
    for (const s of states) {
      healthMap.set(s.conceptId, {
        recallProbability: s.recallProbability,
        recentFailRate: s.recentFailRate,
        confidence: s.confidence,
        responseVariance: s.responseVariance,
        probeCount: s.probeCount,
      });
    }

    // 4. Call pure function
    return findUpstreamGaps(conceptId, conceptMap, healthMap, embeddings, allEdges);
  } catch (error) {
    logger.warn('getUpstreamGapsForConcept failed', { error: String(error), conceptId });
    return [];
  }
}
