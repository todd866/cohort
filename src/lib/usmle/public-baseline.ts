import { z } from 'zod';

export const USMLE_STEP1_BASELINE_V1_MODULE = 'usmle/step1/baseline/v1' as const;

const OpenUsmleBaselineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  questionIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

export interface OpenUsmleBaselineManifest {
  schemaVersion: 1;
  questionIds: string[];
}

/** Parse the checked-in baseline manifest and reject ambiguous membership. */
export function parseOpenUsmleBaselineManifest(input: unknown): OpenUsmleBaselineManifest {
  const manifest = OpenUsmleBaselineManifestSchema.parse(input);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const questionId of manifest.questionIds) {
    if (seen.has(questionId)) duplicates.add(questionId);
    seen.add(questionId);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate baseline question id(s): ${[...duplicates].sort().join(', ')}`,
    );
  }
  return manifest;
}

/** Return stable, safe ID-only errors for manifest members absent from the corpus. */
export function validateOpenUsmleBaselineReferences(
  manifest: OpenUsmleBaselineManifest,
  corpusQuestionIds: ReadonlySet<string>,
): string[] {
  return manifest.questionIds
    .filter((questionId) => !corpusQuestionIds.has(questionId))
    .sort()
    .map((questionId) => `Unknown baseline question ${questionId}`);
}
