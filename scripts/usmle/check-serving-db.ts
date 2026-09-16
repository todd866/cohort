#!/usr/bin/env node
/**
 * Read-only production preflight for the public Step 1 serving database.
 *
 * Source eligibility is necessary but insufficient: a deployment must also
 * prove that the rows its server will read are the exact checked-in release.
 * This command performs no seed, update, or other database mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import type { Prisma } from '@prisma/client';
import type { PublicUsmleStoredQuestion } from '../../src/lib/usmle/public-serving-drift';
import {
  resolveDatabaseTarget,
  type DatabaseTargetName,
} from '../../src/lib/database-target';

interface Args {
  json: boolean;
  out: string | null;
}

export type ServingDatabaseTarget = DatabaseTargetName;

/**
 * Name the selected database without exposing its URL. An empty
 * DATABASE_URL_LOCAL intentionally selects the configured DATABASE_URL.
 */
export function servingDatabaseTarget(
  env: { DATABASE_URL_LOCAL?: string } = process.env,
): ServingDatabaseTarget {
  return resolveDatabaseTarget(env).name;
}

export function parseServingDbPreflightArgs(argv: string[]): Args {
  const args: Args = { json: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--out') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--out requires a value');
      args.out = value;
      index += 1;
    } else if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (!value) throw new Error('--out requires a value');
      args.out = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

/**
 * Fetch every expected row, even when revoked, plus any other currently
 * servable row owned by the repo-native open corpus. The second branch makes
 * `unexpectedIds` observable without treating intentionally retired history as
 * a release blocker.
 */
export function publicUsmleServingDbWhere(
  expectedIds: string[],
): Prisma.QuestionWhereInput {
  return {
    OR: [
      { id: { in: expectedIds } },
      {
        source: 'bank',
        sourceFile: { startsWith: 'open-content/usmle/step1/' },
        moduleNodes: { has: 'usmle/step1' },
        excluded: false,
        contentState: { in: ['validated', 'enhanced', 'cited', 'production'] },
      },
    ],
  };
}

async function main(): Promise<void> {
  const args = parseServingDbPreflightArgs(process.argv.slice(2));
  dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });
  const databaseTarget = servingDatabaseTarget();

  const [
    { loadOpenUsmleQuestionBankFromDisk },
    { buildPublicUsmleServingDriftReport, publicUsmleServingDriftFailures },
  ] = await Promise.all([
    import('../../src/lib/question-bank/load-seed-corpus'),
    import('../../src/lib/usmle/public-serving-drift'),
  ]);

  const source = loadOpenUsmleQuestionBankFromDisk();
  if (source.errors.length > 0) {
    throw new Error(
      `Open USMLE source validation failed (${source.errors.length} issue(s)):\n`
      + source.errors.map((error) => `- ${error}`).join('\n'),
    );
  }
  const sourceRegistryReceipt = JSON.parse(fs.readFileSync(
    path.resolve(process.cwd(), 'open-content/usmle/step1/sources.json'),
    'utf8',
  )) as { verifiedAt: string; quoteSetSha256: string; registrySha256: string };

  const { prisma } = await import('../../src/lib/prisma');
  try {
    const expectedIds = source.questions.map((question) => question.id).sort();
    const databaseQuestions = await prisma.question.findMany({
      where: publicUsmleServingDbWhere(expectedIds),
      select: {
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
      },
      orderBy: { id: 'asc' },
    });
    const drift = buildPublicUsmleServingDriftReport(
      source.questions,
      databaseQuestions satisfies PublicUsmleStoredQuestion[],
    );

    const report = {
      schemaVersion: 1 as const,
      basis: 'checked-in-source-vs-serving-database' as const,
      databaseTarget,
      sourceRegistry: {
        path: 'open-content/usmle/step1/sources.json',
        verifiedAt: sourceRegistryReceipt.verifiedAt,
        quoteSetSha256: sourceRegistryReceipt.quoteSetSha256,
        registrySha256: sourceRegistryReceipt.registrySha256,
      },
      drift,
      servingProjection: {
        eligibleCount: drift.matchingCount,
        requiredCount: drift.expectedCount,
      },
    };
    const failures = publicUsmleServingDriftFailures(drift);

    if (args.json) {
      console.log(JSON.stringify({ ...report, failures }));
    } else {
      console.log(
        `USMLE serving DB preflight [${databaseTarget}]: `
        + `${drift.matchingCount}/${drift.expectedCount} source rows match; `
        + `${drift.matchingCount}/${drift.expectedCount} serving projection eligible`,
      );
      for (const failure of failures) console.error(`serving DB preflight: ${failure}`);
    }
    if (args.out) {
      const outPath = path.resolve(process.cwd(), args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify({ ...report, failures }, null, 2)}\n`);
    }
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
