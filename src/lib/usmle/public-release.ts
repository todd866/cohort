import { z } from 'zod';

const QuestionIdSchema = z.string().trim().min(1).max(500);
const ServingFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const OpenUsmleReleaseManifestSchema = z.object({
  schemaVersion: z.literal(2),
  questionIds: z.array(QuestionIdSchema).min(1),
  questionFingerprints: z.record(ServingFingerprintSchema),
}).strict();

export interface OpenUsmleReleaseManifest {
  schemaVersion: 2;
  questionIds: string[];
  questionFingerprints: Record<string, string>;
}

/** Parse the explicit allowlist for the corpus that production may serve. */
export function parseOpenUsmleReleaseManifest(input: unknown): OpenUsmleReleaseManifest {
  const manifest = OpenUsmleReleaseManifestSchema.parse(input);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const questionId of manifest.questionIds) {
    if (seen.has(questionId)) duplicates.add(questionId);
    seen.add(questionId);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate release question id(s): ${[...duplicates].sort().join(', ')}`,
    );
  }
  const fingerprintIds = Object.keys(manifest.questionFingerprints);
  const releaseIds = new Set(manifest.questionIds);
  const missingFingerprintIds = manifest.questionIds
    .filter((questionId) => !(questionId in manifest.questionFingerprints));
  const unexpectedFingerprintIds = fingerprintIds
    .filter((questionId) => !releaseIds.has(questionId));
  if (missingFingerprintIds.length > 0 || unexpectedFingerprintIds.length > 0) {
    throw new Error([
      ...missingFingerprintIds
        .sort()
        .map((questionId) => `Missing release fingerprint ${questionId}`),
      ...unexpectedFingerprintIds
        .sort()
        .map((questionId) => `Unexpected release fingerprint ${questionId}`),
    ].join('; '));
  }
  return manifest;
}

/**
 * Require an exact set match. New source files do not become public merely by
 * being added to a directory, and deleted files cannot linger on the allowlist.
 */
export function validateOpenUsmleReleaseMembership(
  manifest: OpenUsmleReleaseManifest,
  corpusQuestionIds: ReadonlySet<string>,
): string[] {
  const releaseIds = new Set(manifest.questionIds);
  return [
    ...manifest.questionIds
      .filter((questionId) => !corpusQuestionIds.has(questionId))
      .map((questionId) => `Unknown release question ${questionId}`),
    ...[...corpusQuestionIds]
      .filter((questionId) => !releaseIds.has(questionId))
      .map((questionId) => `Unreleased source question ${questionId}`),
  ].sort();
}

/**
 * Recompute source fingerprints in the release gate/seed loader. A checked-in
 * hash is an assertion, never authority by itself.
 */
export function validateOpenUsmleReleaseFingerprints(
  manifest: OpenUsmleReleaseManifest,
  sourceFingerprints: Readonly<Record<string, string>>,
): string[] {
  return manifest.questionIds
    .flatMap((questionId) => {
      const sourceFingerprint = sourceFingerprints[questionId];
      if (!sourceFingerprint) return [`Missing source fingerprint ${questionId}`];
      if (sourceFingerprint !== manifest.questionFingerprints[questionId]) {
        return [`Release fingerprint differs from source ${questionId}`];
      }
      return [];
    })
    .sort();
}
