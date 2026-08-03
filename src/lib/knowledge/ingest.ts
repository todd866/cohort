/**
 * Content Ingestion
 *
 * Ingest raw content, extract facts, deduplicate, store.
 */

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { extractFacts, chunkContent } from './extract';
import type { IngestRequest, IngestResult, ExtractedFact } from './types';

/**
 * Ingest raw content and extract facts into the knowledge store.
 */
export async function ingestContent(
  request: IngestRequest
): Promise<IngestResult> {
  const { content, source, rotation, week } = request;

  // Chunk content if needed
  const chunks = chunkContent(content);
  logger.info(`Processing ${chunks.length} chunks from ${source}`);

  // Extract facts from each chunk
  const allFacts: ExtractedFact[] = [];
  for (const chunk of chunks) {
    const facts = await extractFacts(chunk);
    allFacts.push(...facts);
  }

  logger.info(`Extracted ${allFacts.length} facts`);

  // Store facts (with basic deduplication)
  const result: IngestResult = {
    factsCreated: 0,
    factsUpdated: 0,
    factIds: [],
  };

  for (const fact of allFacts) {
    const stored = await storeFact(fact, source, rotation, week);
    result.factIds.push(stored.id);
    if (stored.created) {
      result.factsCreated++;
    } else {
      result.factsUpdated++;
    }
  }

  return result;
}

/**
 * Store a single fact, deduplicating by similar statement.
 */
async function storeFact(
  fact: ExtractedFact,
  source: string,
  rotation: string,
  week: number
): Promise<{ id: string; created: boolean }> {
  // Check for existing similar fact (exact match for now)
  // TODO: Use embeddings for fuzzy deduplication
  const existing = await prisma.fact.findFirst({
    where: {
      statement: fact.statement,
      rotation,
    },
  });

  if (existing) {
    // Add citation if not already present
    const citations = existing.citations as string[];
    if (!citations.includes(source)) {
      await prisma.fact.update({
        where: { id: existing.id },
        data: {
          citations: [...citations, source],
        },
      });
    }
    return { id: existing.id, created: false };
  }

  // Create new fact
  const created = await prisma.fact.create({
    data: {
      statement: fact.statement,
      citations: [source],
      rotation,
      week,
      topics: fact.topics,
      examWeight: fact.confidence, // Use confidence as initial exam weight
    },
  });

  // Link to concepts if they exist
  for (const conceptName of fact.concepts) {
    const concept = await prisma.concept.findFirst({
      where: {
        name: { equals: conceptName, mode: 'insensitive' },
        rotation,
      },
    });

    if (concept) {
      await prisma.factConcept.create({
        data: {
          factId: created.id,
          conceptId: concept.id,
          isPrimary: fact.concepts.indexOf(conceptName) === 0,
        },
      });
    }
  }

  return { id: created.id, created: true };
}

/**
 * Get coverage stats for a rotation.
 */
export async function getCoverage(rotation: string) {
  const facts = await prisma.fact.groupBy({
    by: ['week'],
    where: { rotation },
    _count: { id: true },
  });

  const verified = await prisma.fact.count({
    where: { rotation, verified: true },
  });

  const flagged = await prisma.fact.count({
    where: { rotation, flagged: true },
  });

  const topicCounts = await prisma.$queryRaw<{ topic: string; count: bigint }[]>`
    SELECT unnest(topics) as topic, COUNT(*) as count
    FROM "Fact"
    WHERE rotation = ${rotation}
    GROUP BY topic
    ORDER BY count DESC
    LIMIT 20
  `;

  return {
    rotation,
    byWeek: facts.map((f) => ({ week: f.week, count: f._count.id })),
    totalFacts: facts.reduce((sum, f) => sum + f._count.id, 0),
    verifiedCount: verified,
    flaggedCount: flagged,
    topTopics: topicCounts.map((t) => ({
      topic: t.topic,
      count: Number(t.count),
    })),
  };
}
