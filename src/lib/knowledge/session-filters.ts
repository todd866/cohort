/**
 * Session Filters — pure penalty functions for topic cooldown and bank card breadth.
 *
 * These produce 0.0–1.0 penalties that sink low-priority candidates in the
 * unified scheduler's candidate ordering without hard-blocking them.
 */

const COOLDOWN_HOURS = 24;

/**
 * Penalty for cards whose topics were recently reviewed (cross-session cooldown).
 *
 * For each candidate topic, checks if other cards with that topic were recently reviewed.
 * Penalty = count * max(0, 1 - hoursAgo / 24) — linear decay over 24h, proportional to exposure count.
 * Takes max across all topics, clamped to [0, 1].
 */
export function computeTopicCooldownPenalty(
  candidateTopics: string[],
  recentTopicExposures: Map<string, { count: number; mostRecentMs: number }>,
  nowMs: number
): number {
  if (candidateTopics.length === 0) return 0;

  let maxPenalty = 0;

  for (const topic of candidateTopics) {
    const exposure = recentTopicExposures.get(topic);
    if (!exposure) continue;

    const hoursAgo = (nowMs - exposure.mostRecentMs) / (60 * 60 * 1000);
    const timeFactor = Math.max(0, 1 - hoursAgo / COOLDOWN_HOURS);
    const penalty = exposure.count * timeFactor;

    if (penalty > maxPenalty) maxPenalty = penalty;
  }

  return Math.min(1, maxPenalty);
}

const BANK_CARD_PENALTIES: Record<number, number> = {
  0: 0,
  1: 0.3,
  2: 0.7,
};
const BANK_CARD_MAX_PENALTY = 0.95;

/**
 * Penalty for "content dump" bank cards (sourceFile ending in '-cards').
 *
 * Unseen bank cards (0 reviews) get no penalty — they're welcome for breadth.
 * After 1-2 reviews, penalty ramps up. 3+ reviews → near-retired (0.95).
 */
export function computeBankCardPenalty(
  sourceFile: string | null,
  totalReviews: number
): number {
  if (!sourceFile || !sourceFile.endsWith('-cards')) return 0;
  return BANK_CARD_PENALTIES[totalReviews] ?? BANK_CARD_MAX_PENALTY;
}
