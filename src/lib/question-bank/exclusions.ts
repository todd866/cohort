import { logger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
export {
  DEFAULT_QUESTION_EXCLUSIONS_DIR,
  loadExcludedQuestionIdsFromDisk,
} from './exclusions-disk';

let _cached: { loadedAt: number; ids: Set<string> } | null = null;

/**
 * Get excluded question IDs from the database.
 * Cached with 60s TTL in production, no cache in dev.
 */
export async function getExcludedQuestionIds(): Promise<Set<string>> {
  const ttlMs = process.env.NODE_ENV === 'development' ? 0 : 60_000;
  const now = Date.now();
  if (_cached && now - _cached.loadedAt < ttlMs) return _cached.ids;

  try {
    const excluded = await prisma.question.findMany({
      where: { excluded: true },
      select: { id: true },
    });
    _cached = { loadedAt: now, ids: new Set(excluded.map((q) => q.id)) };
  } catch (err) {
    logger.warn(`Failed to load excluded question IDs from DB: ${err instanceof Error ? err.message : 'unknown'}`);
    if (_cached) return _cached.ids;
    _cached = { loadedAt: now, ids: new Set() };
  }

  return _cached.ids;
}
