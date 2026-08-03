/**
 * High-performance bulk upsert using raw SQL
 *
 * Uses Postgres INSERT ... ON CONFLICT DO UPDATE with multi-row VALUES
 * to upsert thousands of records in seconds instead of minutes.
 *
 * Performance comparison (4000 questions to Neon):
 * - Individual upserts: ~10 minutes
 * - Batched transactions (100/batch): ~3 minutes
 * - Bulk SQL (1000/batch): ~15 seconds
 */

import { tagFormat } from '@/lib/questions/format-tagger';

/** Any Prisma-like client that supports raw SQL (works with both PrismaClient and $extends() result). */
type PrismaLike = { $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<number> };

export interface BulkUpsertOptions {
  /** Rows per INSERT statement (default 500, max ~1000 for Postgres) */
  batchSize?: number;
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Generate a unique dollar-quote tag to safely wrap strings
 * Postgres dollar quoting: $tag$content$tag$ allows any characters inside
 */
export function dollarQuote(value: string): string {
  // Find a tag that doesn't appear in the content
  let tag = '';
  let counter = 0;
  while (value.includes(`$${tag}$`)) {
    tag = `q${counter++}`;
  }
  return `$${tag}$${value}$${tag}$`;
}

/**
 * Escape a value for SQL, handling NULL and special characters
 * Uses dollar-quoting for strings to safely handle any content
 */
export function sqlEscape(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'object') {
    // JSON/JSONB - dollar-quote and cast (includes arrays)
    const json = JSON.stringify(value);
    return `${dollarQuote(json)}::jsonb`;
  }
  // String - dollar-quote for safety
  return dollarQuote(String(value));
}

/**
 * Escape a string array for Postgres text[] column
 */
export function sqlEscapeTextArray(values: string[]): string {
  if (!values || values.length === 0) {
    return 'ARRAY[]::text[]';
  }
  // Use ARRAY constructor with dollar-quoted strings
  const escaped = values.map(v => dollarQuote(String(v))).join(',');
  return `ARRAY[${escaped}]::text[]`;
}

/**
 * Bulk upsert questions using raw SQL
 */
