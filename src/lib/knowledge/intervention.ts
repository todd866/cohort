/**
 * Intervention Selection & Logging
 *
 * When a user is stuck on a card, we probabilistically choose an intervention:
 * - continue: Keep testing (collect more signal)
 * - scaffold: Show bridge cards first (known → unknown)
 * - context: Show teaching content (explanation before re-test)
 * - retreat: Park the card, show variant question
 *
 * We log what we tried and track outcomes to learn what works.
 * When patterns emerge, we create AgentJobs for Claude Code to fix content.
 */

import { prisma } from '@/lib/prisma';
import {
  findBridgeCards,
  getStruggleRegion,
  type BridgeCard,
} from './struggle';
import { getUpstreamGapsForConcept, type UpstreamGap } from '../manifold/local-flow';

// =============================================================================
// Types
// =============================================================================

export type InterventionStrategy = 'continue' | 'scaffold' | 'context' | 'retreat';

export interface InterventionDecision {
  strategy: InterventionStrategy;
  triggerCardId: string;
  scaffoldCards?: BridgeCard[];
  upstreamGaps?: UpstreamGap[];
  contextContent?: ContextItem;
  variantQuestionId?: string;
  parkDurationMs?: number;
}

export interface ContextItem {
  type: 'wiki' | 'concept' | 'teaching_card';
  id: string;
  title: string;
  content: string;
}

// =============================================================================
// Constants
// =============================================================================

// Intervention probabilities (will be learned over time)
const INTERVENTION_PROBABILITIES = {
  continue: 0.30, // 30% - keep testing for more signal
  scaffold: 0.35, // 35% - show bridge cards
  context: 0.20,  // 20% - show teaching content
  retreat: 0.15,  // 15% - park and substitute
};

const PARK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Threshold for creating agent jobs
const MULTI_USER_STRUGGLE_THRESHOLD = 3;

// =============================================================================
// Deterministic strategy roll
// =============================================================================

/**
 * Deterministic [0,1) roll derived from a stable seed.
 *
 * The strategy choice must be reproducible for the same inputs on the same day
 * so walk-audit replays produce identical serves. We hash userId + cardId + the
 * UTC day into a uniform value rather than calling unseeded Math.random().
 *
 * (FNV-1a 32-bit — small, stable, no deps. The day component lets the strategy
 * vary across days while staying fixed within a day, preserving the original
 * spread-across-strategies intent without sacrificing reproducibility.)
 */
export function deterministicRoll(seed: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    // FNV prime multiply via shifts to stay in 32-bit unsigned range
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Map the 32-bit hash to [0, 1)
  return hash / 0x100000000;
}

function dayKey(now: number): string {
  // UTC calendar day (YYYY-MM-DD), stable within a day for reproducible replays
  return new Date(now).toISOString().slice(0, 10);
}

// =============================================================================
// Intervention Selection
// =============================================================================

/**
 * Select an intervention for a stuck card
 * Uses fixed probabilities for now; will be learned from outcomes later
 *
 * The strategy is chosen deterministically from a stable seed
 * (userId + cardId + day) so that the same inputs on the same day always yield
 * the same strategy — required for walk-audit reproducibility. Callers may pass
 * an explicit `roll` in [0,1) to override the derived value.
 */
export async function selectIntervention(
  userId: string,
  cardId: string,
  rotation: string,
  failCount: number,
  roll: number = deterministicRoll(`${userId}|${cardId}|${dayKey(Date.now())}`)
): Promise<InterventionDecision> {
  let cumulativeProbability = 0;

  // Determine strategy by random roll
  let strategy: InterventionStrategy = 'continue';

  for (const [strat, prob] of Object.entries(INTERVENTION_PROBABILITIES)) {
    cumulativeProbability += prob;
    if (roll < cumulativeProbability) {
      strategy = strat as InterventionStrategy;
      break;
    }
  }

  const decision: InterventionDecision = {
    strategy,
    triggerCardId: cardId,
  };

  // Execute strategy-specific logic
  switch (strategy) {
    case 'scaffold': {
      // Try upstream-first scaffolding via local flow field
      const scaffoldResult = await findScaffoldCards(userId, cardId, rotation);
      if (scaffoldResult.cards.length > 0) {
        decision.scaffoldCards = scaffoldResult.cards;
        decision.upstreamGaps = scaffoldResult.gaps;
      } else {
        // Fallback to continue if no scaffolds found
        decision.strategy = 'continue';
      }
      break;
    }

    case 'context': {
      const context = await findContextContent(cardId);
      if (context) {
        decision.contextContent = context;
      } else {
        // Fallback to continue if no context found
        decision.strategy = 'continue';
      }
      break;
    }

    case 'retreat': {
      decision.parkDurationMs = PARK_DURATION_MS;
      const variant = await findVariantQuestion(userId, cardId);
      if (variant) {
        decision.variantQuestionId = variant;
      }
      break;
    }
  }

  // Log the intervention
  await logIntervention(userId, rotation, cardId, failCount, decision);

  // Check if we should create an AgentJob for content improvement
  await maybeCreateAgentJob(cardId, rotation);

  return decision;
}

