import { bulkUpsertQuestions } from '@/lib/db/bulk-upsert';
import { buildQuestionCitationEnvelope } from '@/lib/usmle/public-corpus';
import { normalizeQuestionNotation } from './normalize-notation';
import type { CuratedQuestion } from './types';

export type CuratedQuestionBulkProjection = Parameters<typeof bulkUpsertQuestions>[1][number];

/** Canonical source-to-database projection shared by seeding and drift checks. */
export function projectCuratedQuestionForBulk(
  question: CuratedQuestion,
): CuratedQuestionBulkProjection {
  const q = normalizeQuestionNotation(question);
  return {
    id: q.id,
    sourceFile: q.sourceFile ?? null,
    stem: q.stem,
    options: q.options,
    context: q.context,
    rotation: q.rotation,
    week: typeof q.week === 'number' ? q.week : null,
    topics: q.topics,
    moduleNodes: q.moduleNodes ?? [],
    questionType: q.questionType,
    difficulty: q.difficulty,
    variantGroupId: q.variantGroupId ?? null,
    variantType: q.variantType ?? null,
    imageUrl: q.imageUrl ?? null,
    imageCaption: q.imageCaption ?? null,
    cite: q.cite ?? null,
    citationMetadata: buildQuestionCitationEnvelope(q.cite, q.publicUsmle),
    crosslinks: q.crosslinks ?? null,
    annotations: q.annotations ?? null,
    abbreviations: q.abbreviations ?? null,
    combinations: q.combinations ?? null,
    correctVariants: q.correctVariants ?? null,
  };
}
