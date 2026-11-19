import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { CHECKED_IN_OPEN_USMLE_RELEASE_IDS } from '../../src/lib/usmle/public-release-bundle';
import { USMLE_STEP1_PUBLIC_MODULE } from '../../src/lib/usmle/public-corpus';
import {
  QUESTION_REINFORCEMENT_SOURCE_COMPONENT,
  withoutRawPublicUsmleReinforcementCards,
} from '../../src/lib/usmle/raw-reinforcement-card-boundary';
import {
  USMLE_STEP1_ROTATIONS,
  withoutRawPublicUsmleQuestions,
} from '../../src/lib/usmle/raw-question-boundary';

/** Prisma `select` for content-map card reads — single source for findMany. */
export const CONTENT_MAP_CARD_FIND_MANY_SELECT = {
  id: true,
  stableId: true,
  sourceFile: true,
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
  importance: true,
  examRelevancePct: true,
  examDomain: true,
} as const;

/**
 * Postgres columns hashed by the card digest query — must match
 * `CONTENT_MAP_CARD_FIND_MANY_SELECT` key-for-key (test-guarded).
 */
export const CONTENT_MAP_CARD_DIGEST_COLUMNS = [
  'id',
  'stableId',
  'sourceFile',
  'front',
  'back',
  'backs',
  'context',
  'imageUrl',
  'imageCaption',
  'imageRole',
  'sourceComponent',
  'rotation',
  'week',
  'clusterId',
  'complexity',
  'crosslinks',
  'cardType',
  'topics',
  'difficulty',
  'variantGroupId',
  'variantIndex',
  'variantType',
  'importance',
  'examRelevancePct',
  'examDomain',
] as const;

/** Prisma `select` for content-map question reads — single source for findMany. */
export const CONTENT_MAP_QUESTION_FIND_MANY_SELECT = {
  id: true,
  sourceFile: true,
  stem: true,
  questionType: true,
  format: true,
  variantGroupId: true,
  variantType: true,
  options: true,
  context: true,
  imageUrl: true,
  imageCaption: true,
  imageRole: true,
  rotation: true,
  moduleNodes: true,
  week: true,
  topics: true,
  difficulty: true,
  combinations: true,
  correctVariants: true,
} as const;

export const CONTENT_MAP_QUESTION_DIGEST_COLUMNS = [
  'id',
  'sourceFile',
  'stem',
  'questionType',
  'format',
  'variantGroupId',
  'variantType',
  'options',
  'context',
  'imageUrl',
  'imageCaption',
  'imageRole',
  'rotation',
  'moduleNodes',
  'week',
  'topics',
  'difficulty',
  'combinations',
  'correctVariants',
] as const;

const OPEN_USMLE_RELEASE_IDS = [...CHECKED_IN_OPEN_USMLE_RELEASE_IDS];

function sqlInList(values: readonly string[]): Prisma.Sql {
  if (values.length === 0) {
    return Prisma.sql`FALSE`;
  }
  return Prisma.join(values);
}

function sqlColumnNotInList(tableAlias: string, column: string, values: readonly string[]): Prisma.Sql {
  if (values.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`${Prisma.raw(`${tableAlias}."${column}"`)} NOT IN (${Prisma.join(values)})`;
}

function sqlIdNotInList(tableAlias: string, values: readonly string[]): Prisma.Sql {
  if (values.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return Prisma.sql`${Prisma.raw(`${tableAlias}.id`)} NOT IN (${Prisma.join(values)})`;
}

export function contentMapCardFindManyArgs(excludedRotations: readonly string[]) {
  return {
    where: withoutRawPublicUsmleReinforcementCards({
      deletedAt: null,
      shelvedAt: null,
      rotation: { notIn: [...excludedRotations] },
    }),
    select: CONTENT_MAP_CARD_FIND_MANY_SELECT,
  };
}

export function contentMapQuestionFindManyArgs(excludedRotations: readonly string[]) {
  return {
    where: withoutRawPublicUsmleQuestions({
      excluded: false,
      contentState: { notIn: ['raw', 'shelved', 'retired'] },
      rotation: { notIn: [...excludedRotations] },
    }),
    select: CONTENT_MAP_QUESTION_FIND_MANY_SELECT,
  };
}

export function contentMapRowCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.MD3_CONTENT_MAP_CACHE !== '0';
}

export function contentMapRowCacheDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.MD3_CONTENT_MAP_CACHE_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.local', 'state', 'md3-content-map-cache');
}

