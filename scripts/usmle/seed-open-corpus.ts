/**
 * Seed only the repo-native open Step 1 corpus.
 *
 * Unlike the full application seed, this command never consults the private
 * `question-bank` symlink and never rewrites private exclusion state. It exists
 * so a clean FOSS checkout can load the redistributable corpus independently.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import {
  loadOpenUsmleQuestionBankFromDisk,
  type LoadedSeedQuestionCorpus,
} from '../../src/lib/question-bank/load-seed-corpus';
import { upsertCuratedQuestionBank } from '../../src/lib/question-bank/seed';
import { runPublicUsmleAudit } from '../audit/usmle-public-corpus';

export interface SeedOpenCorpusArgs {
  dryRun: boolean;
}

/** Reject typos so an intended dry run can never fall through to live writes. */
export function parseSeedOpenCorpusArgs(argv: string[]): SeedOpenCorpusArgs {
  const args: SeedOpenCorpusArgs = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

/**
 * Load operator configuration with the same precedence as the other public DB
 * commands: explicit shell variables, then `.env.local`, then `.env`.
 */
export function loadSeedOpenCorpusEnvironment(
  cwd = process.cwd(),
  target: NodeJS.ProcessEnv = process.env,
): void {
  dotenv.config({
    path: path.resolve(cwd, '.env.local'),
    processEnv: target,
    quiet: true,
  });
  dotenv.config({
    path: path.resolve(cwd, '.env'),
    processEnv: target,
    quiet: true,
  });
}

export interface OpenCorpusSeedTransactionClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  question: {
    findMany(args: {
      where: {
        source: 'bank';
        sourceFile: { startsWith: string };
      };
      select: { id: true; contentState: true };
    }): Promise<Array<{ id: string; contentState: string }>>;
    updateMany(args: {
      where: { id: { in: string[] } };
      data: { contentState: 'retired' };
    }): Promise<{ count: number }>;
  };
}

export interface OpenCorpusSeedTransactionHost {
  $transaction<T>(
    operation: (transaction: OpenCorpusSeedTransactionClient) => Promise<T>,
  ): Promise<T>;
}

type OpenCorpusUpsert = (
  client: OpenCorpusSeedTransactionClient,
  options: Parameters<typeof upsertCuratedQuestionBank>[1],
) => Promise<{ upserted: number }>;

export interface SeedOpenCorpusResult {
  upserted: number;
  retired: number;
}

/**
 * Seed and retire the scoped open corpus as one all-or-nothing change.
 *
 * The stale-set guard runs before the first mutation. The bulk helper receives
 * the interactive transaction client, so each raw-SQL batch and the final
 * retirement participate in the same transaction instead of batch-committing
 * independently.
 */
export async function seedOpenCorpusAtomically(
  client: OpenCorpusSeedTransactionHost,
  corpus: LoadedSeedQuestionCorpus,
  options: { upsert?: OpenCorpusUpsert } = {},
): Promise<SeedOpenCorpusResult> {
  const currentIds = new Set(corpus.questions.map((question) => question.id));
  const upsert = options.upsert ?? upsertCuratedQuestionBank;

  return client.$transaction(async (transaction) => {
    const existing = await transaction.question.findMany({
      where: {
        source: 'bank',
        sourceFile: { startsWith: 'open-content/usmle/step1/' },
      },
      select: { id: true, contentState: true },
    });
    const staleIds = existing
      .filter((question) => !currentIds.has(question.id) && question.contentState !== 'retired')
      .map((question) => question.id);
    const liveCount = existing.filter((question) => question.contentState !== 'retired').length;
    if (liveCount > 0 && staleIds.length / liveCount > 0.5) {
      throw new Error(
        `[usmle:seed-open] Refusing to retire ${staleIds.length}/${liveCount} open rows in one run.`,
      );
    }

    const result = await upsert(transaction, {
      corpus,
      skipExclusionSync: true,
    });
    if (staleIds.length > 0) {
      await transaction.question.updateMany({
        where: { id: { in: staleIds } },
        data: { contentState: 'retired' },
      });
    }

    return { upserted: result.upserted, retired: staleIds.length };
  });
}

async function main(): Promise<void> {
  const { dryRun } = parseSeedOpenCorpusArgs(process.argv.slice(2));
  const releaseGate = runPublicUsmleAudit(
    ['--release-gate', '--min-eligible=25'],
    { silent: true },
  );
  if (releaseGate.releaseFailures.length > 0) {
    throw new Error(
      `Open USMLE release gate failed (${releaseGate.releaseFailures.length} issue(s)):\n`
      + releaseGate.releaseFailures.map((failure) => `- ${failure}`).join('\n'),
    );
  }
  const loaded = loadOpenUsmleQuestionBankFromDisk();
  if (loaded.errors.length > 0) {
    throw new Error(
      `Open USMLE corpus validation failed (${loaded.errors.length} issues):\n`
      + loaded.errors.map((error) => `- ${error}`).join('\n'),
    );
  }

  if (dryRun) {
    const result = await upsertCuratedQuestionBank({} as never, {
      dryRun: true,
      corpus: loaded,
      skipExclusionSync: true,
    });
    console.log(
      `[usmle:seed-open] Release gate ${releaseGate.report.summary.eligibleCount}/`
      + `${releaseGate.report.summary.auditedQuestionCount}; validated ${result.upserted} question(s); `
      + 'no database writes.',
    );
    return;
  }

  loadSeedOpenCorpusEnvironment();
  const { prisma } = await import('../../src/lib/prisma');
  try {
    const result = await seedOpenCorpusAtomically(
      prisma as unknown as OpenCorpusSeedTransactionHost,
      loaded,
    );

    console.log(
      `[usmle:seed-open] Upserted ${result.upserted} question(s); retired ${result.retired} stale open row(s).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[usmle:seed-open] Fatal error:', error);
      process.exitCode = 1;
    });
}
