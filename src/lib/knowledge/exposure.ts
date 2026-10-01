/**
 * Exposure Logging System
 *
 * Tracks and normalizes all learning interactions into exposure events.
 * Each interaction (page read, card review, MCQ attempt, etc.) creates
 * a normalized exposure event that feeds into the unified knowledge state.
 *
 * This module now delegates to the unified LearningEvent system.
 * See docs/designs/2026-01-17-unified-learning-state.md
 */

import { prisma } from '@/lib/prisma';
import { expandTopicSet } from '@/lib/topics';
import {
  ExposureInput,
  ExposureType,
  EXPOSURE_WEIGHTS,
} from './types';
import { recordLearningEvent, type LearningEventType } from '@/lib/learning';

/**
 * Compute the strength (0-1) of an exposure based on type and metadata
 */
export function computeExposureStrength(input: ExposureInput): number {
  const { exposureType, metadata = {} } = input;

  switch (exposureType) {
    case 'page_read': {
      const {
        scrollDepth = 1,
        durationSeconds = EXPOSURE_WEIGHTS.page_read.durationCap,
        expectedReadingTime: rawExpectedTime, // Seconds expected to read the page (from PageMetadata)
      } = metadata;
      const expectedReadingTime =
        typeof rawExpectedTime === 'number' ? rawExpectedTime : undefined;

      const durationMultiplier = Math.min(1, durationSeconds / EXPOSURE_WEIGHTS.page_read.durationCap);
      const scrollMultiplier = scrollDepth * EXPOSURE_WEIGHTS.page_read.scrollMultiplier;

      // Reading pace multiplier: actual time vs expected time
      // - Too fast (<0.3): skimmed → reduce strength
      // - Normal (0.3-1.5): engaged reading → full strength
      // - Slow (1.5-3.0): deep reading/re-reading → boost strength
      // - Too slow (>3.0): probably distracted/away → reduce strength
      let paceMultiplier = 1.0;
      if (expectedReadingTime && durationSeconds) {
        const readingPace = durationSeconds / expectedReadingTime;
        if (readingPace < 0.3) {
          paceMultiplier = 0.5; // Skimmed
        } else if (readingPace <= 1.5) {
          paceMultiplier = 1.0; // Normal reading
        } else if (readingPace <= 3.0) {
          paceMultiplier = 1.2; // Deep reading
        } else {
          paceMultiplier = 0.7; // Distracted
        }
      }

      // Use the larger of scroll/duration multipliers, then apply pace
      let baseMultiplier: number;
      if (metadata.scrollDepth !== undefined && metadata.durationSeconds !== undefined) {
        baseMultiplier = (scrollMultiplier + durationMultiplier) / 2;
      } else if (metadata.scrollDepth !== undefined) {
        baseMultiplier = scrollMultiplier;
      } else if (metadata.durationSeconds !== undefined) {
        baseMultiplier = durationMultiplier;
      } else {
        baseMultiplier = 1.0;
      }

      return EXPOSURE_WEIGHTS.page_read.base * baseMultiplier * paceMultiplier;
    }

    case 'content_expanded': {
      const { expandedDurationSeconds = EXPOSURE_WEIGHTS.content_expanded.durationCap } = metadata;
      const durationMultiplier = Math.min(1, expandedDurationSeconds / EXPOSURE_WEIGHTS.content_expanded.durationCap);
      return EXPOSURE_WEIGHTS.content_expanded.base * durationMultiplier;
    }

    case 'video_watched': {
      return EXPOSURE_WEIGHTS.video_watched.base;
    }

    case 'card_reviewed': {
      const quality = metadata.quality ?? 3;
      // Interpolate between quality levels
      if (quality <= 0) return EXPOSURE_WEIGHTS.card_reviewed.quality0;
      if (quality >= 5) return EXPOSURE_WEIGHTS.card_reviewed.quality5;
      if (quality <= 3) {
        // Interpolate between quality0 and quality3
        const t = quality / 3;
        return EXPOSURE_WEIGHTS.card_reviewed.quality0 +
          t * (EXPOSURE_WEIGHTS.card_reviewed.quality3 - EXPOSURE_WEIGHTS.card_reviewed.quality0);
      }
      // Interpolate between quality3 and quality5
      const t = (quality - 3) / 2;
      return EXPOSURE_WEIGHTS.card_reviewed.quality3 +
        t * (EXPOSURE_WEIGHTS.card_reviewed.quality5 - EXPOSURE_WEIGHTS.card_reviewed.quality3);
    }

    case 'mcq_attempted': {
      const isCorrect = metadata.isCorrect ?? false;
      return isCorrect
        ? EXPOSURE_WEIGHTS.mcq_attempted.correct
        : EXPOSURE_WEIGHTS.mcq_attempted.wrong;
    }

    case 'mcq_self_assessed': {
      const quality = metadata.quality ?? 3;
      if (quality <= 0) return EXPOSURE_WEIGHTS.mcq_self_assessed.quality0;
      if (quality >= 5) return EXPOSURE_WEIGHTS.mcq_self_assessed.quality5;
      if (quality <= 3) {
        const t = quality / 3;
        return EXPOSURE_WEIGHTS.mcq_self_assessed.quality0 +
          t * (EXPOSURE_WEIGHTS.mcq_self_assessed.quality3 - EXPOSURE_WEIGHTS.mcq_self_assessed.quality0);
      }
      const t = (quality - 3) / 2;
      return EXPOSURE_WEIGHTS.mcq_self_assessed.quality3 +
        t * (EXPOSURE_WEIGHTS.mcq_self_assessed.quality5 - EXPOSURE_WEIGHTS.mcq_self_assessed.quality3);
    }

    case 'table_quiz': {
      const accuracy = metadata.accuracy ?? 1;
      return EXPOSURE_WEIGHTS.table_quiz.base * accuracy;
    }

    case 'image_occlusion': {
      const accuracy = metadata.accuracy ?? 1;
      return EXPOSURE_WEIGHTS.image_occlusion.base * accuracy;
    }

    case 'skill_drill': {
      return EXPOSURE_WEIGHTS.skill_drill.base;
    }

    default:
      return 0.1; // Unknown type, minimal strength
  }
}

