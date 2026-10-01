import type { CuratedQuestionOption } from './types';

export interface ExtractedMisconception {
  optionLabel: string;
  misconception: string;
}

/**
 * Extract misconception metadata from question bank options.
 * Only extracts from incorrect options that have a misconception field.
 */
export function extractMisconceptions(
  options: CuratedQuestionOption[]
): ExtractedMisconception[] {
  return options
    .filter((o) => !o.isCorrect && o.misconception)
    .map((o) => ({
      optionLabel: o.label,
      misconception: o.misconception!,
    }));
}
