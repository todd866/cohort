/**
 * Sparse Region Detection and Content Generation
 *
 * Implements Principle #10 from embedding-design-principles.md:
 * "When a user is weak in a region with insufficient alternative content, generate new content."
 *
 * Detection flow:
 * 1. Find user's weak regions (retrieval strength < threshold)
 * 2. For each weak region, count alternative cards with high similarity
 * 3. If alternatives < threshold, it's a sparse weak region
 * 4. Create AgentJob to generate: prerequisites, alternatives, MCQ variants, mnemonics
 */

import { prisma } from '@/lib/prisma';
import { findSimilar } from './similarity';
import { logger } from '@/lib/logger';
import { filterDeliverableReinforcementCardRows } from '@/lib/usmle/reinforcement-card-delivery';

// Configuration
const WEAK_THRESHOLD = 0.5; // Retrieval strength below this = weak
const MIN_ALTERNATIVES = 3; // Need at least this many similar cards
const SIMILARITY_THRESHOLD = 0.7; // Cards must be this similar to count as alternatives
const MAX_JOBS_PER_SESSION = 3; // Don't overwhelm with generation jobs

export interface SparseRegion {
  // The "center" card of this weak region
  centroidCardId: string;
  centroidFront: string;

  // Region characteristics
  topic: string;
  moduleNode: string;
  userRetrievalStrength: number;

  // What we have vs. what we need
  existingCardIds: string[];
  alternativesNeeded: number;
}

export interface GenerationJob {
  type: 'prerequisite' | 'alternative' | 'mcq_variant' | 'mnemonic';
  priority: number;
  conceptId: string;
  cardId: string;
  reason: string;
  metadata: Record<string, unknown>;
}

/**
 * Detect sparse weak regions for a user
 *
 * Returns regions where the user is struggling AND there aren't
 * enough alternative cards to help them learn differently.
 */
export async function detectSparseWeakRegions(
  userId: string,
  options?: {
    moduleNodes?: string[]; // Limit to specific modules
    weakThreshold?: number;
    minAlternatives?: number;
    limit?: number;
  }
): Promise<SparseRegion[]> {
  const {
    moduleNodes,
    weakThreshold = WEAK_THRESHOLD,
    minAlternatives = MIN_ALTERNATIVES,
    limit = 10,
  } = options || {};

  // Get user's weak cards (low retrieval strength, has been reviewed)
  const weakProgress = await prisma.cardProgress.findMany({
    where: {
      userId,
      retrievalStrength: { lt: weakThreshold },
      totalReviews: { gt: 0 }, // Must have been reviewed at least once
    },
    include: {
      card: {
        select: {
          id: true,
          front: true,
          topics: true,
          moduleNodes: true,
          clusterId: true,
        },
      },
    },
    orderBy: { retrievalStrength: 'asc' }, // Weakest first
    take: limit * 3, // Get more than we need to filter
  });

  // Filter by module if specified
  let candidates = weakProgress;
  if (moduleNodes && moduleNodes.length > 0) {
    candidates = weakProgress.filter(
      (p) =>
        p.card &&
        p.card.moduleNodes.some((m) => moduleNodes.includes(m))
    );
  }
  const deliverableCandidateIds = new Set(
    (await filterDeliverableReinforcementCardRows(
      candidates.flatMap((progress) => progress.card ? [{ id: progress.card.id }] : []),
      { logContext: { transport: 'sparse-region-detection' } },
    )).map((row) => row.id),
  );
  candidates = candidates.filter((progress) => (
    progress.card != null && deliverableCandidateIds.has(progress.card.id)
  ));

  const sparseRegions: SparseRegion[] = [];
  const processedClusters = new Set<string>();

  for (const progress of candidates) {
    if (!progress.card) continue;
    if (sparseRegions.length >= limit) break;

    // Avoid processing the same cluster twice
    if (progress.card.clusterId && processedClusters.has(progress.card.clusterId)) {
      continue;
    }

    // Find similar cards that could serve as alternatives
    const similar = await findSimilar(progress.cardId, 20, SIMILARITY_THRESHOLD);

    // Filter to cards the user hasn't mastered
    const userProgress = await prisma.cardProgress.findMany({
      where: {
        userId,
        cardId: { in: similar.map((s) => s.cardId) },
      },
      select: { cardId: true, retrievalStrength: true },
    });

    const masteredIds = new Set(
      userProgress.filter((p) => p.retrievalStrength >= 0.7).map((p) => p.cardId)
    );

    // Unmastered alternatives
    const alternatives = similar.filter((s) => !masteredIds.has(s.cardId));

    // If not enough alternatives, this is a sparse region
    if (alternatives.length < minAlternatives) {
      if (progress.card.clusterId) {
        processedClusters.add(progress.card.clusterId);
      }

      sparseRegions.push({
        centroidCardId: progress.cardId,
        centroidFront: progress.card.front,
        topic: progress.card.topics[0] || 'Unknown',
        moduleNode: progress.card.moduleNodes[0] || 'unknown',
        userRetrievalStrength: progress.retrievalStrength,
        existingCardIds: [progress.cardId, ...alternatives.map((a) => a.cardId)],
        alternativesNeeded: minAlternatives - alternatives.length,
      });
    }
  }

  return sparseRegions;
}

