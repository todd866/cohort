import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_QUESTION_EXCLUSIONS_DIR = path.join(
  process.cwd(),
  'question-bank',
  '_exclusions',
);

type ExclusionFileFormat = string[] | { ids: string[] };

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function parseIds(payload: unknown): string[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.filter((value): value is string => (
      typeof value === 'string' && value.trim().length > 0
    ));
  }
  if (typeof payload === 'object' && 'ids' in payload) {
    const ids = (payload as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((value): value is string => (
      typeof value === 'string' && value.trim().length > 0
    ));
  }
  return [];
}

/** Filesystem-only exclusion loader. This module deliberately has no Prisma import. */
export function loadExcludedQuestionIdsFromDisk(options: {
  dir?: string;
  /** Reject invalid manifest shapes instead of retaining the legacy best-effort behavior. */
  strict?: boolean;
} = {}): {
  dir: string;
  files: string[];
  ids: string[];
  errors: string[];
} {
  const dir = options.dir ?? DEFAULT_QUESTION_EXCLUSIONS_DIR;
  if (!fs.existsSync(dir)) return { dir, files: [], ids: [], errors: [] };

  const files = listJsonFiles(dir);
  const ids: string[] = [];
  const errors: string[] = [];

  for (const filePath of files) {
    let parsed: ExclusionFileFormat | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ExclusionFileFormat;
    } catch (error) {
      errors.push(
        `${filePath}: invalid JSON (${error instanceof Error ? error.message : 'unknown error'})`,
      );
      continue;
    }
    if (options.strict === true) {
      const rawIds = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && 'ids' in parsed
          ? (parsed as { ids?: unknown }).ids
          : null;
      if (!Array.isArray(rawIds)) {
        errors.push(`${filePath}: expected an array or an object with an ids array`);
        continue;
      }
      if (rawIds.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
        errors.push(`${filePath}: every exclusion id must be a non-empty string`);
        continue;
      }
    }
    ids.push(...parseIds(parsed));
  }

  return { dir, files, ids: Array.from(new Set(ids)), errors };
}
