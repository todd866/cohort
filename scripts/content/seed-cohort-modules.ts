/**
 * Seed only the Cohort module bank (open-content/modules/), the mirrored
 * rights-clean md3 questions cohort.md serves as its own `cohort-open` rows.
 *
 *   npm run db:seed:cohort-modules -- --dry-run   # validate, no writes
 *   npm run db:seed:cohort-modules                # upsert + retire stale module rows
 *
 * The scoped twin of `db:seed:usmle-open`. The full `db:seed` seeds the same
 * files (the module bank is a root of loadSeedQuestionBanksFromDisk); this one
 * exists so a clean Cohort checkout, or a thin link, can load just them. It
 * never reads the private question-bank, and its stale sweep only ever sees
 * rows under open-content/modules/questions/.
 */
import { loadCohortModuleQuestionBankFromDisk } from '../../src/lib/question-bank/load-seed-corpus';
import { upsertCuratedQuestionBank } from '../../src/lib/question-bank/seed';
import {
  loadSeedOpenCorpusEnvironment,
  parseSeedOpenCorpusArgs,
  seedOpenCorpusAtomically,
  type OpenCorpusSeedTransactionHost,
} from '../usmle/seed-open-corpus';

const LABEL = 'cohort:seed-modules';

async function main(): Promise<void> {
  const { dryRun } = parseSeedOpenCorpusArgs(process.argv.slice(2));
  const loaded = loadCohortModuleQuestionBankFromDisk();
  if (loaded.errors.length > 0) {
    throw new Error(
      `Cohort module bank failed its gate (${loaded.errors.length} issue(s)):\n`
      + loaded.errors.map((error) => `- ${error}`).join('\n'),
    );
  }
  if (loaded.questions.length === 0) throw new Error('Cohort module bank is empty; refusing to seed.');

  if (dryRun) {
    const result = await upsertCuratedQuestionBank({} as never, {
      dryRun: true,
      corpus: loaded,
      skipExclusionSync: true,
    });
    console.log(`[${LABEL}] validated ${result.upserted} module question(s); no database writes.`);
    return;
  }

  loadSeedOpenCorpusEnvironment();
  const { prisma } = await import('../../src/lib/prisma');
  try {
    const result = await seedOpenCorpusAtomically(
      prisma as unknown as OpenCorpusSeedTransactionHost,
      loaded,
      { sourceFilePrefix: 'open-content/modules/questions/', label: LABEL },
    );
    console.log(`[${LABEL}] upserted ${result.upserted} question(s); retired ${result.retired} stale module row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[${LABEL}] Fatal error:`, error);
  process.exitCode = 1;
});