// Digest lists hold Prisma field names; raw SQL needs the database column.
// Question.context is @map("explanation") (content.prisma). The schema test keeps this honest.
const DIGEST_FIELD_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  q: { context: 'explanation' },
};

function digestRowExpression(tableAlias: string, columns: readonly string[]): Prisma.Sql {
  const mapped = DIGEST_FIELD_COLUMNS[tableAlias] ?? {};
  const parts = columns.map((column) => Prisma.raw(`${tableAlias}."${mapped[column] ?? column}"`));
  return Prisma.sql`row(${Prisma.join(parts)})`;
}

function cardDigestWhereSql(excludedRotations: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    c."deletedAt" IS NULL
    AND c."shelvedAt" IS NULL
    AND ${sqlColumnNotInList('c', 'rotation', excludedRotations)}
    AND NOT (
      c."sourceComponent" = ${QUESTION_REINFORCEMENT_SOURCE_COMPONENT}
      AND c."rotation" IN (${Prisma.join([...USMLE_STEP1_ROTATIONS])})
    )
    AND NOT (
      c."sourceComponent" = ${QUESTION_REINFORCEMENT_SOURCE_COMPONENT}
      AND ${USMLE_STEP1_PUBLIC_MODULE} = ANY(c."moduleNodes")
    )
    AND NOT (
      c."sourceComponent" = ${QUESTION_REINFORCEMENT_SOURCE_COMPONENT}
      AND EXISTS (
        SELECT 1
        FROM "Question" q
        WHERE q."cardId" = c.id
          AND (
            q.id IN (${sqlInList(OPEN_USMLE_RELEASE_IDS)})
            OR q.rotation IN (${Prisma.join([...USMLE_STEP1_ROTATIONS])})
            OR ${USMLE_STEP1_PUBLIC_MODULE} = ANY(q."moduleNodes")
          )
      )
    )
  `;
}

function questionDigestWhereSql(excludedRotations: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    q."excluded" = false
    AND q."contentState" NOT IN ('raw', 'shelved', 'retired')
    AND ${sqlColumnNotInList('q', 'rotation', excludedRotations)}
    AND ${sqlIdNotInList('q', OPEN_USMLE_RELEASE_IDS)}
    AND ${sqlColumnNotInList('q', 'rotation', [...USMLE_STEP1_ROTATIONS])}
    AND NOT (${USMLE_STEP1_PUBLIC_MODULE} = ANY(q."moduleNodes"))
  `;
}

export function cardContentMapDigestSql(excludedRotations: readonly string[]): Prisma.Sql {
  const rowExpr = digestRowExpression('c', CONTENT_MAP_CARD_DIGEST_COLUMNS);
  return Prisma.sql`
    SELECT
      md5(string_agg(md5(${rowExpr}::text), '' ORDER BY c.id)) AS digest,
      count(*)::int AS n
    FROM "Card" c
    WHERE ${cardDigestWhereSql(excludedRotations)}
  `;
}

export function questionContentMapDigestSql(excludedRotations: readonly string[]): Prisma.Sql {
  const rowExpr = digestRowExpression('q', CONTENT_MAP_QUESTION_DIGEST_COLUMNS);
  return Prisma.sql`
    SELECT
      md5(string_agg(md5(${rowExpr}::text), '' ORDER BY q.id)) AS digest,
      count(*)::int AS n
    FROM "Question" q
    WHERE ${questionDigestWhereSql(excludedRotations)}
  `;
}

interface CacheEnvelope<T> {
  n: number;
  rows: T[];
}

interface DigestRow {
  digest: string;
  n: number | bigint;
}

async function pruneTableCacheFiles(cacheDir: string, tableLabel: string, keep = 3): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(cacheDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const files = await Promise.all(
    entries
      .filter((name) => name.startsWith(`${tableLabel}-`) && name.endsWith('.json'))
      .map(async (name) => {
        const fullPath = path.join(cacheDir, name);
        const stat = await fs.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      }),
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(keep)) {
    await fs.unlink(stale.fullPath).catch(() => undefined);
  }
}

/**
 * A snapshot is reused for at most this long. The digest query mirrors the findMany filter by hand; if the two ever
 * drift, an old snapshot could keep a shelved or deleted row alive. Capping its age bounds that to half a day while
 * keeping most of the saving (releases and candidate CI run about nine times a day).
 */