// =============================================================================
// Upstream Scaffold Finding
// =============================================================================

/**
 * Find scaffold cards using local flow field upstream gap analysis.
 * Falls back to bridge cards when no upstream gaps or concepts are found.
 */
async function findScaffoldCards(
  userId: string,
  cardId: string,
  rotation: string
): Promise<{ cards: BridgeCard[]; gaps: UpstreamGap[] }> {
  // Get trigger card's primary concept
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true },
  });

  if (card?.topics && card.topics.length > 0) {
    // Find the concept matching this card's topics
    const concept = await prisma.concept.findFirst({
      where: { rotation, topics: { hasSome: card.topics } },
      select: { id: true },
    });

    if (concept) {
      const gaps = await getUpstreamGapsForConcept(userId, concept.id, rotation);

      if (gaps.length > 0) {
        // Find cards for the top gap concepts
        const topGapIds = gaps.slice(0, 3).map((g) => g.conceptId);
        const topGapTopics = await prisma.concept.findMany({
          where: { id: { in: topGapIds } },
          select: { topics: true },
        });
        const allTopics = topGapTopics.flatMap((c) => c.topics);

        if (allTopics.length > 0) {
          try {
            const scaffoldCards = await prisma.$queryRaw<BridgeCard[]>`
              SELECT
                c.id,
                c.front,
                c.complexity,
                COALESCE(cp."retrievalStrength", 0) as "retrievalStrength",
                0.8 as similarity
              FROM "Card" c
              LEFT JOIN "CardProgress" cp ON cp."cardId" = c.id AND cp."userId" = ${userId}
              WHERE c.rotation = ${rotation}
                AND c.topics && ${allTopics}::text[]
                AND c.id != ${cardId}
              ORDER BY COALESCE(cp."retrievalStrength", 0) DESC, c.complexity ASC
              LIMIT 3
            `;

            if (scaffoldCards.length > 0) {
              return { cards: scaffoldCards, gaps };
            }
          } catch {
            // Raw query failed (e.g. pgvector not available) — fall through to bridge cards
          }
        }
      }
    }
  }

  // Fallback to existing bridge cards
  const bridges = await findBridgeCards(userId, rotation, { maxCount: 3 });
  return { cards: bridges, gaps: [] };
}

// =============================================================================
// Content Finding
// =============================================================================

/**
 * Find teaching content related to a card (for context strategy)
 */
async function findContextContent(cardId: string): Promise<ContextItem | null> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true },
  });

  if (!card) return null;

  // Try concept description
  if (card.topics.length > 0) {
    const concept = await prisma.concept.findFirst({
      where: { topics: { hasSome: card.topics } },
    });

    if (concept?.description) {
      return {
        type: 'concept',
        id: concept.id,
        title: concept.name,
        content: concept.description,
      };
    }
  }

  return null;
}

/**
 * Find a variant question on the same concept (for retreat strategy)
 */
async function findVariantQuestion(userId: string, cardId: string): Promise<string | null> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { topics: true, rotation: true },
  });

  if (!card || card.topics.length === 0) return null;

  // Find an unanswered question on the same topics
  const question = await prisma.question.findFirst({
    where: {
      rotation: card.rotation,
      topics: { hasSome: card.topics },
      responses: { none: { userId } },
    },
    select: { id: true },
  });

  return question?.id ?? null;
}

// =============================================================================
// Intervention Logging
// =============================================================================

/**
 * Log an intervention for outcome tracking
 */
async function logIntervention(
  userId: string,
  rotation: string,
  cardId: string,
  failCount: number,
  decision: InterventionDecision
): Promise<void> {
  const region = await getStruggleRegion(userId, rotation);

  await prisma.struggleIntervention.create({
    data: {
      userId,
      rotation,
      triggerCardId: cardId,
      failCount,
      strategy: decision.strategy,
      scaffoldCardIds: decision.scaffoldCards?.map((c) => c.id) ?? [],
      regionSnapshot: region
        ? {
            failedCardIds: region.failedCardIds,
            totalFailCount: region.totalFailCount,
            avgFailsPerCard: region.avgFailsPerCard,
          }
        : undefined,
    },
  });
}

/**
 * Update intervention with resolution outcome
 */
