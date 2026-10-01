import { responseFormatOfOptions } from './question-bank/statement-items';
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

/** Statement-item flags survive coercion so scoring can recognise the format. */
export type ScorableOption = { label: string; text: string; isCorrect: boolean; statement?: true; fixedKey?: true };

export function coerceScorableOptions(options: unknown): ScorableOption[] {
  if (!Array.isArray(options)) return [];
  return (options as Array<{ label?: unknown; text?: unknown; isCorrect?: unknown; statement?: unknown; fixedKey?: unknown }>)
    .map((o) => ({
      label: typeof o.label === 'string' ? o.label : null,
      text: typeof o.text === 'string' ? o.text : null,
      isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : null,
      ...(o.statement === true ? { statement: true as const } : {}),
      ...(o.fixedKey === true ? { fixedKey: true as const } : {}),
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
  // A Type X set is four independently true/false statements; any count is valid.
  if (responseFormatOfOptions(question.options) === 'typeX') return normalized.length === 4;
  const correctCount = normalized.filter((o) => o.isCorrect).length;
  return correctCount === 1;
}