export const CONTENT_MAP_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function readCacheFile<T>(cachePath: string, expectedCount: number, now = Date.now()): Promise<T[] | null> {
  try {
    const stat = await fs.stat(cachePath);
    if (now - stat.mtimeMs > CONTENT_MAP_CACHE_MAX_AGE_MS) return null;
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed.n !== expectedCount || !Array.isArray(parsed.rows)) return null;
    return parsed.rows;
  } catch {
    return null;
  }
}

async function writeCacheFileAtomically<T>(
  cacheDir: string,
  tableLabel: string,
  digest: string,
  n: number,
  rows: T[],
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${tableLabel}-${digest}.json`);
  const tempPath = `${cachePath}.tmp-${process.pid}`;
  const payload: CacheEnvelope<T> = { n, rows };
  await fs.writeFile(tempPath, JSON.stringify(payload), 'utf8');
  await fs.rename(tempPath, cachePath);
  await pruneTableCacheFiles(cacheDir, tableLabel);
}

export type ContentMapPrismaClient = Pick<PrismaClient, 'card' | 'question' | '$queryRaw'>;

export async function loadContentMapCardRows<T>(
  client: ContentMapPrismaClient,
  excludedRotations: readonly string[],
  options: {
    env?: Record<string, string | undefined>;
    cacheDir?: string;
    cacheEnabled?: boolean;
  } = {},
): Promise<T[]> {
  const env = options.env ?? process.env;
  const cacheEnabled = options.cacheEnabled ?? contentMapRowCacheEnabled(env);
  const cacheDir = options.cacheDir ?? contentMapRowCacheDir(env);
  const findManyArgs = contentMapCardFindManyArgs(excludedRotations);

  if (!cacheEnabled) {
    console.log('[generated-content] cards: cache miss');
    return client.card.findMany(findManyArgs) as Promise<T[]>;
  }

  const digestRows = await client.$queryRaw<DigestRow[]>(cardContentMapDigestSql(excludedRotations));
  const digestRow = digestRows[0];
  const digest = digestRow?.digest ?? '';
  const n = Number(digestRow?.n ?? 0);
  const digest8 = digest.slice(0, 8);
  const cachePath = path.join(cacheDir, `cards-${digest}.json`);

  const cached = digest ? await readCacheFile<T>(cachePath, n) : null;
  if (cached) {
    console.log(`[generated-content] cards: cache hit ${digest8} (${n} rows)`);
    return cached;
  }

  console.log('[generated-content] cards: cache miss');
  const rows = (await client.card.findMany(findManyArgs)) as T[];
  if (digest) {
    await writeCacheFileAtomically(cacheDir, 'cards', digest, n, rows);
  }
  return rows;
}

export async function loadContentMapQuestionRows<T>(
  client: ContentMapPrismaClient,
  excludedRotations: readonly string[],
  options: {
    env?: Record<string, string | undefined>;
    cacheDir?: string;
    cacheEnabled?: boolean;
  } = {},
): Promise<T[]> {
  const env = options.env ?? process.env;
  const cacheEnabled = options.cacheEnabled ?? contentMapRowCacheEnabled(env);
  const cacheDir = options.cacheDir ?? contentMapRowCacheDir(env);
  const findManyArgs = contentMapQuestionFindManyArgs(excludedRotations);

  if (!cacheEnabled) {
    console.log('[generated-content] questions: cache miss');
    return client.question.findMany(findManyArgs) as Promise<T[]>;
  }

  const digestRows = await client.$queryRaw<DigestRow[]>(
    questionContentMapDigestSql(excludedRotations),
  );
  const digestRow = digestRows[0];
  const digest = digestRow?.digest ?? '';
  const n = Number(digestRow?.n ?? 0);
  const digest8 = digest.slice(0, 8);
  const cachePath = path.join(cacheDir, `questions-${digest}.json`);

  const cached = digest ? await readCacheFile<T>(cachePath, n) : null;
  if (cached) {
    console.log(`[generated-content] questions: cache hit ${digest8} (${n} rows)`);
    return cached;
  }

  console.log('[generated-content] questions: cache miss');
  const rows = (await client.question.findMany(findManyArgs)) as T[];
  if (digest) {
    await writeCacheFileAtomically(cacheDir, 'questions', digest, n, rows);
  }
  return rows;
}
