// Shared MCQ utilities - extracted from duplicated code across MCQ components

import { shuffleWithSeed } from '@/lib/utils/shuffle';
import { splitAtSentences } from '@/lib/utils/split-sentences';
export { shuffleWithSeed };

// ─── Types ──────────────────────────────────────────────────────

export interface MCQProps {
  id?: string;
  stem?: string;
  options?: MCQOption[] | string[];
  image?: string;
  imageUrl?: string;
  correctAnswer?: string | number;
  context?: string;
  question?: string;
  answer?: string;
  distractors?: string[];
  type?: 'SBA' | 'EMQ';
  difficulty?: 'easy' | 'medium' | 'hard';
  topics?: string[];
  jurisdiction?: string;
  cite?: string;
}

export interface QuestionVariant {
  id: string;
  stem: string;
  options: MCQOption[];
  context: string | null;
  shuffleSeed: string;
  difficulty: string;
}

// ─── Helpers ────────────────────────────────────────────────────

export function optionLabelForIndex(index: number): string {
  return String.fromCharCode(65 + index);
}

export function splitExplanation(text: string): string[] {
  const blocks = text.split('\n\n').map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 1) {
    const single = blocks[0];
    const wordCount = single.split(/\s+/).filter(Boolean).length;
    if (single.length > 160 || wordCount > 45) {
      return splitAtSentences(single);
    }
  }
  return blocks.length > 0 ? blocks : [text];
}

export function parsePathname(pathname: string): { rotation: string | null; week: number | null } {
  const match = pathname.match(/^\/([\w-]+)\/week\/(\d+)/);
  if (!match) return { rotation: null, week: null };
  return { rotation: match[1], week: parseInt(match[2], 10) };
}

// Module-level dedup: track variant IDs per page to prevent duplicates
let _excludePath = '';
const _excludeIds = new Set<string>();

export function getExcludeIds(pathname: string): string[] {
  if (pathname !== _excludePath) {
    _excludePath = pathname;
    _excludeIds.clear();
  }
  return [..._excludeIds];
}

export function markReturned(pathname: string, questionId: string): void {
  if (pathname !== _excludePath) {
    _excludePath = pathname;
    _excludeIds.clear();
  }
  _excludeIds.add(questionId);
}

export function getActiveWeeklyKeyboardBlock(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-content-block][data-feed-focused="true"]');
}

/**
 * Normalize heterogeneous MCQ input (canonical schema, legacy schema)
 * into a consistent internal format.
 */
export function normalizeStaticMCQInput(props: MCQProps): {
  stem: string;
  options: MCQOption[];
  correctAnswer?: string;
  context: string;
} {
  const stem = (props.stem ?? props.question ?? '').trim();
  const context = props.context ?? '';

  const normalizedOptions: MCQOption[] = [];
  if (Array.isArray(props.options) && props.options.length > 0) {
    for (let i = 0; i < props.options.length; i++) {
      const raw = props.options[i];
      if (typeof raw === 'string') {
        normalizedOptions.push({
          label: optionLabelForIndex(i),
          text: raw,
        });
        continue;
      }

      if (!raw || typeof raw !== 'object') continue;
      if (!('text' in raw) || typeof raw.text !== 'string' || raw.text.trim().length === 0) continue;

      const label =
        'label' in raw && typeof raw.label === 'string' && raw.label.trim().length > 0
          ? raw.label.trim().toUpperCase()
          : optionLabelForIndex(i);

      normalizedOptions.push({
        label,
        text: raw.text,
        isCorrect: typeof raw.isCorrect === 'boolean' ? raw.isCorrect : undefined,
        explanation: 'explanation' in raw && typeof raw.explanation === 'string' ? raw.explanation : undefined,
      });
    }
  }

  // Legacy fallback: answer + distractors
  if (
    normalizedOptions.length === 0 &&
    typeof props.answer === 'string' &&
    props.answer.trim().length > 0 &&
    Array.isArray(props.distractors)
  ) {
    const combined = [props.answer, ...props.distractors.filter((d) => typeof d === 'string')];
    for (let i = 0; i < combined.length; i++) {
      normalizedOptions.push({
        label: optionLabelForIndex(i),
        text: combined[i],
        isCorrect: i === 0,
      });
    }
  }

  let normalizedCorrectAnswer: string | undefined;
  if (typeof props.correctAnswer === 'string' && props.correctAnswer.trim().length > 0) {
    const trimmed = props.correctAnswer.trim();
    if (/^[A-Za-z]$/.test(trimmed)) {
      normalizedCorrectAnswer = trimmed.toUpperCase();
    } else {
      const idx = normalizedOptions.findIndex((opt) => opt.text.trim() === trimmed);
      if (idx >= 0) {
        normalizedCorrectAnswer = normalizedOptions[idx].label.toUpperCase();
      }
    }
  } else if (typeof props.correctAnswer === 'number' && Number.isFinite(props.correctAnswer)) {
    const idx = Math.trunc(props.correctAnswer);
    if (idx >= 0 && idx < normalizedOptions.length) {
      normalizedCorrectAnswer = normalizedOptions[idx].label.toUpperCase();
    }
  }

  if (!normalizedCorrectAnswer && typeof props.answer === 'string' && props.answer.trim().length > 0) {
    const answerText = props.answer.trim();
    const idx = normalizedOptions.findIndex((opt) => opt.text.trim() === answerText);
    if (idx >= 0) {
      normalizedCorrectAnswer = normalizedOptions[idx].label.toUpperCase();
    }
  }

  if (!normalizedCorrectAnswer) {
    const explicit = normalizedOptions.find((opt) => opt.isCorrect);
    if (explicit) normalizedCorrectAnswer = explicit.label.toUpperCase();
  }

  return {
    stem,
    options: normalizedOptions,
    correctAnswer: normalizedCorrectAnswer,
    context,
  };
}

