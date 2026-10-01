/**
 * Concept Mastery Computation
 *
 * Computes user mastery of clinical concepts based on question responses.
 * Uses time-weighted scoring where recent responses matter more.
 */

import { daysBetween } from './date-utils';

export interface QuestionResponseData {
  isCorrect: boolean;
  createdAt: Date;
}

interface MasteryResult {
  mastery: number; // 0-1 probability of recall
  confidence: number; // 0-1 confidence in the estimate
}

interface DifficultyResult {
  facilityIndex: number; // % who got it right
  difficulty: 'easy' | 'medium' | 'hard' | null;
}

export interface QuestionForSelection {
  id: string;
  conceptIds: string[];
  difficulty: string;
  lastAttempted: Date | null;
}

/**
 * Compute mastery for a concept based on question responses.
 *
 * Uses exponential time-weighting: recent responses count more.
 * Confidence increases with more data points (capped at 10).
 */
export function computeConceptMastery(
  responses: QuestionResponseData[],
  now: Date = new Date()
): MasteryResult {
  if (responses.length === 0) {
    return { mastery: 0, confidence: 0 };
  }

  let weightedCorrect = 0;
  let totalWeight = 0;

  for (const response of responses) {
    const daysSince = daysBetween(response.createdAt, now);
    // Exponential decay: half-life of ~7 days
    const weight = Math.exp(-0.1 * daysSince);

    totalWeight += weight;
    if (response.isCorrect) {
      weightedCorrect += weight;
    }
  }

  const mastery = totalWeight > 0 ? weightedCorrect / totalWeight : 0;

  // Confidence increases with more data points, capped at 1.0
  // 10+ responses = full confidence
  const confidence = Math.min(1, responses.length / 10);

  return { mastery, confidence };
}

/**
 * Apply time decay to a stored mastery value.
 *
 * @param mastery - The stored mastery value (0-1)
 * @param lastComputed - When the mastery was last computed
 * @param decayRate - How fast mastery decays (default 0.1)
 * @returns The decayed mastery value
 */
export function decayMastery(
  mastery: number,
  lastComputed: Date,
  decayRate: number = 0.1,
  now: Date = new Date()
): number {
  const daysSince = daysBetween(lastComputed, now);
  // Exponential decay
  const decayedMastery = mastery * Math.exp(-decayRate * daysSince);
  return Math.max(0, decayedMastery);
}

/**
 * Compute question difficulty from response history.
 *
 * @param responses - Array of {isCorrect} from all users
 * @param minResponses - Minimum responses needed for reliable estimate
 * @returns Facility index and difficulty category
 */
export function computeQuestionDifficulty(
  responses: Array<{ isCorrect: boolean }>,
  minResponses: number = 5
): DifficultyResult {
  if (responses.length < minResponses) {
    // Not enough data for reliable difficulty estimate
    const facilityIndex = responses.length > 0
      ? responses.filter((r) => r.isCorrect).length / responses.length
      : 0.5;
    return { facilityIndex, difficulty: null };
  }

  const correctCount = responses.filter((r) => r.isCorrect).length;
  const facilityIndex = correctCount / responses.length;

  // Categorize difficulty
  let difficulty: 'easy' | 'medium' | 'hard';
  if (facilityIndex >= 0.7) {
    difficulty = 'easy';
  } else if (facilityIndex >= 0.4) {
    difficulty = 'medium';
  } else {
    difficulty = 'hard';
  }

  return { facilityIndex, difficulty };
}

/**
 * Select questions to serve for a concept, considering:
 * - User's current mastery level
 * - Question difficulty
 * - When questions were last attempted
 *
 * @param conceptId - The concept to select questions for
 * @param questions - Available questions
 * @param options - Selection options
 * @returns Ordered list of questions to serve
 */
export function selectQuestionsForConcept(
  conceptId: string,
  questions: QuestionForSelection[],
  options: {
    mastery: number;
    limit: number;
    minDaysSinceAttempt?: number;
    now?: Date;
  }
): QuestionForSelection[] {
  const { mastery, limit, minDaysSinceAttempt = 0, now = new Date() } = options;

  // Filter to questions that test this concept
  const conceptQuestions = questions.filter((q) =>
    q.conceptIds.includes(conceptId)
  );

  if (conceptQuestions.length === 0) {
    return [];
  }

  // Score each question for selection
  const scored = conceptQuestions.map((q) => {
    let score = 0;

    // Prioritize unseen questions
    if (q.lastAttempted === null) {
      score += 100;
    } else {
      const daysSince = daysBetween(q.lastAttempted, now);
      // Skip if too recently attempted
      if (daysSince < minDaysSinceAttempt) {
        return { question: q, score: -1 };
      }
      // Bonus for questions not seen in a while
      score += Math.min(daysSince, 30);
    }

    // Match difficulty to mastery
    // Low mastery → prefer easy questions
    // High mastery → prefer hard questions
    const difficultyScores: Record<string, number> = {
      easy: mastery < 0.4 ? 20 : mastery > 0.7 ? -10 : 0,
      medium: mastery >= 0.3 && mastery <= 0.7 ? 15 : 0,
      hard: mastery > 0.6 ? 20 : mastery < 0.3 ? -10 : 0,
    };
    score += difficultyScores[q.difficulty] || 0;

    return { question: q, score };
  });

  // Filter out questions with negative scores (too recently attempted)
  const valid = scored.filter((s) => s.score >= 0);

  // Sort by score descending
  valid.sort((a, b) => b.score - a.score);

  // Return top N
  return valid.slice(0, limit).map((s) => s.question);
}
