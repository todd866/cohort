import {
  loadSeedQuestionBanksFromDisk,
  type LoadedSeedQuestionCorpus,
} from './load-seed-corpus';
import { loadExcludedQuestionIdsFromDisk } from './exclusions-disk';
import { checkLengthBias,
  checkCombinationLengthBias, checkFormatAsymmetry } from './validate';
import { checkFormOpacity } from '@/lib/quality/form-checks';
import { analyzeGuessability, getGuessabilitySeverity } from '@/lib/manifold/option-guessability';
import { bulkUpsertQuestions } from '@/lib/db/bulk-upsert';
import { normalizeQuestionNotation } from './normalize-notation';
import { projectCuratedQuestionForBulk } from './seed-projection';

/** Any Prisma-like client that supports raw SQL (works with both PrismaClient and $extends() result). */
type PrismaLike = Parameters<typeof bulkUpsertQuestions>[0];
export {
  projectCuratedQuestionForBulk,
  type CuratedQuestionBulkProjection,
} from './seed-projection';

export async function upsertCuratedQuestionBank(
  prisma: PrismaLike,
  options: {
    dryRun?: boolean;
    batchSize?: number;
    skipQuality?: boolean;
    onProgress?: (completed: number, total: number) => void;
    /** Validated caller-supplied corpus for a deliberately scoped seed. */
    corpus?: LoadedSeedQuestionCorpus;
    /** Scoped seeds must not rewrite the private bank's global exclusion flags. */
    skipExclusionSync?: boolean;
  } = {}
): Promise<{ upserted: number }> {
  const loaded = options.corpus ?? loadSeedQuestionBanksFromDisk();
  if (loaded.errors.length > 0) {
    const message =
      `Question bank validation failed (${loaded.errors.length} issues):\n` +
      loaded.errors.map((e) => `- ${e}`).join('\n');
    throw new Error(message);
  }

  if (loaded.questions.length === 0) return { upserted: 0 };

  const normalizedQuestions = loaded.questions.map(normalizeQuestionNotation);
  const normalizedCount = normalizedQuestions.filter((q, index) => q !== loaded.questions[index]).length;
  if (normalizedCount > 0) {
    console.log(`ℹ️  Normalized notation in ${normalizedCount} question(s) before upsert`);
  }

  // Quality gates — block bad questions before they reach the DB
  // Skippable for external sources (practice KATs) that have known quality issues
  if (options.skipQuality) {
    console.log('⚠️  Skipping quality checks (--skip-quality)\n');
  }

  const qualityErrors: string[] = [];
  const qualityWarnings: string[] = [];

  if (!options.skipQuality) for (const q of normalizedQuestions) {
    // Form opacity (filler text, length variance, absolute terms)
    // Non-blocking: these mechanical checks are low-dimensional and often false-positive
    const opacity = checkFormOpacity(q.options);
    if (opacity.status === 'fail') {
      qualityWarnings.push(`${q.id}: form opacity — ${opacity.issues.join('; ')}`);
    }

    // Guessability (tells that let students guess without knowledge)
    const profile = analyzeGuessability(q.options);
    const severity = getGuessabilitySeverity(profile.score);
    if (severity === 'high' || severity === 'critical') {
      qualityErrors.push(
        `${q.id}: guessability [${severity}] score=${profile.score.toFixed(2)} — ${profile.issues.join('; ')}`
      );
    }
  }

  if (qualityWarnings.length > 0) {
    console.warn(
      `⚠️  ${qualityWarnings.length} form opacity warnings (non-blocking):\n` +
        qualityWarnings.slice(0, 5).map((e) => `  - ${e}`).join('\n') +
        (qualityWarnings.length > 5 ? `\n  ... and ${qualityWarnings.length - 5} more` : '')
    );
  }

  // Length bias — correct answer cannot be longest or shortest
  if (!options.skipQuality) {
    const lengthIssues = checkLengthBias(normalizedQuestions);
    for (const issue of lengthIssues) {
      qualityErrors.push(
        `${issue.id}: correct answer is ${issue.bias} (${issue.correctLen} vs ${issue.bias === 'longest' ? issue.maxOtherLen : issue.minOtherLen} chars, ${issue.pctDiff}% diff)`
      );
    }

    // Format asymmetry — correct answer cannot have unique formatting
    const formatIssues = checkFormatAsymmetry(normalizedQuestions);
    for (const issue of formatIssues) {
      qualityErrors.push(`${issue.id}: ${issue.issue}`);
    }

    // Length bias in each RENDERED subset. checkLengthBias above uses the whole option
    // pool as the denominator, but a question with `combinations` renders a specific
    // 5-option subset per attempt — and a long distractor that is in the pool but NOT in
    // that subset masks the tell at pool level while the student sees it plainly.
    //
    // NON-BLOCKING on purpose: 8 live questions violate this (7 PAAM, 1 critical-care,
    // 0 CAH/PWH as of 2026-07-17), all in finished rotations. Making it throw would
    // block every seed until content nobody is studying gets rebalanced. It warns so new
    // violations are visible; promote it to qualityErrors once the 8 are fixed (or if
    // those rotations come back into scope).
    const comboIssues = checkCombinationLengthBias(normalizedQuestions);
    const comboQuestionIds = new Set(comboIssues.map((i) => i.id));
    for (const issue of comboIssues) {
      qualityWarnings.push(
        `${issue.id}: combination #${issue.comboIndex} renders the correct answer as the ` +
          `${issue.bias} option (${issue.correctLen} vs ${issue.otherLen} chars) — the pool ` +
          `hides this, the student does not`
      );
    }
    if (comboQuestionIds.size > 0) {
      console.warn(
        `⚠️  ${comboIssues.length} rendered-subset length tell(s) across ${comboQuestionIds.size} question(s) (non-blocking)`
      );
    }
  }

  if (qualityErrors.length > 0) {
    throw new Error(
      `Question bank quality check failed (${qualityErrors.length} issues):\n` +
        qualityErrors.map((e) => `- ${e}`).join('\n')
    );
  }

  const dryRun = options.dryRun === true;
  if (dryRun) return { upserted: loaded.questions.length };
  const envBatchSize = Number(process.env.QUESTION_BANK_BATCH_SIZE);
  const resolvedBatchSize =
    options.batchSize ??
    (Number.isFinite(envBatchSize) && envBatchSize > 0 ? Math.floor(envBatchSize) : 25);
  const onProgress = options.onProgress;

  // Transform to bulk upsert format.
  // Keep authored bank difficulty as source of truth so ladder planning remains stable.
  const questionsForBulk = normalizedQuestions.map(projectCuratedQuestionForBulk);

  const upserted = await bulkUpsertQuestions(prisma, questionsForBulk, {
    batchSize: resolvedBatchSize,
    onProgress,
  });

  // Sync exclusion flags from disk → DB
  const exclusions = options.skipExclusionSync
    ? { ids: [] }
    : loadExcludedQuestionIdsFromDisk();
  if (exclusions.ids.length > 0) {
    // Clear all exclusions first, then set the current ones
    await (prisma as { $executeRawUnsafe: (sql: string) => Promise<number> })
      .$executeRawUnsafe(`UPDATE "Question" SET "excluded" = false WHERE "excluded" = true`);
    // Set excluded = true for IDs in exclusion list (batch to avoid query size limits)
    const batchSize = 100;
    for (let i = 0; i < exclusions.ids.length; i += batchSize) {
      const batch = exclusions.ids.slice(i, i + batchSize);
      const placeholders = batch.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
      await (prisma as { $executeRawUnsafe: (sql: string) => Promise<number> })
        .$executeRawUnsafe(`UPDATE "Question" SET "excluded" = true WHERE "id" IN (${placeholders})`);
    }
    console.log(`🚫 Marked ${exclusions.ids.length} questions as excluded`);
  }

  return { upserted };
}
