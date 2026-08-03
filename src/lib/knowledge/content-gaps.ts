/**
 * Content Gap Detection
 *
 * Records sparse regions in the embedding space detected during scheduling.
 * Gaps are classified by type and deduplicated to avoid flooding.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

/** 7-day deduplication window */
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type GapType = 'format_gap' | 'pedagogical_gap' | 'true_gap';

interface GapClassificationInput {
  totalCandidates: number;
  cardCount: number;
  questionCount: number;
  /** Number of distinct similarity bands with content (1-3) */
  bandSpread: number;
}

/**
 * Classify the type of content gap based on candidate analysis.
 */
export function classifyGap(input: GapClassificationInput): GapType {
  if (input.totalCandidates < 3) return 'true_gap';
  if (input.cardCount === 0 || input.questionCount === 0) return 'format_gap';
  if (input.bandSpread <= 1) return 'pedagogical_gap';
  return 'format_gap'; // default to least severe
}

interface RecordGapInput {
  conceptId: string | null;
  rotation: string;
  gapType: GapType;
  nearestSimilarity: number;
  candidateCount: number;
}

/**
 * Record a content gap, with 7-day deduplication.
 */
export async function recordContentGap(input: RecordGapInput): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
    const existing = await prisma.contentGap.findFirst({
      where: {
        conceptId: input.conceptId,
        gapType: input.gapType,
        resolvedAt: null,
        detectedAt: { gte: cutoff },
      },
    });

    if (existing) return;

    await prisma.contentGap.create({
      data: {
        conceptId: input.conceptId,
        rotation: input.rotation,
        gapType: input.gapType,
        nearestSimilarity: input.nearestSimilarity,
        candidateCount: input.candidateCount,
      },
    });
  } catch (error) {
    logger.error('Failed to record content gap', { error: String(error) });
  }
}

/**
 * Get unresolved gaps for a rotation, ordered by severity.
 */
export async function getUnresolvedGaps(rotation: string) {
  return prisma.contentGap.findMany({
    where: { rotation, resolvedAt: null },
    orderBy: [{ nearestSimilarity: 'asc' }, { detectedAt: 'desc' }],
  });
}

/**
 * Mark gaps as resolved when new content is added for a concept.
 */
export async function resolveGapsForConcept(conceptId: string): Promise<void> {
  await prisma.contentGap.updateMany({
    where: { conceptId, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
}
