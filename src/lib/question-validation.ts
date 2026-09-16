/**
 * Shared question usability validation.
 *
 * A question is usable for study sessions when it has:
 * - A non-empty explanation
 * - No excluded topics (canonical list lives in @/lib/study/servable-pool)
 * - At least 4 well-formed options with labels, text, and boolean isCorrect
 * - Exactly 1 correct answer
 */

import { EXCLUDED_POOL_TOPICS } from './study/servable-pool';

export type ScorableOption = { label: string; text: string; isCorrect: boolean };

export function coerceScorableOptions(options: unknown): ScorableOption[] {
  if (!Array.isArray(options)) return [];
  return (options as Array<{ label?: unknown; text?: unknown; isCorrect?: unknown }>)
    .map((o) => ({
      label: typeof o.label === 'string' ? o.label : null,
      text: typeof o.text === 'string' ? o.text : null,
      isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : null,
    }))
    .filter((o): o is ScorableOption => !!o.label && !!o.text && typeof o.isCorrect === 'boolean');
}

export function isUsableQuestion(question: {
  options: unknown;
  context: string | null;
  topics: string[];
}): boolean {
  if (!question.context || question.context.trim().length === 0) return false;
  if (
    Array.isArray(question.topics) &&
    question.topics.some((t) => (EXCLUDED_POOL_TOPICS as readonly string[]).includes(t))
  ) {
    return false;
  }
  if (!Array.isArray(question.options) || question.options.length < 4) return false;
  const options = question.options as Array<{ label?: unknown; text?: unknown; isCorrect?: unknown }>;
  const normalized = options
    .map((o) => ({
      label: typeof o.label === 'string' ? o.label : null,
      text: typeof o.text === 'string' ? o.text : null,
      isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : null,
    }))
    .filter((o) => !!o.label && !!o.text && typeof o.isCorrect === 'boolean');
  if (normalized.length < 4) return false;
  const correctCount = normalized.filter((o) => o.isCorrect).length;
  return correctCount === 1;
}
