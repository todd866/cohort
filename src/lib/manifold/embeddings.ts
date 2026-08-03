/**
 * Embedding Generation (Gemini 2)
 *
 * Primary embedding generation for MD3.
 * Aligned to Gemini Embedding 2 (3072 dimensions).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Content, EmbedContentRequest } from '@google/generative-ai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@/lib/logger';
import { MANIFOLD_MODEL, STORED_MANIFOLD_DIM } from './config';

export interface EmbeddingResult {
  id: string;
  embedding: number[];
  tokenCount: number;
}

let genAI: GoogleGenerativeAI | null = null;
type EmbedRequestWithDim = EmbedContentRequest & { outputDimensionality: number };
type EmbeddingPart =
  | { text: string }
  | { inlineData: { data: string; mimeType: string } };

export interface EmbeddingInput {
  id: string;
  content: string;
  /** Public path such as /figures/cah/foo.webp. Optional; text-only when absent. */
  imageUrl?: string | null;
}

const SUPPORTED_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function imagePartFromPublicPath(imageUrl: string | null | undefined): EmbeddingPart | null {
  if (!imageUrl) return null;
  const cleanPath = imageUrl.startsWith('/') ? imageUrl.slice(1) : imageUrl;
  const fullPath = path.join(process.cwd(), 'public', cleanPath);
  if (!fs.existsSync(fullPath)) return null;

  const mimeType = SUPPORTED_IMAGE_MIME[path.extname(fullPath).toLowerCase()];
  if (!mimeType) return null;

  return {
    inlineData: {
      data: fs.readFileSync(fullPath).toString('base64'),
      mimeType,
    },
  };
}

function makeContent(text: string, imageUrl?: string | null): Content {
  const parts: EmbeddingPart[] = [{ text }];
  const imagePart = imagePartFromPublicPath(imageUrl);
  if (imagePart) parts.push(imagePart);
  return {
    role: 'user',
    parts,
  };
}

function makeEmbedRequest(text: string, imageUrl?: string | null): EmbedRequestWithDim {
  return {
    content: makeContent(text, imageUrl),
    outputDimensionality: STORED_MANIFOLD_DIM,
  };
}

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set in environment variables');
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

/**
 * Embed a single piece of content using the canonical manifold model.
 * Returns the full STORED_MANIFOLD_DIM vector (3072D).
 */
export async function embedContent(content: string, imageUrl?: string | null): Promise<number[]> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: MANIFOLD_MODEL });

  try {
    const result = await model.embedContent(makeEmbedRequest(content, imageUrl));

    return result.embedding.values;
  } catch (error) {
    logger.error('Error embedding content with Gemini', { error: String(error) });
    throw error;
  }
}

/**
 * Batch embed multiple pieces of content
 * Aligned to Gemini API patterns.
 */
export async function embedBatch(
  items: EmbeddingInput[],
  onProgress?: (completed: number, total: number) => void
): Promise<EmbeddingResult[]> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: MANIFOLD_MODEL });
  const results: EmbeddingResult[] = [];
  const total = items.length;

  // Gemini batch embed limit is 100 items per call
  const BATCH_SIZE = 100;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const hasImages = chunk.some((item) => !!item.imageUrl);

    if (hasImages) {
      for (const item of chunk) {
        try {
          const result = await model.embedContent(makeEmbedRequest(item.content, item.imageUrl));
          results.push({
            id: item.id,
            embedding: result.embedding.values,
            tokenCount: 0,
          });
        } catch (error) {
          logger.error('Error embedding multimodal item', { id: item.id, error: String(error) });
          results.push({ id: item.id, embedding: [], tokenCount: 0 });
        }
      }

      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, total), total);
      }
      continue;
    }

    try {
      const batchResult = await model.batchEmbedContents({
        requests: chunk.map((item) => makeEmbedRequest(item.content, item.imageUrl)),
      });

      for (let j = 0; j < chunk.length; j++) {
        results.push({
          id: chunk[j].id,
          embedding: batchResult.embeddings[j].values,
          tokenCount: 0, // Gemini doesn't report tokens per embedding in the same way OpenAI does
        });
      }

      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, total), total);
      }
    } catch (error) {
      logger.error('Error in batch embedding', { startIndex: i, error: String(error) });
      for (const item of chunk) {
        results.push({ id: item.id, embedding: [], tokenCount: 0 });
      }
    }
  }

  return results;
}

/**
 * Format card content for embedding
 */
export function formatCardForEmbedding(card: {
  front: string;
  back: string;
  context?: string | null;
  topics?: string[];
}): string {
  const parts = [card.front, card.back];
  if (card.context) parts.push(card.context);
  if (card.topics && card.topics.length > 0) {
    parts.push(`Topics: ${card.topics.join(', ')}`);
  }
  return parts.join('\n\n');
}

/**
 * Format concept content for embedding
 */
export function formatConceptForEmbedding(concept: {
  name: string;
  description?: string | null;
  topics?: string[];
}): string {
  const parts = [concept.name];
  if (concept.description) parts.push(concept.description);
  if (concept.topics && concept.topics.length > 0) {
    parts.push(`Topics: ${concept.topics.join(', ')}`);
  }
  return parts.join('\n\n');
}
