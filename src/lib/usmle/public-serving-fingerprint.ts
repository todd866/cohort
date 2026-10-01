import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export const PUBLIC_USMLE_STORED_QUESTION_SELECT = {
  id: true,
  stem: true,
  options: true,
  context: true,
  rotation: true,
  week: true,
  topics: true,
  moduleNodes: true,
  source: true,
  sourceFile: true,
  questionType: true,
  difficulty: true,
  format: true,
  variantGroupId: true,
  variantType: true,
  imageUrl: true,
  imageCaption: true,
  citations: true,
  crosslinks: true,
  annotations: true,
  abbreviations: true,
  combinations: true,
  correctVariants: true,
  contentState: true,
  excluded: true,
} as const satisfies Prisma.QuestionSelect;

export type PublicUsmleStoredQuestion = Prisma.QuestionGetPayload<{
  select: typeof PUBLIC_USMLE_STORED_QUESTION_SELECT;
}>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Hash every source-authoritative serving field, independent of JSON key order. */
export function publicUsmleServingFingerprint(
  question: PublicUsmleStoredQuestion,
): string {
  const payload: Partial<PublicUsmleStoredQuestion> = { ...question };
  Reflect.deleteProperty(payload, 'contentState');
  Reflect.deleteProperty(payload, 'excluded');
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

export function publicUsmleServingStateFailures(
  question: Pick<
    PublicUsmleStoredQuestion,
    'source' | 'excluded' | 'contentState' | 'moduleNodes'
  >,
): string[] {
  const reasons: string[] = [];
  if (question.source !== 'bank') reasons.push('source is not bank');
  if (question.excluded) reasons.push('question is excluded');
  if (!['validated', 'enhanced', 'cited', 'production'].includes(question.contentState)) {
    reasons.push(`contentState ${question.contentState} is not servable`);
  }
  if (!question.moduleNodes.includes('usmle/step1')) {
    reasons.push('missing module usmle/step1');
  }
  return reasons;
}