/**
 * Create AgentJobs for sparse region content generation
 *
 * For each sparse region, creates jobs to generate:
 * - Prerequisites: simpler concepts that lead to this one
 * - Alternatives: same concept, different angle/explanation
 * - MCQ variants: test the same concept differently
 * - Mnemonics: memory aids for the concept
 */
export async function createGenerationJobs(
  userId: string,
  sparseRegions: SparseRegion[],
  options?: {
    maxJobs?: number;
    priorityBoost?: number;
  }
): Promise<{ created: number; skipped: number }> {
  const { maxJobs = MAX_JOBS_PER_SESSION, priorityBoost = 0 } = options || {};

  let created = 0;
  let skipped = 0;

  // Sort by user's weakness (most struggling first)
  const sortedRegions = [...sparseRegions].sort(
    (a, b) => a.userRetrievalStrength - b.userRetrievalStrength
  );

  for (const region of sortedRegions) {
    if (created >= maxJobs) break;

    // Check if we already have pending jobs for this card
    const existingJobs = await prisma.agentJob.count({
      where: {
        cardId: region.centroidCardId,
        status: { in: ['pending', 'claimed'] },
      },
    });

    if (existingJobs > 0) {
      skipped++;
      continue;
    }

    // Decide what type of content to generate based on need
    const jobType = selectJobType(region);

    try {
      await prisma.agentJob.create({
        data: {
          type: `create_${jobType}`,
          priority: 2 - priorityBoost, // Higher priority (lower number) for boosted
          rotation: region.moduleNode.split('/')[0], // Extract rotation from module node
          cardId: region.centroidCardId,
          trigger: 'sparse_weak_region',
          metadata: {
            userId,
            topic: region.topic,
            moduleNode: region.moduleNode,
            userStrength: region.userRetrievalStrength,
            existingCards: region.existingCardIds,
            alternativesNeeded: region.alternativesNeeded,
            centroidFront: region.centroidFront,
          },
        },
      });

      created++;
      logger.info('Created generation job for sparse region', {
        jobType,
        cardId: region.centroidCardId,
        topic: region.topic,
        alternativesNeeded: region.alternativesNeeded,
      });
    } catch (error) {
      logger.error('Failed to create generation job', {
        cardId: region.centroidCardId,
        error,
      });
      skipped++;
    }
  }

  return { created, skipped };
}

/**
 * Select the best type of content to generate based on region characteristics
 */
