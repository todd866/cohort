import { tagFormat } from '@/lib/questions/format-tagger';
import type { Prisma } from '@prisma/client';
import {
  projectCuratedQuestionForBulk,
  type CuratedQuestionBulkProjection,
} from '@/lib/question-bank/seed-projection';
import type { CuratedQuestion } from '@/lib/question-bank/types';
import {
  publicUsmleServingFingerprint,
  publicUsmleServingStateFailures,
  type PublicUsmleStoredQuestion,
} from './public-serving-fingerprint';

export {
  PUBLIC_USMLE_STORED_QUESTION_SELECT,
  publicUsmleServingFingerprint,
  publicUsmleServingStateFailures,
  type PublicUsmleStoredQuestion,
} from './public-serving-fingerprint';

export interface PublicUsmleServingDriftReport {
  schemaVersion: 1;
  expectedCount: number;
  databaseCount: number;
  matchingCount: number;
  missingIds: string[];
  unexpectedIds: string[];
  contentDriftIds: string[];
  stateDrift: Array<{ questionId: string; reasons: string[] }>;
}

function seededPayload(
  projected: CuratedQuestionBulkProjection,
): Omit<PublicUsmleStoredQuestion, 'contentState' | 'excluded'> {
  return {
    id: projected.id,
    stem: projected.stem,
    options: projected.options as Prisma.JsonValue,
    context: projected.context,
    rotation: projected.rotation,
    week: projected.week,
    topics: projected.topics,
    moduleNodes: projected.moduleNodes ?? [],
    source: 'bank',
    sourceFile: projected.sourceFile ?? 'question-bank',
    questionType: projected.questionType,
    difficulty: projected.difficulty,
    format: projected.format
      ?? tagFormat(projected.stem, projected.topics, projected.questionType),
    variantGroupId: projected.variantGroupId ?? null,
    variantType: projected.variantType ?? null,
    imageUrl: projected.imageUrl ?? null,
    imageCaption: projected.imageCaption ?? null,
    citations: projected.citationMetadata ?? (
      projected.cite ? { cite: projected.cite } : null
    ),
    crosslinks: projected.crosslinks ?? null,
    annotations: projected.annotations ?? null,
    abbreviations: projected.abbreviations ?? null,
    combinations: projected.combinations ?? null,
    correctVariants: projected.correctVariants ?? null,
  };
}

export function expectedPublicUsmleStoredQuestion(
  question: CuratedQuestion,
): PublicUsmleStoredQuestion {
  return {
    ...seededPayload(projectCuratedQuestionForBulk(question)),
    contentState: 'enhanced',
    excluded: false,
  };
}

export function buildPublicUsmleReleaseFingerprints(
  questions: CuratedQuestion[],
  options: { baselineQuestionIds?: ReadonlySet<string> } = {},
): Record<string, string> {
  return Object.fromEntries(
    [...questions]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((question) => {
        const projected = options.baselineQuestionIds?.has(question.id)
          ? {
              ...question,
              moduleNodes: Array.from(new Set([
                ...(question.moduleNodes ?? []),
                'usmle/step1/baseline/v1',
              ])),
            }
          : question;
        return [
          question.id,
          publicUsmleServingFingerprint(expectedPublicUsmleStoredQuestion(projected)),
        ];
      }),
  );
}

export function buildPublicUsmleServingDriftReport(
  expectedQuestions: CuratedQuestion[],
  databaseQuestions: PublicUsmleStoredQuestion[],
): PublicUsmleServingDriftReport {
  const expected = new Map(expectedQuestions.map((question) => {
    const projected = expectedPublicUsmleStoredQuestion(question);
    return [projected.id, projected];
  }));
  const actual = new Map(databaseQuestions.map((question) => [question.id, question]));
  const missingIds = [...expected.keys()].filter((id) => !actual.has(id)).sort();
  const unexpectedIds = [...actual.keys()].filter((id) => !expected.has(id)).sort();
  const contentDriftIds: string[] = [];
  const stateDrift: Array<{ questionId: string; reasons: string[] }> = [];
  let matchingCount = 0;

  for (const [questionId, expectedQuestion] of expected) {
    const actualQuestion = actual.get(questionId);
    if (!actualQuestion) continue;
    const reasons = publicUsmleServingStateFailures(actualQuestion);
    if (reasons.length > 0) stateDrift.push({ questionId, reasons });
    if (
      publicUsmleServingFingerprint(expectedQuestion)
      !== publicUsmleServingFingerprint(actualQuestion)
    ) {
      contentDriftIds.push(questionId);
    } else if (reasons.length === 0) {
      matchingCount += 1;
    }
  }

  contentDriftIds.sort();
  stateDrift.sort((a, b) => a.questionId.localeCompare(b.questionId));
  return {
    schemaVersion: 1,
    expectedCount: expected.size,
    databaseCount: actual.size,
    matchingCount,
    missingIds,
    unexpectedIds,
    contentDriftIds,
    stateDrift,
  };
}

export function publicUsmleServingDriftFailures(
  report: PublicUsmleServingDriftReport,
): string[] {
  const failures: string[] = [];
  if (report.missingIds.length > 0) {
    failures.push(`${report.missingIds.length} released question(s) are missing from the serving database`);
  }
  if (report.unexpectedIds.length > 0) {
    failures.push(`${report.unexpectedIds.length} database question(s) are outside the release manifest`);
  }
  if (report.contentDriftIds.length > 0) {
    failures.push(`${report.contentDriftIds.length} released question(s) differ from checked-in source`);
  }
  if (report.stateDrift.length > 0) {
    failures.push(`${report.stateDrift.length} released question(s) are not in a servable state`);
  }
  if (report.matchingCount !== report.expectedCount) {
    failures.push(
      `only ${report.matchingCount}/${report.expectedCount} released question(s) match source and serving state`,
    );
  }
  return failures;
}