export async function bulkUpsertQuestions(
  prisma: PrismaLike,
  questions: Array<{
    id: string;
    sourceFile?: string | null;
    stem: string;
    options: unknown;
    context: string;
    rotation: string;
    week: number | null;
    topics: string[];
    /**
     * Cross-rotation membership. `rotation` is the canonical home; this is what
     * lets one item belong to a second surface — e.g. rotation 'pwh' with
     * moduleNodes ['pwh','usmle/step1']. Omitted → [] (the column is NOT NULL).
     */
    moduleNodes?: string[];
    questionType: string;
    difficulty: string;
    /** Cognitive format. If omitted, auto-derived via format-tagger. */
    format?: string | null;
    variantGroupId?: string | null;
    variantType?: string | null;
    imageUrl?: string | null;
    imageCaption?: string | null;
    cite?: string | null;
    /** Structured citation/provenance envelope; falls back to legacy `cite`. */
    citationMetadata?: unknown | null;
    crosslinks?: unknown | null;
    annotations?: unknown | null;
    abbreviations?: unknown | null;
    combinations?: unknown | null;
    correctVariants?: unknown | null;
  }>,
  options: BulkUpsertOptions = {}
): Promise<number> {
  // Smaller batch size for questions (more JSONB columns = larger SQL statements)
  // Neon free tier runs out of memory with 500
  const batchSize = options.batchSize ?? 50;
  const onProgress = options.onProgress;

  if (questions.length === 0) return 0;

  // Runtime guard: reject questions without context (belt-and-suspenders with TypeScript type)
  const missing = questions.filter(q => !q.context || q.context.trim().length === 0);
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} question(s) have empty/null context — cannot upsert:\n` +
      missing.slice(0, 5).map(q => `  - ${q.id}`).join('\n')
    );
  }

  let completed = 0;
  const total = questions.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = questions.slice(i, i + batchSize);

    const values = batch.map(q => {
      const format = q.format ?? tagFormat(q.stem, q.topics, q.questionType);
      return `(
      ${sqlEscape(q.id)},
      ${sqlEscape(q.stem)},
      ${sqlEscape(q.options)},
      ${sqlEscape(q.context)},
      ${sqlEscape(q.rotation)},
      ${q.week === null ? 'NULL' : q.week},
      ${sqlEscapeTextArray(q.topics)},
      ${sqlEscapeTextArray(q.moduleNodes ?? [])},
      'bank',
      ${sqlEscape(q.sourceFile ?? 'question-bank')},
      NULL,
      ${sqlEscape(q.questionType)},
      ${sqlEscape(q.difficulty)},
      ${sqlEscape(format)},
      ${sqlEscape(q.variantGroupId ?? null)},
      ${sqlEscape(q.variantType ?? null)},
      ${sqlEscape(q.imageUrl ?? null)},
      ${sqlEscape(q.imageCaption ?? null)},
      ${q.citationMetadata != null
        ? sqlEscape(q.citationMetadata)
        : q.cite
          ? sqlEscape({ cite: q.cite })
          : 'NULL'},
      ${sqlEscape(q.crosslinks ?? null)},
      ${sqlEscape(q.annotations ?? null)},
      ${sqlEscape(q.abbreviations ?? null)},
      ${sqlEscape(q.combinations ?? null)},
      ${sqlEscape(q.correctVariants ?? null)},
      'enhanced',
      NOW(),
      NOW()
    )`;
    }).join(',\n');

    const sql = `
      INSERT INTO "Question" (
        "id", "stem", "options", "explanation", "rotation", "week", "topics",
        "moduleNodes",
        "source", "sourceFile", "questionNumber", "questionType", "difficulty",
        "format",
        "variantGroupId", "variantType", "imageUrl", "imageCaption", "citations", "crosslinks", "annotations",
        "abbreviations", "combinations", "correctVariants", "contentState", "createdAt", "updatedAt"
      )
      VALUES ${values}
      ON CONFLICT ("id") DO UPDATE SET
        "stem" = EXCLUDED."stem",
        "options" = CASE
          WHEN EXCLUDED."options" IS NOT NULL THEN EXCLUDED."options"
          ELSE "Question"."options"
        END,
        "explanation" = CASE
          WHEN EXCLUDED."explanation" IS NOT NULL AND length(trim(EXCLUDED."explanation")) > 0
            THEN EXCLUDED."explanation"
          ELSE "Question"."explanation"
        END,
        "rotation" = EXCLUDED."rotation",
        "week" = EXCLUDED."week",
        "topics" = EXCLUDED."topics",
        "moduleNodes" = EXCLUDED."moduleNodes",
        "sourceFile" = EXCLUDED."sourceFile",
        "questionType" = EXCLUDED."questionType",
        "difficulty" = EXCLUDED."difficulty",
        "format" = EXCLUDED."format",
        "variantGroupId" = EXCLUDED."variantGroupId",
        "variantType" = EXCLUDED."variantType",
        "imageUrl" = EXCLUDED."imageUrl",
        "imageCaption" = EXCLUDED."imageCaption",
        -- Source files are authoritative for public rights. Omitting or
        -- explicitly nulling publicUsmle must revoke stale DB eligibility;
        -- retaining an old DB envelope would make rights removal ineffective.
        "citations" = EXCLUDED."citations",
        "crosslinks" = EXCLUDED."crosslinks",
        "annotations" = EXCLUDED."annotations",
        "abbreviations" = EXCLUDED."abbreviations",
        "combinations" = EXCLUDED."combinations",
        "correctVariants" = EXCLUDED."correctVariants",
        "contentState" = CASE
          WHEN "Question"."contentState" IN ('shelved', 'retired') THEN "Question"."contentState"
          ELSE 'enhanced'
        END,
        "updatedAt" = NOW()
    `;

    await prisma.$executeRawUnsafe(sql);

    completed += batch.length;
    onProgress?.(completed, total);
  }

  return completed;
}

/**
 * Bulk upsert cards using raw SQL
 */
export async function bulkUpsertCards(
  prisma: PrismaLike,
  cards: Array<{
    stableId: string;
    cardType: string;
    rotation: string;
    week: number | null;
    sourceFile?: string | null;
    sourceComponent?: string | null;
    front: string;
    back: string;
    backs?: unknown | null;
    context?: string | null;
    topics: string[];
    difficulty: string;
    complexity: number;
    importance?: number;
    crosslinks?: unknown | null;
    annotations?: unknown | null;
    abbreviations?: unknown | null;
    imageUrl?: string | null;
    imageCaption?: string | null;
    imageRole?: string | null;
    jurisdiction?: string | null;
    conceptId?: string | null;
    clusterId?: string | null;
    variantGroupId?: string | null;
    variantIndex?: number | null;
    variantType?: string | null;
  }>,
  options: BulkUpsertOptions = {}
): Promise<number> {
  const batchSize = options.batchSize ?? 500;
  const onProgress = options.onProgress;

  if (cards.length === 0) return 0;

  let completed = 0;
  const total = cards.length;

  for (let i = 0; i < total; i += batchSize) {
    const batch = cards.slice(i, i + batchSize);

    const values = batch.map(c => `(
      gen_random_uuid()::text,
      ${sqlEscape(c.stableId)},
      ${sqlEscape(c.cardType)},
      ${sqlEscape(c.rotation)},
      ${c.week === null ? 'NULL' : c.week},
      ${sqlEscape(c.sourceFile ?? null)},
      ${sqlEscape(c.sourceComponent ?? 'MDX')},
      ${sqlEscape(c.front)},
      ${sqlEscape(c.back)},
      ${sqlEscape(c.backs ?? null)},
      ${sqlEscape(c.context ?? null)},
      ${sqlEscapeTextArray(c.topics)},
      ${sqlEscape(c.difficulty)},
      ${c.complexity},
      ${c.importance ?? 1},
      ${sqlEscape(c.crosslinks ?? null)},
      ${sqlEscape(c.annotations ?? null)},
      ${sqlEscape(c.abbreviations ?? null)},
      ${sqlEscape(c.imageUrl ?? null)},
      ${sqlEscape(c.imageCaption ?? null)},
      ${sqlEscape(c.imageRole ?? null)},
      ${sqlEscape(c.jurisdiction ?? null)},
      ${sqlEscape(c.conceptId ?? null)},
      ${sqlEscape(c.clusterId ?? null)},
      ${sqlEscape(c.variantGroupId ?? null)},
      ${c.variantIndex == null ? 'NULL' : c.variantIndex},
      ${sqlEscape(c.variantType ?? null)},
      NOW()
    )`).join(',\n');

    const sql = `
      INSERT INTO "Card" (
        "id", "stableId", "cardType", "rotation", "week", "sourceFile", "sourceComponent",
        "front", "back", "backs", "context", "topics", "difficulty", "complexity", "importance",
        "crosslinks", "annotations", "abbreviations", "imageUrl", "imageCaption", "imageRole", "jurisdiction", "conceptId",
        "clusterId", "variantGroupId", "variantIndex", "variantType",
        "createdAt"
      )
      VALUES ${values}
      ON CONFLICT ("stableId") DO UPDATE SET
        "cardType" = EXCLUDED."cardType",
        "rotation" = EXCLUDED."rotation",
        "week" = EXCLUDED."week",
        "sourceFile" = EXCLUDED."sourceFile",
        "sourceComponent" = EXCLUDED."sourceComponent",
        "front" = EXCLUDED."front",
        "back" = EXCLUDED."back",
        "backs" = EXCLUDED."backs",
        "context" = EXCLUDED."context",
        "topics" = EXCLUDED."topics",
        "difficulty" = EXCLUDED."difficulty",
        "complexity" = EXCLUDED."complexity",
        "importance" = EXCLUDED."importance",
        "crosslinks" = EXCLUDED."crosslinks",
        "annotations" = EXCLUDED."annotations",
        "abbreviations" = EXCLUDED."abbreviations",
        "imageUrl" = EXCLUDED."imageUrl",
        "imageCaption" = EXCLUDED."imageCaption",
        "imageRole" = EXCLUDED."imageRole",
        "jurisdiction" = EXCLUDED."jurisdiction",
        "conceptId" = EXCLUDED."conceptId",
        -- Most cards receive clusters from the embedding pipeline after seed.
        -- A later reseed must not erase those assignments merely because the
        -- MDX source has no explicit clusterId. Authored non-null assignments
        -- still replace the existing value deterministically.
        "clusterId" = COALESCE(EXCLUDED."clusterId", "Card"."clusterId"),
        "variantGroupId" = EXCLUDED."variantGroupId",
        "variantIndex" = EXCLUDED."variantIndex",
        "variantType" = EXCLUDED."variantType"
    `;

    await prisma.$executeRawUnsafe(sql);

    completed += batch.length;
    onProgress?.(completed, total);
  }

  return completed;
}
