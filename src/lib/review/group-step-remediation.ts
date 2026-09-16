/**
 * Group Step Remediation
 *
 * When a user fails a step within a question group (ECG, CXR, etc.),
 * find and queue related flashcards for remediation.
 *
 * This closes the loop between group-based learning and card-based reinforcement.
 */

import { prisma } from '@/lib/prisma';
import { findSimilar } from '@/lib/manifold';
import { expandTopicSet, normalizeTopic } from '@/lib/topics';
import { logger } from '@/lib/logger';
import { LARGE_QUERY_SIZE } from '@/lib/constants';

export interface StepResultForRemediation {
  stepId: string;
  correct: boolean;
  phase?: string; // "rhythm", "ischemia", etc.
}

export interface GroupRemediationInput {
  userId: string;
  groupId: string;
  stepResults: StepResultForRemediation[];
  groupTopics: string[];
  rotation: string;
  now?: Date;
}

// Maps step phases to related card topics for better remediation matching
const PHASE_TOPIC_MAPPING: Record<string, string[]> = {
  // ECG phases
  rhythm: ['rhythm', 'arrhythmia', 'heart rate', 'atrial fibrillation', 'AV block', 'bradycardia', 'tachycardia'],
  rate: ['heart rate', 'tachycardia', 'bradycardia', 'rhythm'],
  axis: ['axis', 'left axis deviation', 'right axis deviation', 'ECG'],
  ischemia: ['STEMI', 'ischemia', 'ST elevation', 'myocardial infarction', 'MI'],
  diagnosis: ['ECG', 'diagnosis', 'interpretation'],
  culprit: ['coronary', 'LAD', 'RCA', 'circumflex', 'myocardial infarction'],
  waves: ['P wave', 'QRS', 'T wave', 'ECG morphology'],
  intervals: ['PR interval', 'QT interval', 'QRS duration'],
  // ABG phases
  'acid-base': ['acid-base', 'pH', 'metabolic acidosis', 'respiratory acidosis'],
  oxygenation: ['hypoxia', 'oxygenation', 'PaO₂', 'A-a gradient'],
  compensation: ['compensation', 'respiratory compensation', 'metabolic compensation'],
};

/**
 * Process failed steps from a group attempt and queue remediation cards.
 */
export async function processGroupStepRemediation(
  input: GroupRemediationInput
): Promise<{ cardsQueued: number; cardIds: string[] }> {
  const { userId, stepResults, groupTopics, rotation } = input;
  const now = input.now ?? new Date();

  // Get failed steps
  const failedSteps = stepResults.filter((s) => !s.correct);

  if (failedSteps.length === 0) {
    return { cardsQueued: 0, cardIds: [] };
  }

  // Collect all relevant topics from failed steps
  const topicsToRemediate = new Set<string>();

  // Add group-level topics
  for (const topic of groupTopics) {
    topicsToRemediate.add(topic.toLowerCase());
  }

  // Add phase-specific topics for each failed step
  for (const step of failedSteps) {
    if (step.phase) {
      const phaseKey = step.phase.toLowerCase();
      const phaseTopics = PHASE_TOPIC_MAPPING[phaseKey] || [];
      for (const topic of phaseTopics) {
        topicsToRemediate.add(topic.toLowerCase());
      }
    }
  }

  const allTopics = [...topicsToRemediate];
  let remediationCardIds: string[] = [];

  try {
    // Strategy 1: Find cards by topic matching (most reliable)
    const expandedTopics = expandTopicSet(allTopics);

    const candidateCards = await prisma.card.findMany({
      where: {
        rotation,
        deletedAt: null,
        topics: { hasSome: expandedTopics },
      },
      select: {
        id: true,
        topics: true,
        complexity: true,
      },
      take: LARGE_QUERY_SIZE,
    });

    if (candidateCards.length > 0) {
      const topicSet = new Set(allTopics.map(normalizeTopic).filter(Boolean));

      // Score cards by topic overlap and complexity
      const scored = candidateCards
        .map((c) => {
          const cTopics = Array.isArray(c.topics) ? c.topics : [];
          const cTopicSet = new Set(cTopics.map(normalizeTopic).filter(Boolean));
          const intersection = [...cTopicSet].filter((t) => topicSet.has(t));
          const union = new Set([...topicSet, ...cTopicSet]);
          const jaccard = union.size === 0 ? 0 : intersection.length / union.size;

          // Boost simpler cards (they scaffold harder concepts)
          const complexityBoost = c.complexity <= 1 ? 0.2 : c.complexity === 2 ? 0.1 : 0;

          return {
            id: c.id,
            score: Math.min(1, jaccard + complexityBoost),
            complexity: c.complexity,
          };
        })
        .filter((c) => c.score >= 0.2)
        .sort((a, b) => {
          // Prefer simpler cards first
          if (a.complexity !== b.complexity) return a.complexity - b.complexity;
          return b.score - a.score;
        })
        .slice(0, 5);

      remediationCardIds = scored.map((c) => c.id);
    }

    // Strategy 2: If no topic matches, try embedding similarity on related cards
    if (remediationCardIds.length < 3) {
      // Find any card with matching topics to use as a seed for similarity search
      const seedCard = await prisma.card.findFirst({
        where: {
          rotation,
          topics: { hasSome: allTopics },
        },
        select: { id: true },
      });

      if (seedCard) {
        try {
          const similarCards = await findSimilar(seedCard.id, 5, 0.4);
          const similarIds = similarCards
            .filter((c) => !remediationCardIds.includes(c.cardId))
            .map((c) => c.cardId);

          // Add similarity-based cards
          remediationCardIds = [...new Set([...remediationCardIds, ...similarIds])].slice(0, 5);
        } catch {
          // Embedding search failed, continue with topic-based results
        }
      }
    }

    // Queue the remediation cards
    if (remediationCardIds.length > 0) {
      // Create progress records for new cards
      await prisma.cardProgress.createMany({
        data: remediationCardIds.map((cardId) => ({
          userId,
          cardId,
          nextDueAt: now,
        })),
        skipDuplicates: true,
      });

      // Update existing cards to be due now (if not suppressed/retired)
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);

      await prisma.cardProgress.updateMany({
        where: {
          userId,
          cardId: { in: remediationCardIds },
          suppressed: false,
          status: { not: 'retired' },
          // Only update if not already seen 2x today
          OR: [
            { viewsTodayDate: null },
            { viewsTodayDate: { lt: todayStart } },
            { viewsToday: { lt: 2 } },
          ],
        },
        data: {
          nextDueAt: now,
        },
      });
    }

    return { cardsQueued: remediationCardIds.length, cardIds: remediationCardIds };
  } catch (error) {
    logger.error('Group step remediation failed', { userId, error: String(error) });
    return { cardsQueued: 0, cardIds: [] };
  }
}

/**
 * Record struggle patterns from group attempts.
 * Tracks which phases/steps users consistently fail.
 */
export async function recordGroupStruggle(
  userId: string,
  groupId: string,
  failedStepPhases: string[]
): Promise<void> {
  // For now, just log it. Future: store in a StrugglePattern table
  // to identify systematic weaknesses (e.g., "always fails rhythm questions")
  if (failedStepPhases.length > 0) {
    logger.info('User struggled with phases in group', {
      userId,
      groupId,
      phases: failedStepPhases,
    });
  }
}
