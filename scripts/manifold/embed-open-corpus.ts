#!/usr/bin/env tsx
/**
 * embed-open-corpus — populate the manifold for a self-hosted install.
 *
 * The public distribution shipped the manifold (scoring, gap analysis, cluster
 * assignment) and a schema with embedding columns, but nothing that could fill
 * them. So a self-hoster got the scheduler with an empty vector space, and the
 * one capability the project is actually about — concept-level scheduling by
 * walking toward the exam gap — was not reproducible from the open artifact.
 *
 * Deliberately TEXT ONLY. The internal embedder also handles video, which pulls
 * in R2 storage configuration and a dormant private feature; neither belongs in
 * a public artifact. Cards, questions and concepts are what the manifold needs.
 *
 *   GEMINI_API_KEY=... DATABASE_URL=... npm run manifold:embed:open -- --type cards
 *   ... --type cards --limit 100      # a cheap first run
 *   ... --dry-run                     # count what would be embedded, spend nothing
 *
 * Embeddings cost money per item. Nothing here runs implicitly: no default
 * "embed everything", and --dry-run reports the bill before you pay it.
 */
import { genAI, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../lib/gemini';
import { prisma } from '../lib/db';

type Target = 'cards' | 'questions' | 'concepts';
const ALL_TARGETS: Target[] = ['cards', 'questions', 'concepts'];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = arg('--limit') ? Math.max(1, parseInt(arg('--limit')!, 10)) : Infinity;
const BATCH = 32;

function parseTargets(): Target[] {
  const raw = arg('--type');
  if (!raw || raw === 'all') return ALL_TARGETS;
  const picked = raw.split(',').map((t) => t.trim()) as Target[];
  const bad = picked.filter((t) => !ALL_TARGETS.includes(t));
  if (bad.length) throw new Error(`unknown --type: ${bad.join(', ')}`);
  return picked;
}

/** One embedding request. Kept tiny so a caller can swap the provider. */
async function embed(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const res = await model.embedContent(text);
  const values = res.embedding?.values ?? [];
  if (values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`expected ${EMBEDDING_DIMENSIONS} dims, got ${values.length}`);
  }
  return values;
}

/**
 * pgvector columns are not in the Prisma client's type surface, so the write is
 * raw. `::halfvec` must match the column type or Postgres rejects the update —
 * which is the behaviour we want over a silent no-op.
 */
async function writeEmbedding(table: string, id: string, vector: number[]): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "${table}" SET "embedding" = $1::halfvec WHERE "id" = $2`,
    `[${vector.join(',')}]`,
    id,
  );
}

const SOURCES: Record<Target, { table: string; text: (r: Record<string, string | null>) => string }> = {
  cards: { table: 'Card', text: (r) => [r.front, r.back, r.context].filter(Boolean).join(' ') },
  questions: { table: 'Question', text: (r) => [r.stem, r.explanation].filter(Boolean).join(' ') },
  concepts: { table: 'Concept', text: (r) => [r.name, r.description].filter(Boolean).join(' ') },
};

async function pending(target: Target): Promise<Array<Record<string, string | null>>> {
  const { table } = SOURCES[target];
  const cols = target === 'cards'
    ? '"id", "front", "back", "context"'
    : target === 'questions'
      ? '"id", "stem", "explanation"'
      : '"id", "name", "description"';
  const deleted = target === 'cards' ? 'AND "deletedAt" IS NULL' : '';
  return prisma.$queryRawUnsafe(
    `SELECT ${cols} FROM "${table}" WHERE "embedding" IS NULL ${deleted} ORDER BY "id" LIMIT ${
      LIMIT === Infinity ? 100000 : LIMIT
    }`,
  );
}

async function main(): Promise<void> {
  const targets = parseTargets();
  let embedded = 0;
  let failed = 0;

  for (const target of targets) {
    const rows = await pending(target);
    console.log(`${target}: ${rows.length} without an embedding`);
    if (DRY_RUN || rows.length === 0) continue;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await Promise.all(batch.map(async (row) => {
        const text = SOURCES[target].text(row).trim();
        // An item with no text cannot be embedded meaningfully. Skip it rather
        // than storing a vector for the empty string, which would place it at a
        // fixed point in the space and quietly pollute every nearest-neighbour
        // query that follows.
        if (!text) return;
        try {
          await writeEmbedding(SOURCES[target].table, row.id as string, await embed(text));
          embedded += 1;
        } catch (error) {
          failed += 1;
          console.warn(`  ${target} ${row.id}: ${(error as Error).message}`);
        }
      }));
      process.stdout.write(`\r  ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
    process.stdout.write('\n');
  }

  console.log(
    DRY_RUN
      ? '\ndry run — nothing embedded, nothing charged.'
      : `\nembedded ${embedded}${failed ? `, ${failed} failed` : ''}.`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
