/**
 * Build-time script: generates static content-map artifacts from the database.
 *
 * Artifacts:
 * - content-map-types.ts (shared StaticCard/StaticQuestion interfaces)
 * - content-map-rotations/*.ts (per-rotation card/question shards)
 * - content-map-rotations/index.ts (lazy loader registry)
 * - rotation-counts.ts (tiny client-safe counts)
 *
 * Usage: npx tsx scripts/generate-content-map.ts
 * Runs automatically before `next dev` and `next build`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unreachableRotations } from '../../src/lib/institution-rotations';
import { withoutRawPublicUsmleQuestions } from '../../src/lib/usmle/raw-question-boundary';
import { withoutRawPublicUsmleReinforcementCards } from '../../src/lib/usmle/raw-reinforcement-card-boundary';

const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, 'src', 'lib', 'generated');
const LEGACY_MONOLITH_FILE = path.join(OUTPUT_DIR, 'content-map.ts');
const CONTENT_MAP_TYPES_FILE = path.join(OUTPUT_DIR, 'content-map-types.ts');
const ROTATION_COUNTS_FILE = path.join(OUTPUT_DIR, 'rotation-counts.ts');
const ROTATION_MAP_DIR = path.join(OUTPUT_DIR, 'content-map-rotations');
const ROTATION_MAP_INDEX_FILE = path.join(ROTATION_MAP_DIR, 'index.ts');

export type GeneratedContentModeName = 'database' | 'offline' | 'release';

export interface GeneratedContentMode {
  name: GeneratedContentModeName;
  readDatabase: boolean;
  failOnDatabaseError: boolean;
  requireData: boolean;
  generatedAt: string | null;
}

const OFFLINE_GENERATED_AT = '1970-01-01T00:00:00.000Z';

/**
 * Resolve the shared build intent for every database-derived source module.
 *
 * Direct generator invocations retain their historical behavior when the new
 * mode is absent. Package/CI/deploy entrypoints set an explicit mode so a code
 * build can never accidentally depend on Neon and a release can never inherit
 * the legacy permissive fallback.
 */
export function resolveGeneratedContentMode(
  env: Record<string, string | undefined> = process.env,
  options: { legacyContentMapFlags?: boolean } = {},
): GeneratedContentMode {
  const requested = env.MD3_GENERATED_CONTENT_MODE;

  if (requested === 'offline') {
    return {
      name: 'offline',
      readDatabase: false,
      failOnDatabaseError: false,
      requireData: false,
      generatedAt: OFFLINE_GENERATED_AT,
    };
  }

  if (requested === 'release') {
    return {
      name: 'release',
      readDatabase: true,
      failOnDatabaseError: true,
      requireData: true,
      generatedAt: null,
    };
  }

  if (requested !== undefined && requested !== '' && requested !== 'database') {
    throw new Error(
      `[generated-content] Invalid MD3_GENERATED_CONTENT_MODE=${JSON.stringify(requested)}. ` +
        'Expected "offline", "database", or "release".',
    );
  }

  return {
    name: 'database',
    readDatabase: true,
    failOnDatabaseError:
      options.legacyContentMapFlags !== false && env.CONTENT_MAP_STRICT === '1',
    requireData:
      options.legacyContentMapFlags !== false && env.CONTENT_MAP_REQUIRE_DATA === '1',
    generatedAt: null,
  };
}

export function assertGeneratedContentIsUsable(
  mode: GeneratedContentMode,
  label: string,
  itemCount: number,
): void {
  if (mode.requireData && itemCount === 0) {
    throw new Error(
      `[generated-content] ${mode.name} mode requires non-empty ${label}; received 0 items.`,
    );
  }
}

/**
 * Existing generated shards are untrusted after a database read fails: they
 * may predate a routing/content-membership change and still contain raw answer
 * keys. Release builds abort; permissive local builds rewrite deterministic
 * empty artifacts instead of retaining stale answer-bearing output.
 */
export function contentMapDatabaseFailureAction(
  mode: GeneratedContentMode,
): 'throw' | 'write-empty' {
  return mode.failOnDatabaseError ? 'throw' : 'write-empty';
}

/**
 * Rotations that are abandoned and must NOT be exported in the generated
 * content map. These were cut on 2026-05-15 — zero LearningEvent rows ever,
 * so no user has ever reviewed a card or answered a question from them.
 * "Cut by usage, not caution" (feedback_cut_by_usage_not_caution memo).
 * Card + Question rows for these rotations were deleted from the DB in the
 * same change; this list stays so a future re-import to the same name
 * doesn't accidentally repopulate the generated map.
 */
