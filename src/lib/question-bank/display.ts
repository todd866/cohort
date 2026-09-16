import type { CuratedQuestion, OptionCombination } from './types';
import { shuffle, displaceCorrectFromFirst } from '@/lib/utils/shuffle';

/**
 * Probability that a correct answer landing at A is displaced. Applied on EVERY
 * encounter, not only the first.
 *
 * WHY, and why the earlier reasoning was wrong. This was set to 0.75, then
 * zeroed on 2026-09-14 on the argument that A being correct 11.6% of the time
 * let a student raise their score by never choosing A, knowing no medicine --
 * an exploit larger than the blind-clicking it was meant to prevent.
 *
 * That argument imports an EXAM frame that does not apply here. md3 has no
 * score to protect, no ranking and no certification. "A learner could do better
 * without knowing medicine" only matters if the system's job is to MEASURE.
 * Its job is to teach. The owner's call, 2026-09-15: whether a learner could
 * game a score is not the concern; the point of "not A" is to make them read
 * past the first line.
 *
 * Read that way the displacement is not a rigged distribution, it is a teaching
 * intervention: an answer sitting at A rewards stopping at the first option,
 * and a learner who stops trusting A has learned to read the option set, which
 * is the intended outcome rather than a leak.
 *
 * It runs on repeats too. The reason to read past the first line does not expire
 * on second sight, and repeats are roughly three quarters of an active learner's
 * feed -- suppressing only first looks left the felt experience almost
 * unchanged, which is exactly what was reported.
 *
 * Format-level guessability (length bias, formatting tells) is still the job of
 * `analyzeGuessability`. This does not substitute for it.
 */
const AVOID_A_PROB = 0.75;

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

  // Swap with a UNIFORMLY RANDOM other slot, not with the neighbour.
  //
  // This was `(correctIndex + 1) % options.length`, which is deterministic, so
  // every displaced answer landed on the slot after the avoided one — giving it
  // double its fair share (measured: 39.9% vs 20%). The wrap made position 0 the
  // destination whenever the previous encounter showed the answer last, so
  // "don't repeat E" meant "show it at A", and A is the exact position the
  // first-look logic spends effort steering away from. Reported from the study
  // surface on 2026-09-14; averaged over all avoided positions the bias cancels
  // to nothing, which is why the aggregate telemetry missed it.
  const offset = 1 + Math.floor(Math.random() * (options.length - 1));
  const nextIndex = (correctIndex + offset) % options.length;
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
  // ORDER MATTERS, and getting it wrong is what made repeats WORSE than uniform.
  // The anti-A displacement must run LAST. When it ran first, the "don't repeat
  // last position" step afterwards could move the answer straight back onto A --
  // and because A had been suppressed, A was rarely the avoided position, so it
  // was almost always an eligible destination. Measured 2026-09-15: repeats sat
  // at 26.7% against a uniform 20%, above every other position.
  const shuffled = shuffle(selectedOptions);
  const positionSafe = moveCorrectAwayFromPosition(
    shuffled,
    options.avoidCorrectDisplayPosition
  );
  const aSafe = displaceCorrectFromFirst(
    positionSafe,
    (o) => o.isCorrect,
    AVOID_A_PROB,
    options.avoidCorrectDisplayPosition,
  );

  // Reassign labels after shuffle
  return aSafe.map((opt, index) => ({
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
