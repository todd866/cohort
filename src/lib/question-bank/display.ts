import type { CuratedQuestion, OptionCombination } from './types';
import { shuffle, shuffleAvoidFirst } from '@/lib/utils/shuffle';

/**
 * First-look anti-A displacement probability.
 * With 5 options, displaceProb=0.75 → P(correct at A) ≈ 5%.
 * Subsequent attempts (attemptCount >= 1) use uniform shuffle.
 */
const FIRST_LOOK_AVOID_A_PROB = 0.75;

/**
 * Minimal input for getQuestionOptions - allows using with partial data
 * (e.g., from the API route where we only have the fields we need)
 */
export interface QuestionOptionsInput {
  id: string;
  options: Array<{ text: string; isCorrect: boolean; explanation?: string }>;
  combinations?: OptionCombination[] | null;
  correctVariants?: string[] | null;
}

export interface DisplayOption {
  label: string;
  text: string;
  isCorrect: boolean;
  /** Original index in the options array (for tracking) */
  originalIndex: number;
  /** Per-option explanation for post-answer feedback */
  explanation?: string;
}

export interface GetQuestionOptionsOptions {
  /**
   * If the user has seen this question before, avoid showing the correct answer
   * in the same display position again. This is stricter than random shuffling:
   * a repeated question should not be able to replay the same correct-answer
   * slot on back-to-back exposures.
   */
  avoidCorrectDisplayPosition?: number | null;
}

function moveCorrectAwayFromPosition(
  options: DisplayOption[],
  avoidPosition: number | null | undefined
): DisplayOption[] {
  if (avoidPosition == null || !Number.isInteger(avoidPosition)) return options;
  if (avoidPosition < 0 || avoidPosition >= options.length) return options;

  const correctIndex = options.findIndex((option) => option.isCorrect);
  if (correctIndex === -1 || correctIndex !== avoidPosition || options.length < 2) {
    return options;
  }

  const nextIndex = (correctIndex + 1) % options.length;
  const result = [...options];
  [result[correctIndex], result[nextIndex]] = [result[nextIndex], result[correctIndex]];
  return result;
}

/**
 * Get the options to display for a question based on attempt count.
 *
 * For questions with combinations:
 * - Selects the appropriate combination based on attemptCount % combinations.length
 * - Applies correct variant if available
 * - Deterministically shuffles option order (so correct isn't always A)
 *
 * For legacy questions (no combinations):
 * - Returns all options with deterministic shuffle
 *
 * @param question The curated question (or minimal input with id, options, combinations, correctVariants)
 * @param attemptCount Number of times user has attempted this question (0-indexed)
 * @returns Array of 5 options with labels A-E, deterministically shuffled
 */
export function getQuestionOptions(
  question: QuestionOptionsInput | CuratedQuestion,
  attemptCount: number = 0,
  options: GetQuestionOptionsOptions = {}
): DisplayOption[] {
  let selectedOptions: DisplayOption[];

  if (question.combinations?.length) {
    // Expanded question: select combination based on attempt count
    const comboIndex = attemptCount % question.combinations.length;
    const indices = question.combinations[comboIndex];

    selectedOptions = indices.map((optionIndex, position) => ({
      label: String.fromCharCode(65 + position), // A, B, C, D, E
      text: question.options[optionIndex].text,
      isCorrect: question.options[optionIndex].isCorrect,
      originalIndex: optionIndex,
      explanation: question.options[optionIndex].explanation,
    }));

    // Apply correct variant if available
    if (question.correctVariants?.length) {
      const variantIndex = attemptCount % question.correctVariants.length;
      const correctOptionIdx = selectedOptions.findIndex((o) => o.isCorrect);
      if (correctOptionIdx !== -1) {
        selectedOptions[correctOptionIdx] = {
          ...selectedOptions[correctOptionIdx],
          text: question.correctVariants[variantIndex],
        };
      }
    }
  } else {
    // Legacy question: use all options
    selectedOptions = question.options.map((opt, index) => ({
      label: String.fromCharCode(65 + index),
      text: opt.text,
      isCorrect: opt.isCorrect,
      originalIndex: index,
      explanation: opt.explanation,
    }));
  }

  // Random shuffle each time so options appear in a different order per encounter.
  // Previous seeded shuffle caused options to stick in the same position when
  // attemptCount didn't increment (same-session re-encounters, background job races).
  //
  // On first-look (attemptCount === 0) we anti-weight A so a learner who
  // clicks the visual default without engaging the option set isn't rewarded
  // with uniform 20% accuracy. Subsequent attempts get plain uniform shuffle.
  const shuffled = attemptCount === 0
    ? shuffleAvoidFirst(selectedOptions, (o) => o.isCorrect, FIRST_LOOK_AVOID_A_PROB)
    : shuffle(selectedOptions);
  const positionSafe = moveCorrectAwayFromPosition(
    shuffled,
    options.avoidCorrectDisplayPosition
  );

  // Reassign labels after shuffle
  return positionSafe.map((opt, index) => ({
    ...opt,
    label: String.fromCharCode(65 + index),
  }));
}

/**
 * Get the number of unique combinations available for a question.
 * For legacy questions, returns 1.
 */
export function getCombinationCount(question: CuratedQuestion): number {
  return question.combinations?.length || 1;
}

/**
 * Get the number of correct variants available for a question.
 * For questions without variants, returns 1.
 */
export function getCorrectVariantCount(question: CuratedQuestion): number {
  return question.correctVariants?.length || 1;
}

/**
 * Calculate total unique presentations of a question.
 * This is combinations × correctVariants (or just shuffle variations for legacy).
 */
export function getTotalVariations(question: CuratedQuestion): number {
  return getCombinationCount(question) * getCorrectVariantCount(question);
}
