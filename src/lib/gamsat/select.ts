/**
 * Move-weighted passage selection — the thing that makes this a reasoning-move
 * engine rather than a shuffled question bank.
 *
 * Pure and synchronous by design: no storage, no fetch, no clock. The caller
 * supplies mastery, recency and domain history; this decides what to serve.
 */
import type { MasteryState } from './types';

export interface PassageSummary {
  id: string;
  /** Subject matter — orthogonal to `moves`, and what transfer is measured across. */
  domain: string;
  moves: string[];
}

export interface SelectOptions {
  /** Domains the learner has already worked, used to break score ties. */
  seenDomains?: string[];
}

/**
 * Prior weakness for a move never attempted.
 *
 * Deliberately below a demonstrated failure (1.0) and above a demonstrated
 * strength: an unexplored move should outrank one you can already do, but a move
 * you have actually failed is the more urgent signal.
 */
export const UNSEEN_WEAKNESS = 0.7;

export function moveWeakness(mastery: MasteryState, moveId: string): number {
  const record = mastery[moveId];
  if (!record || record.total <= 0) return UNSEEN_WEAKNESS;
  return 1 - record.correct / record.total;
}

/** Mean weakness across the moves a passage demands. */
export function scorePassage(passage: PassageSummary, mastery: MasteryState): number {
  if (passage.moves.length === 0) return 0;
  const total = passage.moves.reduce((sum, id) => sum + moveWeakness(mastery, id), 0);
  return total / passage.moves.length;
}

/**
 * Choose the next passage: highest mean weakness, skipping anything recently
 * served. Ties break toward an unseen domain, because meeting a move in a second
 * domain is what distinguishes transfer from recognition.
 */
export function selectPassage(
  corpus: PassageSummary[],
  mastery: MasteryState,
  recentIds: string[],
  options: SelectOptions = {},
): PassageSummary | null {
  if (corpus.length === 0) return null;

  const recent = new Set(recentIds);
  // When everything has been served, cycling is correct — an exhausted corpus
  // should keep working, not stall.
  const pool = corpus.filter((p) => !recent.has(p.id));
  const candidates = pool.length > 0 ? pool : corpus;

  const seenDomains = new Set(options.seenDomains ?? []);

  return candidates.reduce((best, candidate) => {
    const bestScore = scorePassage(best, mastery);
    const score = scorePassage(candidate, mastery);
    if (score !== bestScore) return score > bestScore ? candidate : best;

    const bestUnseen = !seenDomains.has(best.domain);
    const candidateUnseen = !seenDomains.has(candidate.domain);
    if (bestUnseen !== candidateUnseen) return candidateUnseen ? candidate : best;

    // Stable, so the same mastery state always yields the same passage.
    return candidate.id < best.id ? candidate : best;
  }, candidates[0]);
}

/** Moves the learner has met in two or more distinct domains. */
export function movesWithTransferEvidence(
  history: Array<{ moves: string[]; domain: string }>,
): string[] {
  const domains = new Map<string, Set<string>>();
  for (const entry of history) {
    for (const move of entry.moves) {
      const set = domains.get(move) ?? new Set<string>();
      set.add(entry.domain);
      domains.set(move, set);
    }
  }
  return [...domains.entries()]
    .filter(([, set]) => set.size >= 2)
    .map(([move]) => move)
    .sort();
}
