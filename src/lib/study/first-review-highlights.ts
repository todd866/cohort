import { shuffleWithSeed } from '@/lib/utils/shuffle';

export const FIRST_REVIEW_LIMIT = 6;
export const FIRST_REVIEW_WINDOW_MS = 30 * 60 * 1000;
export const FIRST_REVIEW_ROTATIONS = ['cah', 'critical-care', 'paam', 'pwh', 'physical-exam', 'neurosurg'] as const;

/** A new identity is required; zero answers on an old account is not a first visit. */
export function firstReviewRemaining(createdAt: Date | null | undefined, completed: number, now = Date.now()): number {
  const created = createdAt?.getTime();
  if (created == null || !Number.isFinite(created) || created > now
    || now - created >= FIRST_REVIEW_WINDOW_MS || !Number.isSafeInteger(completed) || completed < 0) return 0;
  return Math.max(0, FIRST_REVIEW_LIMIT - completed);
}

export interface HighlightCandidate {
  type: 'card' | 'question';
  /** Card stableId or the question bank's stable primary ID. */
  key: string;
  rotation: string;
  media: string;
  kind: 'imaging' | 'neuroimaging' | 'examination' | 'surgery';
}

/** Lead with an eligible playable clip when present, then vary subjects and media. */
export function orderFirstReviewHighlights<T extends { id: string; rotation: string; mediaKey: string; kind: string; prompt: boolean; video?: boolean; diagnosticScore?: number }>(
  items: readonly T[], seed: string, limit: number, adaptive = false,
): T[] {
  const pool = shuffleWithSeed([...items], seed);
  const result: T[] = [];
  const media = new Set<string>();
  while (pool.length && result.length < limit) {
    const last = result.at(-1);
    pool.sort((a, b) => {
      const score = (item: T) => Number(Boolean(item.video) && !last) * 20
        + (adaptive ? item.diagnosticScore ?? 0 : 0) + Number(item.prompt) * (last ? 1 : 4)
        + Number(!last || item.kind !== last.kind) * 3
        + Number(!last || item.rotation !== last.rotation);
      return score(b) - score(a);
    });
    const next = pool.shift()!;
    if (media.has(next.mediaKey)) continue;
    media.add(next.mediaKey);
    result.push(next);
  }
  return result;
}
