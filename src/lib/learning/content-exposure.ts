/**
 * Content Exposure Tracking
 *
 * Tracks when related/adjacent content is shown alongside primary content.
 * Part of the Learning Analytics System for empirical transfer graph and
 * high-dimensional interaction capture.
 *
 * Usage:
 * - Log exposure when showing lake citations, related cards, etc.
 * - Mark engagement when user clicks/expands the content
 * - Query for transfer analysis to build empirical learning adjacency
 */

import { prisma } from '@/lib/prisma';
import type { ContentExposure } from '@prisma/client';

// =============================================================================
// Types
// =============================================================================

export type PrimaryContentType = 'card' | 'question' | 'page' | 'deep_dive';
export type ExposureType = 'lake_chunk' | 'related_card' | 'citation' | 'recommendation';
export type ExposureReason = 'semantic_similarity' | 'same_topic' | 'remediation' | 'random';

export interface ContentExposureInput {
  userId: string;

  // What they were primarily engaging with
  primaryType: PrimaryContentType;
  primaryId: string;

  // What related content we showed them
  exposedType: ExposureType;
  exposedId: string;

  // Why we showed it
  exposureReason: ExposureReason;
  similarityScore?: number;

  // Optional context
  sessionId?: string;
  positionInSession?: number;
  daysUntilExam?: number;
  displayed?: boolean;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Log when related content is exposed alongside primary content.
 *
 * Call this when:
 * - Lake citations are shown on a card detail page
 * - Related cards are recommended during review
 * - Deep dive links are displayed
 * - Any adjacent/related content is surfaced to the user
 */
export async function logContentExposure(
  input: ContentExposureInput
): Promise<ContentExposure> {
  const {
    userId,
    primaryType,
    primaryId,
    exposedType,
    exposedId,
    exposureReason,
    similarityScore,
    sessionId,
    positionInSession,
    daysUntilExam,
    displayed = true,
  } = input;

  const exposure = await prisma.contentExposure.create({
    data: {
      userId,
      primaryType,
      primaryId,
      exposedType,
      exposedId,
      exposureReason,
      similarityScore,
      sessionId,
      positionInSession,
      daysUntilExam,
      displayed,
      engaged: false,
    },
  });

  return exposure;
}

/**
 * Mark a content exposure as engaged.
 *
 * Call this when the user clicks/expands the exposed content.
 * Optionally track engagement duration.
 *
 * Scoped by userId so a caller can only mark their OWN exposure — updating
 * by id alone was an IDOR (any authenticated user could overwrite another
 * user's engagement row by guessing its id). Returns null if no row matches
 * (wrong id or not owned by the caller).
 */
export async function markExposureEngaged(
  exposureId: string,
  userId: string,
  engagementMs?: number
): Promise<ContentExposure | null> {
  const result = await prisma.contentExposure.updateMany({
    where: { id: exposureId, userId },
    data: {
      engaged: true,
      engagementMs,
    },
  });

  if (result.count === 0) return null;

  return prisma.contentExposure.findUnique({ where: { id: exposureId } });
}

/**
 * Batch log multiple content exposures (for when many items are shown at once).
 *
 * Call this when:
 * - Multiple lake citations are displayed
 * - A list of related cards is shown
 * - Multiple recommendations are surfaced
 */
export async function logMultipleExposures(
  baseInput: Omit<ContentExposureInput, 'exposedId' | 'similarityScore'>,
  exposedItems: Array<{ exposedId: string; similarityScore?: number }>
): Promise<ContentExposure[]> {
  const exposures = await Promise.all(
    exposedItems.map((item) =>
      logContentExposure({
        ...baseInput,
        exposedId: item.exposedId,
        similarityScore: item.similarityScore,
      })
    )
  );

  return exposures;
}

/**
 * Get content exposures for a user within a time range.
 *
 * Useful for computing transfer observations.
 */
export async function getRecentExposures(
  userId: string,
  options: {
    sinceTimestamp?: Date;
    exposedType?: ExposureType;
    engagedOnly?: boolean;
    limit?: number;
  } = {}
): Promise<ContentExposure[]> {
  const {
    sinceTimestamp = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Default 7 days
    exposedType,
    engagedOnly = false,
    limit = 100,
  } = options;

  const exposures = await prisma.contentExposure.findMany({
    where: {
      userId,
      timestamp: { gte: sinceTimestamp },
      ...(exposedType && { exposedType }),
      ...(engagedOnly && { engaged: true }),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });

  return exposures;
}

/**
 * Get engagement stats for a primary content item.
 *
 * Returns how many exposures were shown and engaged for a given card/question/page.
 */
export async function getExposureStats(
  primaryType: PrimaryContentType,
  primaryId: string
): Promise<{
  totalExposures: number;
  engagedExposures: number;
  engagementRate: number;
  avgEngagementMs: number | null;
}> {
  const exposures = await prisma.contentExposure.findMany({
    where: { primaryType, primaryId },
    select: { engaged: true, engagementMs: true },
  });

  const totalExposures = exposures.length;
  const engagedExposures = exposures.filter((e) => e.engaged).length;
  const engagementRate = totalExposures > 0 ? engagedExposures / totalExposures : 0;

  const engagementTimes = exposures
    .filter((e) => e.engaged && e.engagementMs !== null)
    .map((e) => e.engagementMs as number);

  const avgEngagementMs =
    engagementTimes.length > 0
      ? engagementTimes.reduce((a, b) => a + b, 0) / engagementTimes.length
      : null;

  return {
    totalExposures,
    engagedExposures,
    engagementRate,
    avgEngagementMs,
  };
}
