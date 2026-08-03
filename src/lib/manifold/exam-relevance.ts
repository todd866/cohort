/**
 * Exam Manifold Estimation
 *
 * Implements Principle #8 from embedding-design-principles.md:
 * "Estimate exam coverage by measuring density of high-signal sources in embedding regions."
 *
 * The exam isn't given to us explicitly. We infer its coverage from multiple noisy signals:
 * - KAT practice questions (weight: 2.0) - exam-like, high signal
 * - Peer study notes (weight: 1.5) - what students prioritize
 * - Lecture content (weight: 0.8) - what's taught
 * - Textbook references (weight: 0.3) - comprehensive but not targeted
 *
 * Cards with high-signal convergence → high exam relevance
 */

import { prisma } from '@/lib/prisma';
import { getContentLakeDB, isContentLakeAvailable } from '@/lib/content-lake-client';
import { logger } from '@/lib/logger';
import OpenAI from 'openai';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

const CONTENT_LAKE_EMBEDDING_MODEL = 'text-embedding-3-small';
const CONTENT_LAKE_EMBEDDING_DIMENSIONS = 1536;

let openAIClient: OpenAI | null = null;

function getContentLakeEmbeddingClient(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!openAIClient) {
    openAIClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openAIClient;
}

async function embedForContentLakeSearch(text: string): Promise<number[] | null> {
  const client = getContentLakeEmbeddingClient();
  if (!client) return null;

  const response = await client.embeddings.create({
    model: CONTENT_LAKE_EMBEDDING_MODEL,
    dimensions: CONTENT_LAKE_EMBEDDING_DIMENSIONS,
    input: text.slice(0, 8_000),
  });

  return response.data[0]?.embedding ?? null;
}

// Default source weights (can be overridden per exam)
export const DEFAULT_SOURCE_WEIGHTS = {
  kat: 2.0,
  'kat-practice': 2.0,
  'peer-notes': 1.5,
  'peer-note': 1.5,
  notes: 1.5,
  lecture: 0.8,
  slides: 0.8,
  textbook: 0.3,
  ibcc: 0.5,
  litfl: 0.5,
  uptodate: 0.4,
  reference: 0.3,
} as const;

export type SourceType = keyof typeof DEFAULT_SOURCE_WEIGHTS;

interface NearbyChunk {
  chunkId: string;
  sourceType: string;
  sourceName: string;
  similarity: number;
  title: string;
  reliabilityTier: 'gold' | 'silver' | 'bronze';
}

interface ExamRelevanceResult {
  cardId: string;
  examId: string;
  relevance: number;
  breakdown: {
    katSignal: number;
    peerNoteSignal: number;
    lectureSignal: number;
    textbookSignal: number;
  };
  nearestSource?: {
    title: string;
    similarity: number;
  };
}

/**
 * Get a card's embedding for content-lake search
 */
