import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@/lib/logger';

export const DEFAULT_LEGACY_QUESTION_ALLOWLIST_DIR = path.join(
  process.cwd(),
  'question-bank',
  '_allowlists',
);

type AllowlistFileFormat = string[] | { ids: string[] };

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function parseIds(payload: unknown): string[] {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  if (typeof payload === 'object' && 'ids' in payload) {
    const ids = (payload as { ids?: unknown }).ids;
    if (!Array.isArray(ids)) return [];
    return ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  return [];
}

export function loadAllowedLegacyQuestionIdsFromDisk(options: { dir?: string } = {}): {
  dir: string;
  files: string[];
  ids: string[];
  errors: string[];
} {
  const dir = options.dir ?? DEFAULT_LEGACY_QUESTION_ALLOWLIST_DIR;
  if (!fs.existsSync(dir)) return { dir, files: [], ids: [], errors: [] };

  const files = listJsonFiles(dir);
  const ids: string[] = [];
  const errors: string[] = [];

  for (const filePath of files) {
    let parsed: AllowlistFileFormat | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AllowlistFileFormat;
    } catch (err) {
      errors.push(
        `${filePath}: invalid JSON (${err instanceof Error ? err.message : 'unknown error'})`,
      );
      continue;
    }

    const fileIds = parseIds(parsed);
    if (fileIds.length === 0) continue;
    ids.push(...fileIds);
  }

  return { dir, files, ids: Array.from(new Set(ids)), errors };
}

let _cached: { loadedAt: number; ids: Set<string> } | null = null;
let _warned = false;

export function getAllowedLegacyQuestionIds(): Set<string> {
  const ttlMs = process.env.NODE_ENV === 'development' ? 0 : 60_000;
  const now = Date.now();
  if (_cached && now - _cached.loadedAt < ttlMs) return _cached.ids;

  const loaded = loadAllowedLegacyQuestionIdsFromDisk();
  if (loaded.errors.length > 0 && !_warned) {
    _warned = true;
    logger.warn(
      `Legacy question allowlist had ${loaded.errors.length} parse errors; ignoring those files.`,
    );
  }

  _cached = { loadedAt: now, ids: new Set(loaded.ids) };
  return _cached.ids;
}
