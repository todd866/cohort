import type { Prisma } from '@prisma/client';
import { getAllowedLegacyQuestionIds } from './legacy-allowlist';

export interface QuestionSourcePolicyOptions {
  allowLegacySourceFiles?: string[];
  allowLegacyQuestionIds?: string[];
  /** Skip the context != null filter (use for grading paths that need to handle already-served questions) */
  skipContextFilter?: boolean;
  /**
   * Allow private/email-gated sources (sourceFile starts with `question-bank/_private-`).
   * Default false — those questions are hidden from everyone unless the caller
   * has verified the session email is on the allowlist.
   */
  allowPrivateSources?: boolean;
}

export const PRIVATE_SOURCE_FILE_PREFIX = 'question-bank/_private-';

function mergeQuestionSourcePolicyOptions(
  options: QuestionSourcePolicyOptions = {}
): Required<QuestionSourcePolicyOptions> {
  return {
    allowLegacySourceFiles: Array.from(new Set(options.allowLegacySourceFiles ?? [])),
    allowLegacyQuestionIds: Array.from(new Set([
      ...getAllowedLegacyQuestionIds(),
      ...(options.allowLegacyQuestionIds ?? []),
    ])),
    skipContextFilter: options.skipContextFilter ?? false,
    allowPrivateSources: options.allowPrivateSources ?? false,
  };
}

export function isLegacyImportedQuestionId(
  questionId: string | null | undefined,
  options: QuestionSourcePolicyOptions = {}
): boolean {
  if (!questionId) return false;
  if (options.allowLegacyQuestionIds?.includes(questionId)) return false;
  return questionId.includes(':epub-');
}

export function isLegacyImportedQuestionSource(
  sourceFile: string | null | undefined,
  options: QuestionSourcePolicyOptions = {}
): boolean {
  if (!sourceFile) return false;
  if (options.allowLegacySourceFiles?.includes(sourceFile)) return false;
  return sourceFile.endsWith('.epub');
}

export function isLegacyQuestionExcludedByDefaultPolicy(
  question: { id: string | null | undefined; sourceFile: string | null | undefined },
  options: QuestionSourcePolicyOptions = {}
): boolean {
  const merged = mergeQuestionSourcePolicyOptions(options);
  if (question.id && merged.allowLegacyQuestionIds.includes(question.id)) return false;
  if (question.sourceFile && merged.allowLegacySourceFiles.includes(question.sourceFile)) return false;
  return (
    isLegacyImportedQuestionId(question.id) ||
    isLegacyImportedQuestionSource(question.sourceFile)
  );
}

export function withDefaultQuestionServingPolicy(
  where: Prisma.QuestionWhereInput,
  options: QuestionSourcePolicyOptions = {}
): Prisma.QuestionWhereInput {
  const { allowLegacySourceFiles, allowLegacyQuestionIds, allowPrivateSources } =
    mergeQuestionSourcePolicyOptions(options);
  const availabilityExclusion: Prisma.QuestionWhereInput = {
    NOT: { contentState: { in: ['shelved', 'retired', 'raw'] } },
  };
  const contextExclusion: Prisma.QuestionWhereInput | null =
    options.skipContextFilter ? null : { context: { not: null } };
  const defaultAllowed: Prisma.QuestionWhereInput = {
    AND: [
      {
        OR: [
          { sourceFile: null },
          { NOT: { sourceFile: { endsWith: '.epub' } } },
        ],
      },
      {
        NOT: { id: { contains: ':epub-' } },
      },
    ],
  };

  const explicitAllowlists: Prisma.QuestionWhereInput[] = [];
  if (allowLegacySourceFiles.length > 0) {
    explicitAllowlists.push({ sourceFile: { in: allowLegacySourceFiles } });
  }
  if (allowLegacyQuestionIds.length > 0) {
    explicitAllowlists.push({ id: { in: allowLegacyQuestionIds } });
  }

  const legacyExclusion: Prisma.QuestionWhereInput = explicitAllowlists.length > 0
    ? {
        OR: [defaultAllowed, ...explicitAllowlists],
      }
    : defaultAllowed;

  const filters = [availabilityExclusion, legacyExclusion];
  if (contextExclusion) filters.push(contextExclusion);
  if (!allowPrivateSources) {
    filters.push({
      OR: [
        { sourceFile: null },
        { NOT: { sourceFile: { startsWith: PRIVATE_SOURCE_FILE_PREFIX } } },
      ],
    });
  }

  if (!where || Object.keys(where).length === 0) {
    return { AND: filters };
  }

  return {
    AND: [where, ...filters],
  };
}