async function getCardEmbeddingForSearch(cardId: string): Promise<Float32Array | null> {
  // First try to get the pre-computed card embedding
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { id: true, front: true, back: true, context: true, topics: true },
  });

  if (!card) {
    logger.warn('Card not found for exam relevance', { cardId });
    return null;
  }
  const [deliverableCard] = await filterDeliverableReinforcementCardRows([card], {
    logContext: { transport: 'exam-relevance-embedding' },
  });
  if (!deliverableCard) return null;

  // Content lake still uses its own 1536D OpenAI space; do not mix it with the
  // canonical Gemini manifold embeddings until that store is migrated.
  const cardText = [
    deliverableCard.front,
    deliverableCard.back,
    deliverableCard.context,
    deliverableCard.topics.length > 0 ? `Topics: ${deliverableCard.topics.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const embedding = await embedForContentLakeSearch(cardText);
    if (!embedding) return null;
    return new Float32Array(embedding);
  } catch (error) {
    logger.error('Failed to embed card for exam relevance', { cardId, error });
    return null;
  }
}

/**
 * Find content-lake chunks similar to a card embedding
 */
function findSimilarChunks(
  cardEmbedding: Float32Array,
  options: {
    minSimilarity: number;
    limit: number;
  }
): NearbyChunk[] {
  if (!isContentLakeAvailable()) {
    logger.warn('Content lake not available for exam relevance');
    return [];
  }

  const db = getContentLakeDB();
  const results = db.semanticSearch(
    cardEmbedding,
    options.limit,
    options.minSimilarity
  );

  return results.map((r) => ({
    chunkId: r.chunkId,
    sourceType: inferSourceType(r.sourceName),
    sourceName: r.sourceName,
    similarity: r.similarity,
    title: r.articleTitle,
    reliabilityTier: r.reliabilityTier,
  }));
}

/**
 * Infer source type from source name for weighting
 */
function inferSourceType(sourceName: string): string {
  const lower = sourceName.toLowerCase();
  if (lower.includes('kat') || lower.includes('practice')) return 'kat';
  if (lower.includes('note') || lower.includes('peer') || lower.includes('student'))
    return 'peer-notes';
  if (lower.includes('lecture') || lower.includes('slide')) return 'lecture';
  if (lower.includes('ibcc')) return 'ibcc';
  if (lower.includes('litfl')) return 'litfl';
  if (lower.includes('uptodate')) return 'uptodate';
  return 'textbook';
}

/**
 * Compute exam relevance for a single card
 */
export async function computeCardExamRelevance(
  cardId: string,
  examId: string,
  options?: {
    searchRadius?: number; // Cosine similarity threshold (default: 0.5)
    maxChunks?: number; // Max nearby chunks to consider (default: 50)
  }
): Promise<ExamRelevanceResult> {
  const { searchRadius = 0.5, maxChunks = 50 } = options || {};

  // Get exam definition for custom weights
  const exam = await prisma.examDefinition.findUnique({
    where: { slug: examId },
  });

  const weights = {
    kat: exam?.katWeight ?? DEFAULT_SOURCE_WEIGHTS.kat,
    peerNote: exam?.peerNoteWeight ?? DEFAULT_SOURCE_WEIGHTS['peer-notes'],
    lecture: exam?.lectureWeight ?? DEFAULT_SOURCE_WEIGHTS.lecture,
    textbook: exam?.textbookWeight ?? DEFAULT_SOURCE_WEIGHTS.textbook,
  };

  // Get card embedding
  const cardEmbedding = await getCardEmbeddingForSearch(cardId);
  if (!cardEmbedding) {
    return {
      cardId,
      examId,
      relevance: 0,
      breakdown: {
        katSignal: 0,
        peerNoteSignal: 0,
        lectureSignal: 0,
        textbookSignal: 0,
      },
    };
  }

  // Find chunks near this card in embedding space
  const nearbyChunks = findSimilarChunks(cardEmbedding, {
    minSimilarity: searchRadius,
    limit: maxChunks,
  });

  // Compute weighted signals
  let katSignal = 0;
  let peerNoteSignal = 0;
  let lectureSignal = 0;
  let textbookSignal = 0;
  let nearestSource: { title: string; similarity: number } | undefined;

  for (const chunk of nearbyChunks) {
    const sourceWeight = getSourceWeight(chunk.sourceType, weights);
    const signal = sourceWeight * chunk.similarity;

    // Categorize into buckets
    if (isKatSource(chunk.sourceType)) {
      katSignal += signal;
    } else if (isPeerNoteSource(chunk.sourceType)) {
      peerNoteSignal += signal;
    } else if (isLectureSource(chunk.sourceType)) {
      lectureSignal += signal;
    } else {
      textbookSignal += signal;
    }

    // Track nearest high-signal source for explainability
    if (
      signal > 0.5 &&
      (!nearestSource || chunk.similarity > nearestSource.similarity)
    ) {
      nearestSource = {
        title: chunk.title || `${chunk.sourceType} chunk`,
        similarity: chunk.similarity,
      };
    }
  }

  const relevance = katSignal + peerNoteSignal + lectureSignal + textbookSignal;

  return {
    cardId,
    examId,
    relevance,
    breakdown: {
      katSignal,
      peerNoteSignal,
      lectureSignal,
      textbookSignal,
    },
    nearestSource,
  };
}

/**
 * Batch compute exam relevance for all cards in scope
 */
export async function computeExamRelevanceBatch(
  examId: string,
  options?: {
    batchSize?: number;
    onProgress?: (completed: number, total: number) => void;
  }
): Promise<{ computed: number; errors: number }> {
  const { batchSize = 10, onProgress } = options || {};

  // Get exam definition
  const exam = await prisma.examDefinition.findUnique({
    where: { slug: examId },
  });

  if (!exam) {
    throw new Error(`Exam not found: ${examId}`);
  }

  // Get all cards in scope (by module nodes)
  const cards = await prisma.card.findMany({
    where:
      exam.moduleNodes.length > 0
        ? { moduleNodes: { hasSome: exam.moduleNodes } }
        : {},
    select: { id: true },
  });

  logger.info('Computing exam relevance batch', {
    examId,
    cardCount: cards.length,
  });

  let computed = 0;
  let errors = 0;

  // Process in batches (smaller batches due to embedding cost)
  for (let i = 0; i < cards.length; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);

    // Process batch sequentially to avoid rate limits
    for (const card of batch) {
      try {
        const result = await computeCardExamRelevance(card.id, examId);

        // Upsert the result
        await prisma.cardExamRelevance.upsert({
          where: {
            cardId_examId: { cardId: card.id, examId },
          },
          create: {
            cardId: card.id,
            examId,
            relevance: result.relevance,
            katSignal: result.breakdown.katSignal,
            peerNoteSignal: result.breakdown.peerNoteSignal,
            lectureSignal: result.breakdown.lectureSignal,
            textbookSignal: result.breakdown.textbookSignal,
            nearestSource: result.nearestSource?.title,
            nearestSimilarity: result.nearestSource?.similarity,
          },
          update: {
            relevance: result.relevance,
            katSignal: result.breakdown.katSignal,
            peerNoteSignal: result.breakdown.peerNoteSignal,
            lectureSignal: result.breakdown.lectureSignal,
            textbookSignal: result.breakdown.textbookSignal,
            nearestSource: result.nearestSource?.title,
            nearestSimilarity: result.nearestSource?.similarity,
            computedAt: new Date(),
          },
        });

        computed++;
      } catch (error) {
        logger.error('Error computing relevance for card', { cardId: card.id, error });
        errors++;
      }
    }

    onProgress?.(Math.min(i + batchSize, cards.length), cards.length);
  }

  logger.info('Exam relevance batch complete', { examId, computed, errors });
  return { computed, errors };
}

/**
 * Get high-yield cards for an exam (sorted by relevance)
 */
export async function getHighYieldCards(
  examId: string,
  options?: {
    minRelevance?: number;
    limit?: number;
  }
): Promise<Array<{ cardId: string; relevance: number; nearestSource?: string }>> {
  const { minRelevance = 1.0, limit = 100 } = options || {};

  const results = await prisma.cardExamRelevance.findMany({
    where: {
      examId,
      relevance: { gte: minRelevance },
    },
    orderBy: { relevance: 'desc' },
    take: limit,
    select: {
      cardId: true,
      relevance: true,
      nearestSource: true,
    },
  });

  return results.map((r) => ({
    cardId: r.cardId,
    relevance: r.relevance,
    nearestSource: r.nearestSource ?? undefined,
  }));
}

/**
 * Create or update an exam definition
 */
export async function upsertExamDefinition(data: {
  slug: string;
  name: string;
  moduleNodes: string[];
  examDate?: Date;
  katWeight?: number;
  peerNoteWeight?: number;
  lectureWeight?: number;
  textbookWeight?: number;
}) {
  return prisma.examDefinition.upsert({
    where: { slug: data.slug },
    create: data,
    update: data,
  });
}

// Helper functions
function getSourceWeight(
  sourceType: string,
  weights: { kat: number; peerNote: number; lecture: number; textbook: number }
): number {
  if (isKatSource(sourceType)) return weights.kat;
  if (isPeerNoteSource(sourceType)) return weights.peerNote;
  if (isLectureSource(sourceType)) return weights.lecture;
  return weights.textbook;
}

function isKatSource(sourceType: string): boolean {
  return (
    sourceType.toLowerCase().includes('kat') ||
    sourceType.toLowerCase().includes('practice')
  );
}

function isPeerNoteSource(sourceType: string): boolean {
  return (
    sourceType.toLowerCase().includes('peer') ||
    sourceType.toLowerCase().includes('note') ||
    sourceType.toLowerCase().includes('student')
  );
}

function isLectureSource(sourceType: string): boolean {
  return (
    sourceType.toLowerCase().includes('lecture') ||
    sourceType.toLowerCase().includes('slide')
  );
}
