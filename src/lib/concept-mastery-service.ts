/**
 * Concept Mastery Service
 *
 * Higher-level service for managing concept state across the application.
 * Handles decay, weak concept identification, and question selection.
 *
 * Now uses ConceptState (unified learning state) instead of ConceptMastery.
 */

import { prisma } from '@/lib/prisma';

interface ConceptWithMastery {
  id: string;
  name: string;
  rotation: string;
  week: number | null;
  examWeight: number;
  mastery: number; // recallProbability from ConceptState
  confidence: number;
  lastTested: Date | null; // lastProbeAt from ConceptState
  questionsAttempted: number; // probeCount from ConceptState
}

interface WeakConcept extends ConceptWithMastery {
  priority: number; // Higher = more urgent to study
}

/**
 * Apply decay to a recall probability based on time elapsed
 */
function applyDecay(
  recall: number,
  lastComputed: Date,
  decayRate: number,
  now: Date
): number {
  const daysSince = (now.getTime() - lastComputed.getTime()) / (1000 * 60 * 60 * 24);
  // Exponential decay with confidence-adjusted rate
  return recall * Math.exp(-decayRate * daysSince);
}

/**
 * Get all concepts with current mastery for a user in a rotation
 */
export async function getConceptMasteryForRotation(
  userId: string,
  rotation: string
): Promise<ConceptWithMastery[]> {
  const concepts = await prisma.concept.findMany({
    where: { rotation },
    include: {
      conceptStates: {
        where: { userId },
      },
    },
    orderBy: [{ week: 'asc' }, { examWeight: 'desc' }],
  });

  const now = new Date();

  return concepts.map((concept) => {
    const state = concept.conceptStates[0];

    // Apply decay if state exists
    let currentMastery = 0;
    let confidence = 0;

    if (state) {
      currentMastery = applyDecay(
        state.recallProbability,
        state.lastComputed,
        state.decayRate,
        now
      );
      confidence = state.confidence;
    }

    return {
      id: concept.id,
      name: concept.name,
      rotation: concept.rotation,
      week: concept.week,
      examWeight: concept.examWeight,
      mastery: currentMastery,
      confidence,
      lastTested: state?.lastProbeAt ?? null,
      questionsAttempted: state?.probeCount ?? 0,
    };
  });
}

/**
 * Identify weak concepts that need more practice
 */
export async function getWeakConcepts(
  userId: string,
  rotation: string,
  options: {
    masteryThreshold?: number; // Below this = weak (default 0.6)
    limit?: number; // Max concepts to return (default 10)
  } = {}
): Promise<WeakConcept[]> {
  const { masteryThreshold = 0.6, limit = 10 } = options;

  const allConcepts = await getConceptMasteryForRotation(userId, rotation);

  // Filter to weak concepts and calculate priority
  const weakConcepts: WeakConcept[] = allConcepts
    .filter((c) => c.mastery < masteryThreshold)
    .map((concept) => {
      // Priority factors:
      // 1. Exam weight (higher = more important)
      // 2. Inverse mastery (lower mastery = higher priority)
      // 3. Time since last tested (longer = higher priority)
      let priority = concept.examWeight * (1 - concept.mastery);

      if (concept.lastTested) {
        const daysSinceTest =
          (Date.now() - concept.lastTested.getTime()) / (1000 * 60 * 60 * 24);
        priority += Math.min(daysSinceTest / 7, 2); // Cap at +2 for 14+ days
      } else {
        priority += 3; // Never tested = high priority
      }

      return {
        ...concept,
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

  return weakConcepts;
}

/**
 * Compute overall readiness for an exam based on concept mastery
 */
export async function computeExamReadiness(
  userId: string,
  rotation: string
): Promise<{
  overallReadiness: number;
  conceptsCovered: number;
  totalConcepts: number;
  weakAreas: string[];
  strongAreas: string[];
}> {
  const concepts = await getConceptMasteryForRotation(userId, rotation);

  if (concepts.length === 0) {
    return {
      overallReadiness: 0,
      conceptsCovered: 0,
      totalConcepts: 0,
      weakAreas: [],
      strongAreas: [],
    };
  }

  // Weight by exam importance
  let totalWeight = 0;
  let weightedMastery = 0;

  for (const concept of concepts) {
    const weight = concept.examWeight;
    totalWeight += weight;
    weightedMastery += concept.mastery * weight;
  }

  const overallReadiness = totalWeight > 0 ? weightedMastery / totalWeight : 0;

  // Identify weak and strong areas
  const weak = concepts
    .filter((c) => c.mastery < 0.5)
    .sort((a, b) => a.mastery - b.mastery)
    .slice(0, 5)
    .map((c) => c.name);

  const strong = concepts
    .filter((c) => c.mastery >= 0.8)
    .sort((a, b) => b.mastery - a.mastery)
    .slice(0, 5)
    .map((c) => c.name);

  const covered = concepts.filter((c) => c.questionsAttempted > 0).length;

  return {
    overallReadiness,
    conceptsCovered: covered,
    totalConcepts: concepts.length,
    weakAreas: weak,
    strongAreas: strong,
  };
}