export interface MCQOption {
  label: string;
  text: string;
  isCorrect?: boolean;
  originalLabel?: string;
  explanation?: string;
}

export interface McqAttemptPayload {
  selectedOption: string;
  correctDisplayPosition?: number;
  selectedDisplayPosition?: number | null;
}

// Difficulty badge colors
export const difficultyColors = {
  easy: 'badge-easy',
  medium: 'badge-medium',
  hard: 'badge-hard',
  beginner: 'badge-beginner',
  intermediate: 'badge-intermediate',
  advanced: 'badge-advanced',
} as const;

// Option button styling — returns CSS class names
export function getOptionStyle(
  label: string,
  selectedAnswer: string | null,
  correctLabel: string,
  hasAnswered: boolean,
  hasExplanation?: boolean
): string {
  const classes = ['option-btn'];

  if (!hasAnswered) {
    if (selectedAnswer === label) classes.push('selected');
    return classes.join(' ');
  }

  if (hasExplanation) classes.push('has-detail');

  if (label === correctLabel) {
    classes.push('correct');
  } else if (selectedAnswer === label) {
    classes.push('incorrect');
  } else {
    classes.push('dimmed');
  }

  return classes.join(' ');
}

// Option label (A, B, C, D) styling — returns CSS class names
export function getOptionLabelStyle(
  label: string,
  selectedAnswer: string | null,
  correctLabel: string,
  hasAnswered: boolean
): string {
  const classes = ['option-label'];

  if (!hasAnswered) {
    if (selectedAnswer === label) classes.push('active');
    return classes.join(' ');
  }

  if (label === correctLabel) {
    classes.push('correct');
  } else if (selectedAnswer === label) {
    classes.push('incorrect');
  } else {
    classes.push('dimmed');
  }

  return classes.join(' ');
}

// Coerce untyped options array to MCQOption[]
export function coerceOptions(options: unknown): MCQOption[] {
  if (!Array.isArray(options)) return [];

  const coerced: MCQOption[] = [];
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue;
    const label = 'label' in opt && typeof opt.label === 'string' ? opt.label : null;
    const text = 'text' in opt && typeof opt.text === 'string' ? opt.text : null;
    if (!label || !text) continue;

    const result: MCQOption = { label, text };
    if ('isCorrect' in opt && typeof opt.isCorrect === 'boolean') {
      result.isCorrect = opt.isCorrect;
    }
    if ('explanation' in opt && typeof opt.explanation === 'string') {
      result.explanation = opt.explanation;
    }
    coerced.push(result);
  }
  return coerced;
}

// Process and shuffle options, returning shuffled array and correct label
export function processOptions(
  options: MCQOption[],
  seed: string,
  correctAnswer?: string
): { shuffledOptions: MCQOption[]; correctLabel: string } {
  const correctOpt = correctAnswer
    ? options.find((o) => o.label === correctAnswer)
    : options.find((o) => o.isCorrect);

  const shuffled = shuffleWithSeed(options, seed);
  const newCorrectIndex = correctOpt ? shuffled.indexOf(correctOpt) : 0;

  return {
    shuffledOptions: shuffled.map((opt, idx) => ({
      ...opt,
      originalLabel: opt.label,
      label: String.fromCharCode(65 + idx),
    })),
    correctLabel: String.fromCharCode(65 + newCorrectIndex),
  };
}

export function buildMcqAttemptPayload(
  displayOptions: Array<Pick<MCQOption, 'label' | 'originalLabel' | 'isCorrect'>>,
  selectedLabel: string
): McqAttemptPayload {
  const normalizedSelectedLabel = selectedLabel.trim().toUpperCase();
  const selectedDisplayPosition = displayOptions.findIndex(
    (option) => option.label.toUpperCase() === normalizedSelectedLabel
  );
  const correctDisplayPosition = displayOptions.findIndex((option) => option.isCorrect);
  const selectedOption =
    displayOptions[selectedDisplayPosition]?.originalLabel ?? normalizedSelectedLabel;

  return {
    selectedOption,
    correctDisplayPosition: correctDisplayPosition >= 0 ? correctDisplayPosition : undefined,
    selectedDisplayPosition: selectedDisplayPosition >= 0 ? selectedDisplayPosition : null,
  };
}

export function getDisplayLabelForOriginalOption(
  displayOptions: Array<Pick<MCQOption, 'label' | 'originalLabel'>>,
  originalLabel: string
): string {
  const normalizedOriginalLabel = originalLabel.trim().toUpperCase();
  if (!normalizedOriginalLabel) return normalizedOriginalLabel;

  const match = displayOptions.find(
    (option) => (option.originalLabel ?? option.label).toUpperCase() === normalizedOriginalLabel
  );
  return match?.label ?? normalizedOriginalLabel;
}