const DEPRECATED_ROTATIONS = [
  // Notre Dame Fremantle pilot (project_usyd_first)
  'undf-general', 'undf-cardiology', 'undf-endocrine', 'undf-gastro',
  'undf-haem', 'undf-infectious', 'undf-neuro', 'undf-obgyn',
  'undf-pharmacology', 'undf-psych', 'undf-psychiatry', 'undf-renal',
  'undf-respiratory',
  // MD1 textbook auto-imports — never integrated into review flow
  'md1-cardiovascular', 'md1-endocrine', 'md1-gi', 'md1-msk', 'md1-neuro',
  'md1-renal', 'md1-respiratory',
  // Legacy MD1 anatomy/general — abandoned
  'usyd-md1', 'usyd-md1-anatomy',
  // GSSE specialty-exam deck — outside the supported product scope
  'gsse',
  // Year 1/2 textbook block extracts — never reviewed; year1-kat1/kat2 carry
  // the actual Year 1 content
  'year1-b1-foundations', 'year1-b2-msk', 'year1-b3-respiratory',
  'year1-b4-cardiovascular', 'year1-b5-renal', 'year1-b6-endocrinology',
  'year1-b7-gastroenterology', 'year1-b8-neurosciences',
  'year2-b1-gel1', 'year2-b2-trcp', 'year2-b3-oncology', 'year2-b4-haematology',
  'year2-b5-gel2',
  // Year 2 KAT papers — usage went to year1-kat* / KAT3 instead
  'year2-kat5', 'year2-kat6', 'year2-kat7', 'year2-kat8',
  // Year 1 AHCT — abandoned
  'year1-ahct1', 'year1-ahct2', 'year1-ahct3', 'year1-ahct4',
  // Catch-all / one-off / misnamed
  'year2', 'year1-kat4', 'year3-common', 'kat-practice',
  'kat1', 'kat5', 'kat7',
  'anatomy', 'pathology', 'physiology',
  'block-7-gastroenterology', '3-respiratory', 'mmca-1-blocks-1-4',
  'unknown',
  // clinical-skills was a placeholder rotation for the MMCA practice paper —
  // 32 questions, zero events, no UI route. Cut.
  'clinical-skills',
];

// Rotations that are LIVE but must NOT be inlined into the static content-map.
// `anking` is the 28k-card AnKing Step import — inlining it would produce a
// ~170 MB shard (each card ≈ 6 KB; critical-care's 2,126 cards are already 13 MB)
// that breaks both the build and per-session memory. It is served exclusively via
// the DB-bounded manifold/bulk-candidates path (getRotationContent returns empty
// for it, which is correct — the scheduler fetches anking candidates from pgvector,
// never the full card list). Reachability is still asserted via ALL_ROTATIONS.
const NON_INLINED_ROTATIONS = ['anking'];
const EXCLUDED_FROM_MAP = [...DEPRECATED_ROTATIONS, ...NON_INLINED_ROTATIONS];

interface StaticCard {
  id: string;
  front: unknown;
  back: unknown;
  backs: unknown;
  context: unknown;
  imageUrl: unknown;
  imageCaption: unknown;
  imageRole: unknown;
  sourceComponent: unknown;
  rotation: string;
  week: unknown;
  clusterId: unknown;
  complexity: unknown;
  crosslinks: unknown;
  cardType: unknown;
  topics: unknown;
  difficulty: unknown;
  variantGroupId: unknown;
  variantIndex: unknown;
  variantType: unknown;
}

interface StaticQuestion {
  id: string;
  stem: unknown;
  options: unknown;
  context: unknown;
  imageUrl: unknown;
  imageCaption: unknown;
  rotation: string;
  moduleNodes: unknown;
  week: unknown;
  topics: unknown;
  difficulty: unknown;
  combinations: unknown;
  correctVariants: unknown;
}