export async function resolveIntervention(
  userId: string,
  cardId: string,
  quality: number,
  responseTimeMs: number | null
): Promise<void> {
  // Find the most recent unresolved intervention for this card
  const intervention = await prisma.struggleIntervention.findFirst({
    where: {
      userId,
      triggerCardId: cardId,
      resolved: false,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!intervention) return;

  const attemptsToResolve =
    (await prisma.struggleIntervention.count({
      where: {
        userId,
        triggerCardId: cardId,
        createdAt: { gte: intervention.createdAt },
      },
    })) + 1;

  // Compute resolution confidence
  const confidence = computeResolutionConfidenceFromIntervention(
    attemptsToResolve,
    responseTimeMs,
    intervention.failCount
  );

  await prisma.struggleIntervention.update({
    where: { id: intervention.id },
    data: {
      resolved: true,
      resolvedAt: new Date(),
      attemptsToResolve,
      triggerCardNextQuality: quality,
      resolutionConfidence: confidence,
      stillFragile: confidence < 0.7,
    },
  });
}

function computeResolutionConfidenceFromIntervention(
  attemptsToResolve: number,
  responseTimeMs: number | null,
  originalFailCount: number
): number {
  let confidence = 1.0;

  // Penalize for many attempts
  const attemptPenalty = Math.min(0.5, (attemptsToResolve - 1) * 0.1);
  confidence -= attemptPenalty;

  // Penalize for high original fail count (suggests hard struggle)
  const failPenalty = Math.min(0.3, (originalFailCount - 3) * 0.1);
  confidence -= failPenalty;

  // Bonus for fast response (indicates solid recall)
  if (responseTimeMs && responseTimeMs < 3000) {
    confidence += 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

// =============================================================================
// Agent Job Creation (Tier 3: Claude Code agents)
// =============================================================================

/**
 * Create an AgentJob when a card triggers struggle for multiple users
 * This is how local intelligence hands off to Claude Code for deep work
 */
async function maybeCreateAgentJob(cardId: string, rotation: string): Promise<void> {
  // Count users who've struggled on this card
  const struggleCount = await prisma.userStruggleRegion.count({
    where: {
      failedCardIds: { has: cardId },
      resolvedAt: null,
    },
  });

  if (struggleCount < MULTI_USER_STRUGGLE_THRESHOLD) {
    return;
  }

  // Check if job already exists
  const existingJob = await prisma.agentJob.findFirst({
    where: {
      type: 'review_struggle_card',
      cardId,
      status: { in: ['pending', 'claimed'] },
    },
  });

  if (existingJob) {
    // Update metadata with latest count
    await prisma.agentJob.update({
      where: { id: existingJob.id },
      data: {
        metadata: {
          struggleCount,
          lastUpdated: new Date().toISOString(),
        },
      },
    });
    return;
  }

  // Create new job
  await prisma.agentJob.create({
    data: {
      type: 'review_struggle_card',
      cardId,
      rotation,
      priority: 1, // Urgent
      trigger: 'multi_user_struggle',
      metadata: {
        struggleCount,
        detectedAt: new Date().toISOString(),
        recommendation: 'Review card content. Consider: clearer wording, better context, scaffold cards.',
      },
    },
  });
}

/**
 * Create an AgentJob for a concept cluster where users struggle
 * Called when struggle region spans multiple cards in same area
 */
export async function createClusterStruggleJob(
  rotation: string,
  clusterId: string,
  cardIds: string[]
): Promise<void> {
  const existingJob = await prisma.agentJob.findFirst({
    where: {
      type: 'review_struggle_cluster',
      metadata: { path: ['clusterId'], equals: clusterId },
      status: { in: ['pending', 'claimed'] },
    },
  });

  if (existingJob) return;

  await prisma.agentJob.create({
    data: {
      type: 'review_struggle_cluster',
      rotation,
      priority: 2, // Normal (cluster issues are less urgent than individual cards)
      trigger: 'cluster_struggle_pattern',
      metadata: {
        clusterId,
        cardIds,
        detectedAt: new Date().toISOString(),
        recommendation: 'Users struggle across this concept cluster. Consider: prerequisite content, teaching cards, or scaffolding path.',
      },
    },
  });
}

// =============================================================================
// Card Parking (Retreat Strategy)
// =============================================================================

/**
 * Park a card: push nextDueAt forward to give user a break
 */
export async function parkCard(
  userId: string,
  cardId: string,
  durationMs: number
): Promise<void> {
  const newDueAt = new Date(Date.now() + durationMs);

  await prisma.cardProgress.update({
    where: { cardId_userId: { cardId, userId } },
    data: { nextDueAt: newDueAt },
  });
}

// =============================================================================
// Analytics (for learning what works)
// =============================================================================

/**
 * Get intervention success rates by strategy
 * Used to learn which strategies work best
 */
export async function getInterventionStats(rotation?: string): Promise<{
  strategy: string;
  total: number;
  resolved: number;
  avgConfidence: number;
  stillFragileRate: number;
}[]> {
  const where = rotation ? { rotation } : {};

  const strategies: InterventionStrategy[] = ['continue', 'scaffold', 'context', 'retreat'];
  const stats = [];

  for (const strategy of strategies) {
    const total = await prisma.struggleIntervention.count({
      where: { ...where, strategy },
    });

    const resolved = await prisma.struggleIntervention.count({
      where: { ...where, strategy, resolved: true },
    });

    const confidenceAgg = await prisma.struggleIntervention.aggregate({
      where: { ...where, strategy, resolved: true },
      _avg: { resolutionConfidence: true },
    });

    const stillFragile = await prisma.struggleIntervention.count({
      where: { ...where, strategy, resolved: true, stillFragile: true },
    });

    stats.push({
      strategy,
      total,
      resolved,
      avgConfidence: confidenceAgg._avg.resolutionConfidence ?? 0,
      stillFragileRate: resolved > 0 ? stillFragile / resolved : 0,
    });
  }

  return stats;
}