/**
 * Determine if an exposure type is a "probe" (active test vs passive exposure)
 * Probes update lastProbeAt and have higher signal value
 */
export function isProbeType(exposureType: ExposureType): boolean {
  return [
    'card_reviewed',
    'mcq_attempted',
    'mcq_self_assessed',
    'table_quiz',
    'image_occlusion',
    'skill_drill',
  ].includes(exposureType);
}

/**
 * Get concept IDs for a source
 * Uses explicit conceptIds if provided, otherwise looks up from source
 */
export async function getConceptsForSource(
  input: ExposureInput
): Promise<string[]> {
  // If explicit concepts provided, use them
  if (input.conceptIds && input.conceptIds.length > 0) {
    return input.conceptIds;
  }

  // Look up concepts based on source
  const { sourceType, sourceId } = input;

  if (!sourceType || !sourceId) {
    return [];
  }

  switch (sourceType) {
    case 'card': {
      // Get card's topics and find matching concepts
      const card = await prisma.card.findUnique({
        where: { id: sourceId },
        select: { topics: true, rotation: true },
      });
      if (!card) return [];

      // Find concepts that match the card's topics
      const expandedTopics = expandTopicSet(card.topics);
      const concepts = await prisma.concept.findMany({
        where: {
          rotation: card.rotation,
          topics: { hasSome: expandedTopics },
        },
        select: { id: true },
        take: 5, // Limit to top 5 matching concepts
      });
      return concepts.map((c) => c.id);
    }

    case 'question': {
      // Get question's linked concepts
      const question = await prisma.question.findUnique({
        where: { id: sourceId },
        select: {
          concepts: {
            select: { conceptId: true, isPrimary: true },
          },
          topics: true,
          rotation: true,
        },
      });
      if (!question) return [];

      // Use explicit concept links if available
      if (question.concepts.length > 0) {
        const primary = question.concepts.filter((c) => c.isPrimary);
        if (primary.length > 0) return primary.map((c) => c.conceptId);

        // Legacy data may not set `isPrimary`. To avoid over-updating mastery
        // for loosely tagged questions, default to a single concept.
        return [question.concepts[0].conceptId];
      }

      // Fall back to topic matching
      const expandedTopics = expandTopicSet(question.topics);
      const concepts = await prisma.concept.findMany({
        where: {
          rotation: question.rotation,
          topics: { hasSome: expandedTopics },
        },
        select: { id: true },
        take: 5,
      });
      return concepts.map((c) => c.id);
    }

    case 'page': {
      // Rotation week pages: "/critical-care/week/1"
      const match = sourceId.match(/\/([^/]+)\/week\/(\d+)/);
      if (match) {
        const [, rotation, weekStr] = match;
        const week = parseInt(weekStr, 10);

        const concepts = await prisma.concept.findMany({
          where: {
            rotation,
            week,
          },
          select: { id: true },
        });
        return concepts.map((c) => c.id);
      }

      return [];
    }

    case 'video': {
      const videoLinks = await prisma.videoConcept.findMany({
        where: { videoId: sourceId },
        select: { conceptId: true },
      });
      return videoLinks.map((l) => l.conceptId);
    }

    default:
      return [];
  }
}

