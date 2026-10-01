import { shuffle } from '@/lib/utils/shuffle';

export interface QuestionDisplayOption {
  label: string;
  text: string;
  isCorrect: boolean;
  explanation?: string;
  originalLabel?: string;
}

function optionLabelForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

export function normalizeQuestionDisplayOptions(options: unknown): QuestionDisplayOption[] {
  if (!Array.isArray(options)) return [];

  return options.flatMap((option) => {
    if (!option || typeof option !== 'object') return [];

    const label = 'label' in option && typeof option.label === 'string'
      ? option.label.trim().toUpperCase()
      : null;
    const text = 'text' in option && typeof option.text === 'string'
      ? option.text
      : null;
    const isCorrect = 'isCorrect' in option && option.isCorrect === true;
    const explanation = 'explanation' in option && typeof option.explanation === 'string'
      ? option.explanation
      : undefined;

    if (!label || !text) return [];

    return [{
      label,
      text,
      isCorrect,
      ...(explanation ? { explanation } : {}),
    }];
  });
}

export function relabelQuestionDisplayOptions(
  options: QuestionDisplayOption[]
): QuestionDisplayOption[] {
  return options.map((option, index) => ({
    ...option,
    originalLabel: option.label,
    label: optionLabelForIndex(index),
  }));
}

export function shuffleQuestionDisplayOptions(
  options: unknown,
  shuffleFn: (items: QuestionDisplayOption[]) => QuestionDisplayOption[] = shuffle
): QuestionDisplayOption[] {
  return relabelQuestionDisplayOptions(shuffleFn(normalizeQuestionDisplayOptions(options)));
}