export function toRotationSlug(rotation: string): string {
  return rotation.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

export function buildRotationSlugMap(rotations: readonly string[]): Map<string, string> {
  const usedSlugs = new Set<string>();
  const rotationToSlug = new Map<string, string>();

  for (const rotation of rotations) {
    const slug = toRotationSlug(rotation);
    if (usedSlugs.has(slug)) {
      throw new Error(
        `[generate-content-map] Rotation slug collision for "${rotation}" -> "${slug}".`
      );
    }
    usedSlugs.add(slug);
    rotationToSlug.set(rotation, slug);
  }

  return rotationToSlug;
}

async function main() {
  const mode = resolveGeneratedContentMode();
  const generatedAt = mode.generatedAt ?? new Date().toISOString();
  let cards: StaticCard[] = [];
  let questions: StaticQuestion[] = [];
  let fetchError: Error | null = null;

  if (mode.readDatabase) {
    try {
      const { prisma } = await import('../lib/db');
      const { filterDeliverableReinforcementCardRows } = await import(
        '../../src/lib/usmle/reinforcement-card-delivery'
      );
      try {
        [cards, questions] = await Promise.all([
          prisma.card.findMany({
            where: withoutRawPublicUsmleReinforcementCards({
              deletedAt: null,
              rotation: { notIn: EXCLUDED_FROM_MAP },
            }),
            select: {
              id: true,
              front: true,
              back: true,
              backs: true,
              context: true,
              imageUrl: true,
              imageCaption: true,
              imageRole: true,
              sourceComponent: true,
              rotation: true,
              week: true,
              clusterId: true,
              complexity: true,
              crosslinks: true,
              cardType: true,
              topics: true,
              difficulty: true,
              variantGroupId: true,
              variantIndex: true,
              variantType: true,
            },
          }),
          prisma.question.findMany({
            where: withoutRawPublicUsmleQuestions({
              excluded: false,
              rotation: { notIn: EXCLUDED_FROM_MAP },
            }),
            select: {
              id: true,
              stem: true,
              options: true,
              context: true,
              imageUrl: true,
              imageCaption: true,
              rotation: true,
              moduleNodes: true,
              week: true,
              topics: true,
              difficulty: true,
              combinations: true,
              correctVariants: true,
            },
          }),
        ]);
        cards = await filterDeliverableReinforcementCardRows(cards, {
          client: prisma,
          logContext: { transport: 'generated-content-map' },
        });
      } finally {
        await prisma.$disconnect();
      }
    } catch (err) {
      fetchError = err as Error;
    }
  } else {
    console.log('[generate-content-map] Offline mode: writing deterministic compile-only artifacts.');
  }

  if (fetchError) {
    const errorMessage = `[generate-content-map] Could not connect to database. Error: ${fetchError.message}`;

    if (contentMapDatabaseFailureAction(mode) === 'throw') {
      throw new Error(
        `${errorMessage}\n[generate-content-map] ${mode.name} mode is fail-closed; aborting.`,
      );
    }

    console.warn(
      `${errorMessage}\n[generate-content-map] Rewriting empty artifacts; stale generated questions are never retained.`
    );
  }

  assertGeneratedContentIsUsable(mode, 'content map', cards.length + questions.length);

  const normalizedCards = cards.map((card) => ({
    id: card.id,
    front: card.front,
    back: card.back,
    backs: card.backs ?? null,
    context: card.context ?? null,
    imageUrl: card.imageUrl ?? null,
    imageCaption: card.imageCaption ?? null,
    imageRole: card.imageRole ?? null,
    sourceComponent: card.sourceComponent,
    rotation: card.rotation,
    week: card.week,
    clusterId: card.clusterId ?? null,
    complexity: card.complexity,
    crosslinks: card.crosslinks ?? null,
    cardType: card.cardType,
    topics: card.topics ?? [],
    difficulty: card.difficulty,
    variantGroupId: card.variantGroupId ?? null,
    variantIndex: card.variantIndex ?? null,
    variantType: card.variantType ?? null,
  }));

  const normalizedQuestions = questions.map((question) => ({
    id: question.id,
    stem: question.stem,
    options: question.options,
    context: question.context ?? null,
    imageUrl: question.imageUrl ?? null,
    imageCaption: question.imageCaption ?? null,
    rotation: question.rotation,
    moduleNodes: question.moduleNodes ?? [],
    week: question.week ?? null,
    topics: question.topics ?? [],
    difficulty: question.difficulty,
    combinations: question.combinations ?? null,
    correctVariants: question.correctVariants ?? null,
  }));

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  // --- Shared type definitions ---
  const typeLines: string[] = [];
  typeLines.push('/*');
  typeLines.push(' * AUTO-GENERATED FILE — DO NOT EDIT');
  typeLines.push(' *');
  typeLines.push(' * Generated by: scripts/generate-content-map.ts');
  typeLines.push(` * Generated at: ${generatedAt}`);
  typeLines.push(` * Build mode: ${mode.name}`);
  typeLines.push(' */');
  typeLines.push('');
  typeLines.push('export interface StaticCard {');
  typeLines.push('  id: string;');
  typeLines.push('  front: string;');
  typeLines.push('  back: string;');
  typeLines.push('  backs: string[] | null;');
  typeLines.push('  context: string | null;');
  typeLines.push('  imageUrl: string | null;');
  typeLines.push('  imageCaption: string | null;');
  typeLines.push('  imageRole: string | null;');
  typeLines.push('  sourceComponent: string;');
  typeLines.push('  rotation: string;');
  typeLines.push('  week: number | null;');
  typeLines.push('  clusterId: string | null;');
  typeLines.push('  complexity: number;');
  typeLines.push('  crosslinks: unknown;');
  typeLines.push('  cardType: string;');
  typeLines.push('  topics: string[];');
  typeLines.push('  difficulty: string;');
  typeLines.push('  variantGroupId: string | null;');
  typeLines.push('  variantIndex: number | null;');
  typeLines.push('  variantType: string | null;');
  typeLines.push('}');
  typeLines.push('');
  typeLines.push('export interface StaticQuestion {');
  typeLines.push('  id: string;');
  typeLines.push('  stem: string;');
  typeLines.push('  options: unknown;');
  typeLines.push('  context: string | null;');
  typeLines.push('  imageUrl: string | null;');
  typeLines.push('  imageCaption: string | null;');
  typeLines.push('  rotation: string;');
  typeLines.push('  moduleNodes: string[];');
  typeLines.push('  week: number | null;');
  typeLines.push('  topics: string[];');
  typeLines.push('  difficulty: string;');
  typeLines.push('  combinations: unknown;');
  typeLines.push('  correctVariants: unknown;');
  typeLines.push('}');
  typeLines.push('');

  await fs.writeFile(CONTENT_MAP_TYPES_FILE, typeLines.join('\n'), 'utf8');
  console.log(`[generate-content-map] Wrote shared types → ${path.relative(ROOT, CONTENT_MAP_TYPES_FILE)}`);

  // --- Per-rotation shards + dynamic loader index ---
  const rotationSet = new Set<string>([
    ...normalizedCards.map((card) => card.rotation),
    ...normalizedQuestions.map((question) => question.rotation),
  ]);
  const rotations = [...rotationSet].sort((a, b) => a.localeCompare(b));

  // Reachability guard (audit 2.5): every content-bearing rotation must appear
  // in ≥1 ALL_ROTATIONS institution list, either as a scheduled rotation or an
  // explicit-focus deck. Fail the build on divergence rather than ship content
  // that no institution can select (year1-kat2/kat3 previously did).
  const unreachable = unreachableRotations(rotations);
  if (unreachable.length > 0) {
    throw new Error(
      `[generate-content-map] ${unreachable.length} rotation(s) have content but appear in NO ALL_ROTATIONS ` +
        `institution list (unreachable in every feed): ${unreachable.join(', ')}. ` +
        `Add each to the right institution in src/lib/institution-rotations.ts.`,
    );
  }

  const rotationToSlug = buildRotationSlugMap(rotations);

  await fs.rm(ROTATION_MAP_DIR, { recursive: true, force: true });
  await fs.mkdir(ROTATION_MAP_DIR, { recursive: true });

  for (const rotation of rotations) {
    const slug = rotationToSlug.get(rotation)!;
    const rotationCards = normalizedCards.filter((card) => card.rotation === rotation);
    const rotationQuestions = normalizedQuestions.filter((question) => question.rotation === rotation);

    const shardLines: string[] = [];
    shardLines.push('/*');
    shardLines.push(' * AUTO-GENERATED FILE — DO NOT EDIT');
    shardLines.push(' *');
    shardLines.push(' * Generated by: scripts/generate-content-map.ts');
    shardLines.push(` * Rotation: ${rotation}`);
    shardLines.push(` * Cards: ${rotationCards.length} | Questions: ${rotationQuestions.length}`);
    shardLines.push(' */');
    shardLines.push('');
    shardLines.push("import type { StaticCard, StaticQuestion } from '../content-map-types';");
    shardLines.push('');
    shardLines.push('export const CARDS: Record<string, StaticCard> = {');
    for (const card of rotationCards) {
      shardLines.push(`  ${JSON.stringify(card.id)}: ${JSON.stringify(card)},`);
    }
    shardLines.push('};');
    shardLines.push('');
    shardLines.push('export const QUESTIONS: Record<string, StaticQuestion> = {');
    for (const question of rotationQuestions) {
      shardLines.push(`  ${JSON.stringify(question.id)}: ${JSON.stringify(question)},`);
    }
    shardLines.push('};');
    shardLines.push('');

    await fs.writeFile(path.join(ROTATION_MAP_DIR, `${slug}.ts`), shardLines.join('\n'), 'utf8');
  }

  const indexLines: string[] = [];
  indexLines.push('/*');
  indexLines.push(' * AUTO-GENERATED FILE — DO NOT EDIT');
  indexLines.push(' *');
  indexLines.push(' * Generated by: scripts/generate-content-map.ts');
  indexLines.push(` * Generated at: ${generatedAt}`);
  indexLines.push(` * Build mode: ${mode.name}`);
  indexLines.push(' */');
  indexLines.push('');
  indexLines.push("import type { StaticCard, StaticQuestion } from '../content-map-types';");
  indexLines.push('');
  indexLines.push('export interface RotationContentMap {');
  indexLines.push('  cards: Record<string, StaticCard>;');
  indexLines.push('  questions: Record<string, StaticQuestion>;');
  indexLines.push('}');
  indexLines.push('');
  indexLines.push('export const ROTATION_CONTENT_LOADERS: Record<string, () => Promise<RotationContentMap>> = {');
  for (const rotation of rotations) {
    const slug = rotationToSlug.get(rotation)!;
    indexLines.push(
      `  ${JSON.stringify(rotation)}: () => import('./${slug}').then((m) => ({ cards: m.CARDS, questions: m.QUESTIONS })),`
    );
  }
  indexLines.push('};');
  indexLines.push('');
  indexLines.push(`export const AVAILABLE_ROTATIONS = ${JSON.stringify(rotations)} as const;`);
  indexLines.push('');

  await fs.writeFile(ROTATION_MAP_INDEX_FILE, indexLines.join('\n'), 'utf8');
  console.log(
    `[generate-content-map] Wrote ${rotations.length} rotation shards → ${path.relative(ROOT, ROTATION_MAP_DIR)}`
  );

  // Remove legacy monolith map now that all runtime users are sharded.
  await fs.rm(LEGACY_MONOLITH_FILE, { force: true });

  // --- Rotation counts (tiny client-safe file) ---
  const rotationCounts: Record<string, number> = {};
  for (const card of normalizedCards) {
    const rot = card.rotation;
    rotationCounts[rot] = (rotationCounts[rot] ?? 0) + 1;
  }
  for (const question of normalizedQuestions) {
    const rot = question.rotation;
    rotationCounts[rot] = (rotationCounts[rot] ?? 0) + 1;
  }

  const sortedEntries = Object.entries(rotationCounts).sort(([a], [b]) => a.localeCompare(b));

  const rcLines: string[] = [];
  rcLines.push('/*');
  rcLines.push(' * AUTO-GENERATED FILE — DO NOT EDIT');
  rcLines.push(' *');
  rcLines.push(' * Generated by: scripts/generate-content-map.ts');
  rcLines.push(` * Generated at: ${generatedAt}`);
  rcLines.push(` * Build mode: ${mode.name}`);
  rcLines.push(' */');
  rcLines.push('');
  rcLines.push('/** Total items (cards + questions) per rotation, computed at build time. */');
  rcLines.push('export const ROTATION_COUNTS: Record<string, number> = {');
  for (const [rotation, count] of sortedEntries) {
    rcLines.push(`  ${JSON.stringify(rotation)}: ${count},`);
  }
  rcLines.push('};');
  rcLines.push('');

  await fs.writeFile(ROTATION_COUNTS_FILE, rcLines.join('\n'), 'utf8');
  console.log(
    `[generate-content-map] Wrote rotation counts → ${path.relative(ROOT, ROTATION_COUNTS_FILE)}`
  );
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error('[generate-content-map] Fatal error:', error);
    process.exitCode = 1;
  });
}