/**
 * Log an exposure event
 *
 * Now delegates entirely to the unified LearningEvent system.
 * ConceptState is updated by recordLearningEvent.
 */
export async function logExposure(input: ExposureInput): Promise<{
  exposureId: string;
  conceptIds: string[];
  strength: number;
}> {
  const strength = computeExposureStrength(input);
  const conceptIds = await getConceptsForSource(input);

  // Map exposure type to learning event type
  const eventTypeMap: Partial<Record<ExposureType, LearningEventType>> = {
    page_read: 'page_read',
    content_expanded: 'content_expanded',
    card_reviewed: 'card_reviewed',
    mcq_attempted: 'mcq_attempted',
    mcq_self_assessed: 'self_assessed',
    video_watched: 'video_watched',
    table_quiz: 'assessment_attempted',
    image_occlusion: 'assessment_attempted',
    skill_drill: 'assessment_attempted',
  };

  // Map source types
  const sourceTypeMap: Record<NonNullable<typeof input.sourceType>, 'card' | 'question' | 'page'> = {
    card: 'card',
    question: 'question',
    page: 'page',
    table: 'page',
    image: 'page',
    skill: 'page',
    video: 'page',
  };

  // Infer rotation/week from source path
  let rotation: string | undefined;
  let week: number | undefined;
  if (input.sourceType === 'page' && input.sourceId) {
    const match = input.sourceId.match(/\/([^/]+)\/week\/(\d+)/);
    if (match) {
      rotation = match[1];
      week = parseInt(match[2], 10);
    }
  }

  // Single write path: LearningEvent + ConceptState
  const accuracy = input.metadata?.accuracy;
  const quality = typeof input.metadata?.quality === 'number'
    ? input.metadata.quality
    : typeof accuracy === 'number'
      ? Math.max(0, Math.min(5, Math.round(accuracy * 5)))
      : undefined;
  const result = await recordLearningEvent({
    userId: input.userId,
    eventType: eventTypeMap[input.exposureType] ?? 'page_read',
    sourceType: input.sourceType ? sourceTypeMap[input.sourceType] : 'page',
    sourceId: input.sourceId ?? 'unknown',
    quality,
    isCorrect: input.metadata?.isCorrect as boolean | undefined,
    conceptIds,
    rotation,
    week,
    metadata: input.metadata as Record<string, unknown> | undefined,
  });

  return {
    exposureId: result.eventId,
    conceptIds,
    strength,
  };
}
