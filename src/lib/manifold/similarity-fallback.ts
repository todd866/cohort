/**
 * Keyword-based Similarity Fallback
 *
 * When embeddings aren't available, use topic/keyword matching
 * for card similarity. Less sophisticated but works without API keys.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export interface SimilarCardFallback {
  cardId: string;
  similarity: number;
  matchedTopics: string[];
}

/**
 * Find similar cards based on shared topics
 */
export async function findSimilarByTopics(
  cardId: string,
  limit: number = 10
): Promise<SimilarCardFallback[]> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true, rotation: true },
  });

  if (!card || card.topics.length === 0) {
    return [];
  }

  // Find cards with overlapping topics
  const similarCards = await prisma.card.findMany({
    where: {
      id: { not: cardId },
      topics: { hasSome: card.topics },
    },
    select: {
      id: true,
      topics: true,
      rotation: true,
    },
  });

  // Calculate Jaccard similarity based on topic overlap
  const results: SimilarCardFallback[] = similarCards.map((other) => {
    const intersection = card.topics.filter((t) => other.topics.includes(t));
    const union = [...new Set([...card.topics, ...other.topics])];
    const similarity = intersection.length / union.length;

    // Boost similarity for same rotation (concepts within same subject)
    const rotationBoost = other.rotation === card.rotation ? 0.1 : 0;

    return {
      cardId: other.id,
      similarity: Math.min(1, similarity + rotationBoost),
      matchedTopics: intersection,
    };
  });

  // Sort by similarity and return top matches
  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Find cross-rotation cards with shared topics
 */
export async function findCrossRotationByTopics(
  cardId: string,
  limit: number = 5
): Promise<SimilarCardFallback[]> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true, rotation: true },
  });

  if (!card || card.topics.length === 0) {
    return [];
  }

  // Find cards in OTHER rotations with overlapping topics
  const crossRotationCards = await prisma.card.findMany({
    where: {
      id: { not: cardId },
      rotation: { not: card.rotation },
      topics: { hasSome: card.topics },
    },
    select: {
      id: true,
      topics: true,
      rotation: true,
    },
  });

  const results: SimilarCardFallback[] = crossRotationCards.map((other) => {
    const intersection = card.topics.filter((t) => other.topics.includes(t));
    const union = [...new Set([...card.topics, ...other.topics])];
    const similarity = intersection.length / union.length;

    return {
      cardId: other.id,
      similarity,
      matchedTopics: intersection,
    };
  });

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Pre-compute and cache similar cards for all cards
 * Run this offline to populate Card.similarCards field
 */
export async function precomputeSimilarCards(): Promise<{
  processed: number;
  errors: number;
}> {
  const cards = await prisma.card.findMany({
    select: { id: true },
  });

  let processed = 0;
  let errors = 0;

  for (const card of cards) {
    try {
      const similar = await findSimilarByTopics(card.id, 10);

      await prisma.card.update({
        where: { id: card.id },
        data: {
          similarCards: similar.map((s) => ({
            cardId: s.cardId,
            similarity: s.similarity,
          })),
        },
      });

      processed++;

      if (processed % 100 === 0) {
        logger.info('Precompute progress', { processed, total: cards.length });
      }
    } catch (error) {
      logger.error('Error processing card', { cardId: card.id, error: String(error) });
      errors++;
    }
  }

  return { processed, errors };
}

/**
 * Check if embeddings are available
 */
export async function hasEmbeddings(): Promise<boolean> {
  try {
    const count = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM card_embeddings
    `;
    return Number(count[0].count) > 0;
  } catch {
    // Table might not exist
    return false;
  }
}
