/**
 * Content Versioning System
 *
 * Unified versioning for cards and questions.
 * Every content change creates an immutable ContentVersion snapshot.
 * LearningEvents link to the specific ContentVersion shown.
 */

import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// =============================================================================
// Types
// =============================================================================

export type ContentTargetType = 'card' | 'question';

export interface CardContentForHash {
  front: string;
  back: string;
  backs?: string[] | null;
}

export interface CardContentForVersion extends CardContentForHash {
  context?: string | null;
  topics: string[];
  difficulty: string;
  imageUrl?: string | null;
}

export interface QuestionContentForHash {
  stem: string;
  options: Record<string, unknown>[];
  context?: string | null;
}

export interface QuestionContentForVersion extends QuestionContentForHash {
  topics: string[];
  difficulty: string;
  imageUrl?: string | null;
}

// =============================================================================
// Content Hash
// =============================================================================

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    sorted[key] = typeof value === 'string' ? normalizeText(value) : value;
  }
  return sorted;
}

export function computeCardContentHash(card: CardContentForHash): string {
  const payload = {
    front: normalizeText(card.front),
    back: normalizeText(card.back),
    backs: card.backs?.map(normalizeText) ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function computeQuestionContentHash(question: QuestionContentForHash): string {
  const payload = {
    stem: normalizeText(question.stem),
    options: question.options.map(sortObjectKeys),
    context: question.context ? normalizeText(question.context) : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// =============================================================================
// Card Versions
// =============================================================================

type CardVersionInput = {
  cardId: string;
  front: string;
  back: string;
  backs?: string[] | null;
  context?: string | null;
  topics: string[];
  difficulty: string;
  imageUrl?: string | null;
};

function buildCardVersionRow(
  card: CardVersionInput,
  hash: string,
  versionNumber: number,
  createdBy: string
): Prisma.ContentVersionCreateManyInput {
  return {
    targetType: 'card',
    targetId: card.cardId,
    versionNumber,
    snapshot: {
      front: card.front,
      back: card.back,
      backs: card.backs ?? null,
      context: card.context ?? null,
      topics: card.topics,
      difficulty: card.difficulty,
      imageUrl: card.imageUrl ?? null,
    } as unknown as Prisma.InputJsonValue,
    contentHash: hash,
    createdBy,
  };
}

/**
 * P2002 on (targetType, targetId, versionNumber) means a parallel writer
 * (another seed process, an admin edit, etc.) inserted between our
 * version-count read and our createMany write. Recover by:
 *   1. Re-reading existing hashes + counts for the cards still in flight.
 *   2. Dropping any card whose content the parallel writer already wrote
 *      (same contentHash → idempotent skip).
 *   3. Re-numbering the remaining cards from the fresh count.
 * Bounded retries so a persistent non-P2002 problem surfaces immediately.
 */
const PARALLEL_WRITE_RETRY_LIMIT = 5;

function isVersionUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray(err.meta?.target) &&
    (err.meta?.target as string[]).includes('versionNumber')
  );
}

export async function bulkCreateVersions(
  cards: CardVersionInput[],
  createdBy: string
): Promise<{ created: number; skipped: number; changedCardIds: string[] }> {
  let created = 0;
  let skipped = 0;
  const changedCardIds: string[] = [];

  // Cards we still need to try writing. Shrinks each retry as parallel writers
  // satisfy our work for us.
  let pending = cards.slice();

  for (let attempt = 0; attempt < PARALLEL_WRITE_RETRY_LIMIT && pending.length > 0; attempt++) {
    const cardIds = pending.map((c) => c.cardId);
    const existingVersions = await prisma.contentVersion.findMany({
      where: { targetType: 'card', targetId: { in: cardIds } },
      select: { targetId: true, contentHash: true },
    });

    const existingHashesByCard = new Map<string, Set<string>>();
    for (const v of existingVersions) {
      const hashes = existingHashesByCard.get(v.targetId) ?? new Set();
      hashes.add(v.contentHash);
      existingHashesByCard.set(v.targetId, hashes);
    }

    const versionCounts = await prisma.contentVersion.groupBy({
      by: ['targetId'],
      where: { targetType: 'card', targetId: { in: cardIds } },
      _count: true,
    });
    const countByCard = new Map(versionCounts.map((v) => [v.targetId, v._count]));

    const toCreate: Prisma.ContentVersionCreateManyInput[] = [];
    const stillPending: CardVersionInput[] = [];
    const batchChangedIds: string[] = [];

    for (const card of pending) {
      const hash = computeCardContentHash(card);
      const existingHashes = existingHashesByCard.get(card.cardId);

      if (existingHashes?.has(hash)) {
        skipped++;
        continue;
      }

      const currentCount = countByCard.get(card.cardId) ?? 0;
      toCreate.push(buildCardVersionRow(card, hash, currentCount + 1, createdBy));
      batchChangedIds.push(card.cardId);
      stillPending.push(card);
      countByCard.set(card.cardId, currentCount + 1);
    }

    if (toCreate.length === 0) {
      pending = [];
      break;
    }

    try {
      await prisma.contentVersion.createMany({ data: toCreate });
      created += toCreate.length;
      changedCardIds.push(...batchChangedIds);
      pending = [];
    } catch (err) {
      if (!isVersionUniqueViolation(err)) throw err;
      // A parallel writer beat us. Re-loop: the next iteration will re-read
      // hashes/counts and either skip (same content) or pick a higher
      // versionNumber.
      pending = stillPending;
    }
  }

  if (pending.length > 0) {
    throw new Error(
      `bulkCreateVersions: exceeded ${PARALLEL_WRITE_RETRY_LIMIT} retries while racing parallel writers (${pending.length} cards still pending)`
    );
  }

  return { created, skipped, changedCardIds };
}

// =============================================================================
// Question Versions
// =============================================================================

type QuestionVersionInput = {
  questionId: string;
  stem: string;
  options: Record<string, unknown>[];
  context?: string | null;
  topics: string[];
  difficulty: string;
  imageUrl?: string | null;
};

function buildQuestionVersionRow(
  question: QuestionVersionInput,
  hash: string,
  versionNumber: number,
  createdBy: string
): Prisma.ContentVersionCreateManyInput {
  return {
    targetType: 'question',
    targetId: question.questionId,
    versionNumber,
    snapshot: {
      stem: question.stem,
      options: question.options,
      context: question.context ?? null,
      topics: question.topics,
      difficulty: question.difficulty,
      imageUrl: question.imageUrl ?? null,
    } as unknown as Prisma.InputJsonValue,
    contentHash: hash,
    createdBy,
  };
}

export async function bulkCreateQuestionVersions(
  questions: QuestionVersionInput[],
  createdBy: string
): Promise<{ created: number; skipped: number; changedQuestionIds: string[] }> {
  let created = 0;
  let skipped = 0;
  const changedQuestionIds: string[] = [];

  let pending = questions.slice();

  for (let attempt = 0; attempt < PARALLEL_WRITE_RETRY_LIMIT && pending.length > 0; attempt++) {
    const questionIds = pending.map((q) => q.questionId);
    const existingVersions = await prisma.contentVersion.findMany({
      where: { targetType: 'question', targetId: { in: questionIds } },
      select: { targetId: true, contentHash: true },
    });

    const existingHashesByQuestion = new Map<string, Set<string>>();
    for (const v of existingVersions) {
      const hashes = existingHashesByQuestion.get(v.targetId) ?? new Set();
      hashes.add(v.contentHash);
      existingHashesByQuestion.set(v.targetId, hashes);
    }

    const versionCounts = await prisma.contentVersion.groupBy({
      by: ['targetId'],
      where: { targetType: 'question', targetId: { in: questionIds } },
      _count: true,
    });
    const countByQuestion = new Map(versionCounts.map((v) => [v.targetId, v._count]));

    const toCreate: Prisma.ContentVersionCreateManyInput[] = [];
    const stillPending: QuestionVersionInput[] = [];
    const batchChangedIds: string[] = [];

    for (const question of pending) {
      const hash = computeQuestionContentHash(question);
      const existingHashes = existingHashesByQuestion.get(question.questionId);

      if (existingHashes?.has(hash)) {
        skipped++;
        continue;
      }

      const currentCount = countByQuestion.get(question.questionId) ?? 0;
      toCreate.push(buildQuestionVersionRow(question, hash, currentCount + 1, createdBy));
      batchChangedIds.push(question.questionId);
      stillPending.push(question);
      countByQuestion.set(question.questionId, currentCount + 1);
    }

    if (toCreate.length === 0) {
      pending = [];
      break;
    }

    try {
      await prisma.contentVersion.createMany({ data: toCreate });
      created += toCreate.length;
      changedQuestionIds.push(...batchChangedIds);
      pending = [];
    } catch (err) {
      if (!isVersionUniqueViolation(err)) throw err;
      pending = stillPending;
    }
  }

  if (pending.length > 0) {
    throw new Error(
      `bulkCreateQuestionVersions: exceeded ${PARALLEL_WRITE_RETRY_LIMIT} retries while racing parallel writers (${pending.length} questions still pending)`
    );
  }

  return { created, skipped, changedQuestionIds };
}

// =============================================================================
// Version Lookup (for LearningEvent audit trail)
// =============================================================================

export async function getOrCreateCurrentVersion(
  targetType: ContentTargetType,
  targetId: string,
  createdBy: string = 'event'
): Promise<{ id: string }> {
  if (targetType === 'card') {
    const card = await prisma.card.findUnique({
      where: { id: targetId },
      select: { front: true, back: true, backs: true, context: true, topics: true, difficulty: true, imageUrl: true },
    });
    if (!card) throw new Error(`Card not found: ${targetId}`);

    const currentHash = computeCardContentHash({
      front: card.front,
      back: card.back,
      backs: card.backs as string[] | null,
    });

    for (let attempt = 0; attempt < PARALLEL_WRITE_RETRY_LIMIT; attempt++) {
      const existing = await prisma.contentVersion.findFirst({
        where: { targetType: 'card', targetId, contentHash: currentHash },
        orderBy: { versionNumber: 'desc' },
        select: { id: true },
      });
      if (existing) return existing;

      const count = await prisma.contentVersion.count({ where: { targetType: 'card', targetId } });
      try {
        return await prisma.contentVersion.create({
          data: {
            targetType: 'card',
            targetId,
            versionNumber: count + 1,
            snapshot: {
              front: card.front,
              back: card.back,
              backs: card.backs ?? null,
              context: card.context ?? null,
              topics: card.topics,
              difficulty: card.difficulty,
              imageUrl: card.imageUrl ?? null,
            } as unknown as Prisma.InputJsonValue,
            contentHash: currentHash,
            createdBy,
          },
          select: { id: true },
        });
      } catch (err) {
        if (!isVersionUniqueViolation(err)) throw err;
      }
    }

    const recovered = await prisma.contentVersion.findFirst({
      where: { targetType: 'card', targetId, contentHash: currentHash },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    if (recovered) return recovered;
    throw new Error(`Failed to create content version after retries: card ${targetId}`);
  }

  // Question
  const question = await prisma.question.findUnique({
    where: { id: targetId },
    select: { stem: true, options: true, context: true, topics: true, difficulty: true, imageUrl: true },
  });
  if (!question) throw new Error(`Question not found: ${targetId}`);

  const currentHash = computeQuestionContentHash({
    stem: question.stem,
    options: question.options as Record<string, unknown>[],
    context: question.context,
  });

  for (let attempt = 0; attempt < PARALLEL_WRITE_RETRY_LIMIT; attempt++) {
    const existing = await prisma.contentVersion.findFirst({
      where: { targetType: 'question', targetId, contentHash: currentHash },
      orderBy: { versionNumber: 'desc' },
      select: { id: true },
    });
    if (existing) return existing;

    const count = await prisma.contentVersion.count({ where: { targetType: 'question', targetId } });
    try {
      return await prisma.contentVersion.create({
        data: {
          targetType: 'question',
          targetId,
          versionNumber: count + 1,
          snapshot: {
            stem: question.stem,
            options: question.options,
            context: question.context ?? null,
            topics: question.topics,
            difficulty: question.difficulty,
            imageUrl: question.imageUrl ?? null,
          } as unknown as Prisma.InputJsonValue,
          contentHash: currentHash,
          createdBy,
        },
        select: { id: true },
      });
    } catch (err) {
      if (!isVersionUniqueViolation(err)) throw err;
    }
  }

  const recovered = await prisma.contentVersion.findFirst({
    where: { targetType: 'question', targetId, contentHash: currentHash },
    orderBy: { versionNumber: 'desc' },
    select: { id: true },
  });
  if (recovered) return recovered;
  throw new Error(`Failed to create content version after retries: question ${targetId}`);
}
