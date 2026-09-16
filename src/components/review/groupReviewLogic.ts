import { QuestionGroupStep, StepOption } from '@/lib/question-groups/types';
import { shuffle, shuffleWithSeed } from '@/lib/utils/shuffle';

/**
 * Pure, React-free logic for the multi-step group review.
 *
 * Extracted from GroupReview.tsx so the sampling / option-variation rules can
 * be unit-tested in isolation (the display layer must vary combinations,
 * correct-variant phrasing, and option order across attempts — see the
 * regression tests in groupReviewLogic.test.ts).
 */

/**
 * Get filtered options for a step based on combinations.
 * If step has combinations, selects one combo and shuffles.
 * Otherwise returns all options shuffled.
 */
export function getStepDisplayOptions(step: QuestionGroupStep, attemptCount: number = 0): StepOption[] {
  if (step.type !== 'mcq' || !step.options) return [];

  let selectedOptions: StepOption[] = step.options;

  // Apply combinations if present
  if (step.combinations && step.combinations.length > 0) {
    const comboIndex = attemptCount % step.combinations.length;
    const indices = step.combinations[comboIndex];
    selectedOptions = indices.map(i => step.options![i]).filter(Boolean);
  }

  // Apply correctVariants if present
  if (step.correctVariants && step.correctVariants.length > 0) {
    const variantIndex = attemptCount % step.correctVariants.length;
    const variantText = step.correctVariants[variantIndex];
    selectedOptions = selectedOptions.map(opt =>
      opt.isCorrect ? { ...opt, text: variantText } : opt
    );
  }

  // Shuffle options (seeded by step id + attempt for consistency)
  const seed = `${step.id}-${attemptCount}`;
  return shuffleWithSeed(selectedOptions, seed);
}

/** Stable identity for a set of steps — used as a remount key so a new group resets all state. */
export function getResetKey(steps: QuestionGroupStep[]): string {
  return steps.map((step) => step.id).join('|');
}

/** Sample and shuffle steps within each phase while maintaining phase order. */
export function sampleWithinPhases(
  steps: QuestionGroupStep[],
  maxPerPhase: number = 2
): QuestionGroupStep[] {
  // Group by phase
  const phaseGroups: Map<string, QuestionGroupStep[]> = new Map();
  const phaseOrder: string[] = [];

  for (const step of steps) {
    const phase = step.phaseName ?? 'default';
    if (!phaseGroups.has(phase)) {
      phaseGroups.set(phase, []);
      phaseOrder.push(phase);
    }
    phaseGroups.get(phase)!.push(step);
  }

  // Sample from each phase and reassemble
  const result: QuestionGroupStep[] = [];
  for (const phase of phaseOrder) {
    const phaseSteps = phaseGroups.get(phase) ?? [];
    // Shuffle then take up to maxPerPhase
    const shuffled = shuffle(phaseSteps);
    const sampled = shuffled.slice(0, Math.min(maxPerPhase, shuffled.length));
    result.push(...sampled);
  }

  // Renumber steps
  return result.map((step, i) => ({
    ...step,
    stepNumber: i + 1,
  }));
}

const SYSTEMATIC_TYPES = ['ecg', 'cxr', 'abg'];

/**
 * Choose which steps to show for a group.
 * ECG/CXR/ABG are systematic — show all steps in order (no sampling).
 * Other types are sampled to keep sessions shorter.
 */
export function sampleStepsForType(
  steps: QuestionGroupStep[],
  groupType: string,
  maxPerPhase: number = 2
): QuestionGroupStep[] {
  if (SYSTEMATIC_TYPES.includes(groupType)) {
    return steps.map((step, i) => ({ ...step, stepNumber: i + 1 }));
  }
  return sampleWithinPhases(steps, maxPerPhase);
}