function selectJobType(region: SparseRegion): string {
  // If user is very weak, they might need prerequisites
  if (region.userRetrievalStrength < 0.2) {
    return 'prerequisite';
  }

  // If there are some alternatives but not enough, create more
  if (region.alternativesNeeded <= 2) {
    return 'mcq_variant';
  }

  // Default: create an alternative explanation
  return 'alternative';
}

/**
 * Process sparse regions after a review session
 *
 * Called at the end of a study session to:
 * 1. Detect sparse weak regions from the session
 * 2. Create generation jobs if needed
 */
export async function processSessionSparseRegions(
  userId: string,
  sessionCardIds: string[],
  options?: {
    moduleNodes?: string[];
  }
): Promise<{ regionsDetected: number; jobsCreated: number }> {
  // Get progress for cards in this session
  const sessionProgress = await prisma.cardProgress.findMany({
    where: {
      userId,
      cardId: { in: sessionCardIds },
      retrievalStrength: { lt: WEAK_THRESHOLD },
    },
    select: { cardId: true },
  });

  if (sessionProgress.length === 0) {
    return { regionsDetected: 0, jobsCreated: 0 };
  }

  // Detect sparse regions focused on session cards
  const sparseRegions = await detectSparseWeakRegions(userId, {
    moduleNodes: options?.moduleNodes,
    limit: MAX_JOBS_PER_SESSION,
  });

  // Only consider regions that include cards from this session
  const sessionCardSet = new Set(sessionCardIds);
  const relevantRegions = sparseRegions.filter((r) =>
    r.existingCardIds.some((id) => sessionCardSet.has(id))
  );

  if (relevantRegions.length === 0) {
    return { regionsDetected: 0, jobsCreated: 0 };
  }

  // Create generation jobs
  const { created } = await createGenerationJobs(userId, relevantRegions);

  return {
    regionsDetected: relevantRegions.length,
    jobsCreated: created,
  };
}

/**
 * Get pending generation jobs for a specific rotation/module
 */
export async function getPendingGenerationJobs(
  rotation?: string,
  limit: number = 10
): Promise<
  Array<{
    id: string;
    type: string;
    cardId: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>
> {
  const jobs = await prisma.agentJob.findMany({
    where: {
      status: 'pending',
      type: { startsWith: 'create_' },
      ...(rotation ? { rotation } : {}),
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    take: limit,
    select: {
      id: true,
      type: true,
      cardId: true,
      metadata: true,
      createdAt: true,
    },
  });

  return jobs.map((j) => ({
    ...j,
    metadata: (j.metadata as Record<string, unknown>) || {},
  }));
}

/**
 * Mark a generation job as completed.
 *
 * IDOR guard: AgentJob has no per-user owner column — generation jobs are
 * created on behalf of a weak user (`metadata.userId`) but processed off a
 * GLOBAL pending worklist by whichever agent picks them up, so the completer is
 * not the triggering user and a strict `userId === owner` check would break the
 * pipeline. Instead we scope the write to a still-completable GENERATION job:
 * only rows whose `type` is a `create_*` job and whose `status` is `pending`
 * or `claimed` can be mutated by this endpoint. This prevents an authenticated
 * caller from using an arbitrary `jobId` to mutate non-generation AgentJob rows
 * or to re-complete/clobber an already-finished job.
 *
 * Returns true if a matching job was updated, false otherwise (not found,
 * wrong type, or already completed/dismissed).
 */
export async function completeGenerationJob(
  jobId: string,
  result: {
    success: boolean;
    generatedCardIds?: string[];
    error?: string;
  }
): Promise<boolean> {
  const { count } = await prisma.agentJob.updateMany({
    where: {
      id: jobId,
      type: { startsWith: 'create_' },
      status: { in: ['pending', 'claimed'] },
    },
    data: {
      status: result.success ? 'completed' : 'dismissed',
      completedAt: new Date(),
      result,
    },
  });

  return count > 0;
}
