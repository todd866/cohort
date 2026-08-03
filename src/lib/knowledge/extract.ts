/**
 * Fact Extraction
 *
 * Extract atomic facts from raw content using LLM.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ExtractedFact } from './types';
import { logger } from '@/lib/logger';

const ExtractedFactSchema = z.object({
  statement: z.string(),
  topics: z.array(z.string()),
  concepts: z.array(z.string()),
  confidence: z.number(),
});

const anthropic = new Anthropic();

const EXTRACTION_PROMPT = `You are a medical education expert extracting atomic facts from source material.

For each fact:
1. Make it a single, testable statement
2. Make it self-contained (understandable without surrounding context)
3. Focus on clinically relevant information
4. Include specific numbers, doses, criteria when present

Return a JSON array of facts:
[
  {
    "statement": "The first-line treatment for anaphylaxis is adrenaline 0.5mg IM",
    "topics": ["anaphylaxis", "emergency", "pharmacology"],
    "concepts": ["Anaphylaxis", "Adrenaline"],
    "confidence": 0.95
  }
]

Guidelines:
- Extract 5-15 facts per chunk of content
- Prefer specific over vague ("0.5mg IM" not "adrenaline")
- Include diagnostic criteria, treatment protocols, key numbers
- Skip filler text, introductions, transitions
- confidence: 0.9+ if explicitly stated, 0.7-0.9 if implied, <0.7 if uncertain

Content to extract from:
`;

export async function extractFacts(content: string): Promise<ExtractedFact[]> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: EXTRACTION_PROMPT + content,
      },
    ],
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';

  // Parse JSON from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.error('Failed to extract JSON from response', { responseText: text.slice(0, 200) });
    return [];
  }

  try {
    const raw = JSON.parse(jsonMatch[0]);
    const facts = z.array(ExtractedFactSchema).parse(raw);
    return facts.filter(
      (f) =>
        f.statement &&
        f.statement.length > 10 &&
        f.topics &&
        f.topics.length > 0
    );
  } catch (error) {
    logger.error('Failed to parse extracted facts', { error: String(error) });
    return [];
  }
}

/**
 * Chunk large content into smaller pieces for extraction.
 * Tries to split on paragraph boundaries.
 */
export function chunkContent(
  content: string,
  maxChunkSize: number = 3000
): string[] {
  if (content.length <= maxChunkSize) {
    return [content];
  }

  const chunks: string[] = [];
  const paragraphs = content.split(/\n\n+/);

  let currentChunk = '';
  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxChunkSize && currentChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = para;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + para;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}
