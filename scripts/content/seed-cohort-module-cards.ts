/**
 * Seed only the Cohort module CARDS (open-content/modules/cards/), the mirrored
 * rights-clean md3 cards cohort.md serves as its own `cohort-open` rows.
 *
 *   npm run db:seed:cohort-module-cards -- --dry-run   # validate, no writes
 *   npm run db:seed:cohort-module-cards                # upsert + soft-delete stale module cards
 *
 * The card twin of `db:seed:cohort-modules`. It never reads content/ or the
 * private question-bank, needs no embeddings, and its stale sweep only ever
 * sees `cohort-open` rows in the `cohort:` stableId namespace.
 */
import { loadCohortModuleCardsFromDisk } from '../../src/lib/content/cohort-card-corpus';
import { loadSeedOpenCorpusEnvironment, parseSeedOpenCorpusArgs } from '../usmle/seed-open-corpus';
import { seedCohortCardsAtomically, type CohortCardSeedHost } from './cohort-card-seed';

const LABEL = 'cohort:seed-module-cards';

async function main(): Promise<void> {
  const { dryRun } = parseSeedOpenCorpusArgs(process.argv.slice(2));
  const loaded = loadCohortModuleCardsFromDisk();
  if (loaded.errors.length > 0) {
    throw new Error(
      `Cohort module cards failed their gate (${loaded.errors.length} issue(s)):\n`
      + loaded.errors.slice(0, 50).map((error) => `- ${error}`).join('\n'),
    );
  }
  if (loaded.cards.length === 0) throw new Error('Cohort module cards are empty; refusing to seed.');

  if (dryRun) {
    const byDiscipline = new Map<string, number>();
    for (const { card } of loaded.cards) byDiscipline.set(card.discipline, (byDiscipline.get(card.discipline) ?? 0) + 1);
    console.log(`[${LABEL}] validated ${loaded.cards.length} module card(s) in ${loaded.files.length - 1} file(s); no database writes.`);
    for (const [d, n] of [...byDiscipline].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${d}`);
    return;
  }

  loadSeedOpenCorpusEnvironment();
  const { prisma } = await import('../../src/lib/prisma');
  try {
    const result = await seedCohortCardsAtomically(prisma as unknown as CohortCardSeedHost, loaded, { label: LABEL });
    console.log(`[${LABEL}] upserted ${result.upserted} card(s); retired ${result.retired} stale module card(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[${LABEL}] Fatal error:`, error);
  process.exitCode = 1;
});
