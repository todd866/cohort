/**
 * Gap Analysis
 *
 * Computes the gap between the exam target (what the exam covers) and the
 * user's knowledge vector (what the user knows). The gap direction points
 * toward content the user needs to study.
 *
 * Used by the scheduler to bias study sessions toward cold spots.
 */

import { prisma } from '@/lib/prisma';
import { cosineSimilarity } from '@/lib/math/vector-math';
import { l2Normalize } from './exam-target';
import { STORED_MANIFOLD_DIM } from './config';

// =============================================================================
// Pure functions (exported for testing)
// =============================================================================

/**
 * Compute the gap direction vector: l2_normalize(target - knowledge).
 * Points from where the user is toward where the exam is.
 */
export function computeGapDirection(target: number[], knowledge: number[]): number[] {
  const dim = Math.min(target.length, knowledge.length);
  if (dim === 0) return [];

  const diff = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    diff[i] = target[i] - knowledge[i];
  }
  return l2Normalize(diff);
}

export interface WeekGap {
  week: number;
  /** cos(week_centroid, target) - cos(week_centroid, knowledge) */
  gap: number;
  /** How relevant this week is to the exam */
  examRelevance: number;
  /** How well the user knows this week */
  userCoverage: number;
}

/**
 * Compute per-week gap scores.
 * A positive gap means the exam covers this week more than the user does.
 */
export function computeWeekGaps(
  weekCentroids: Map<number, number[]>,
  target: number[],
  knowledge: number[]
): WeekGap[] {
  if (weekCentroids.size === 0) return [];

  const gaps: WeekGap[] = [];

  for (const [week, centroid] of weekCentroids) {
    const dim = Math.min(centroid.length, target.length, knowledge.length);
    if (dim === 0) continue;

    const alignedCentroid = centroid.slice(0, dim);
    const alignedTarget = target.slice(0, dim);
    const alignedKnowledge = knowledge.slice(0, dim);

    const examRelevance = cosineSimilarity(alignedCentroid, alignedTarget);
    const userCoverage = cosineSimilarity(alignedCentroid, alignedKnowledge);
    const gap = examRelevance - userCoverage;

    gaps.push({ week, gap, examRelevance, userCoverage });
  }

  // Sort by gap descending (biggest gaps first)
  gaps.sort((a, b) => b.gap - a.gap);
  return gaps;
}

// =============================================================================
// Database functions
// =============================================================================

export interface ColdSpot {
  chunkId: string;
  sourceFile: string;
  sourceType: string;
  week: number | null;
  /** How relevant to exam but missing from user knowledge */
  gapScore: number;
  /** Short preview of the chunk text */
  preview: string;
}

/**
 * Find courseware chunks that are most relevant to the exam target
 * but least covered by the user's knowledge.
 */
export async function findColdSpots(
  gapDirection: number[],
  rotation: string,
  limit: number = 10
): Promise<ColdSpot[]> {
  if (gapDirection.length !== STORED_MANIFOLD_DIM) return [];

  try {
    const vectorJson = JSON.stringify(gapDirection);
    const lim = Number(limit);

    const rows = await prisma.$queryRaw<
      Array<{
        chunk_id: string;
        source_file: string;
        source_type: string;
        week: number | null;
        similarity: number;
        chunk_text: string;
      }>
    >`
      SELECT
        chunk_id,
        source_file,
        source_type,
        week,
        (1 - (embedding <=> ${vectorJson}::halfvec))::float as similarity,
        LEFT(chunk_text, 200) as chunk_text
      FROM courseware_embeddings
      WHERE rotation = ${rotation}
      ORDER BY embedding <=> ${vectorJson}::halfvec
      LIMIT ${lim}::int
    `;

    return rows.map((r) => ({
      chunkId: r.chunk_id,
      sourceFile: r.source_file,
      sourceType: r.source_type,
      week: r.week,
      gapScore: r.similarity,
      preview: r.chunk_text,
    }));
  } catch {
    return [];
  }
}

/**
 * Find cards that are most aligned with the gap direction.
 * These are cards the user should study to close the gap.
 */
export async function findGapAlignedContent(
  gapDirection: number[],
  rotation: string,
  limit: number = 20
): Promise<Array<{ cardId: string; similarity: number }>> {
  if (gapDirection.length !== STORED_MANIFOLD_DIM) return [];

  try {
    const vectorJson = JSON.stringify(gapDirection);
    const lim = Number(limit);

    return await prisma.$queryRaw<Array<{ cardId: string; similarity: number }>>`
      SELECT
        ce.card_id as "cardId",
        (1 - (ce.embedding <=> ${vectorJson}::halfvec))::float as similarity
      FROM card_embeddings ce
      JOIN "Card" c ON c.id = ce.card_id
      WHERE c.rotation = ${rotation}
      ORDER BY ce.embedding <=> ${vectorJson}::halfvec
      LIMIT ${lim}::int
    `;
  } catch {
    return [];
  }
}

// =============================================================================
// High-level analysis
// =============================================================================

export interface GapAnalysis {
  gapDirection: number[];
  weekGaps: WeekGap[];
  coldSpots: ColdSpot[];
  gapAlignedCards: Array<{ cardId: string; similarity: number }>;
}

/**
 * Full gap analysis: computes gap direction, week gaps, cold spots,
 * and gap-aligned content for a user.
 */
export async function analyzeGaps(
  target: { centroid: number[]; weekCentroids: Map<number, number[]> },
  knowledge: { knowledgeVector: number[] },
  rotation: string
): Promise<GapAnalysis> {
  const gapDirection = computeGapDirection(target.centroid, knowledge.knowledgeVector);
  const weekGaps = computeWeekGaps(target.weekCentroids, target.centroid, knowledge.knowledgeVector);
  const coldSpots = await findColdSpots(gapDirection, rotation);
  const gapAlignedCards = await findGapAlignedContent(gapDirection, rotation);

  return { gapDirection, weekGaps, coldSpots, gapAlignedCards };
}
