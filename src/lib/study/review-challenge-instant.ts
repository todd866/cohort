import { reviewChallengeOrdinalNudge, type ReviewChallengeLevel } from './review-challenge';

export interface InstantChallengeCandidate {
  id: string;
  complexity?: number | null;
  difficulty?: string | null;
  topics?: readonly string[] | null;
  variantGroupId?: string | null;
}

/** A small adjustment inside unseen slots; reviewed identities keep their seats. */
export function nudgeInstantChallenge<T extends InstantChallengeCandidate>(
  candidates: readonly T[],
  level: ReviewChallengeLevel,
  eligible: ReadonlySet<string>,
  metadata: ReadonlyMap<string, { facilityIndex: number | null; sampleSize: number }>,
): T[] {
  if (level === 0) return [...candidates];
  const output = [...candidates];
  const groups = new Map<string, number[]>();
  candidates.forEach((item, index) => {
    if (!eligible.has(item.id)) return;
    // Keep the same topic distribution. An unlabelled candidate cannot displace
    // a different subject simply because it happens to be easy.
    const key = item.topics?.[0] ?? '__unlabelled__';
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  for (const indices of groups.values()) {
    const ranked = indices.map((index, ordinal) => {
      const item = candidates[index];
      const empirical = metadata.get(item.id);
      const nudge = reviewChallengeOrdinalNudge({
        level,
        complexity: item.complexity ?? (item.difficulty === 'easy' ? 1 : item.difficulty === 'hard' ? 5 : 3),
        facility: empirical?.facilityIndex,
        sampleSize: empirical?.sampleSize,
      });
      return { item, ordinal, rank: ordinal + nudge };
    }).sort((a, b) => a.rank - b.rank || a.ordinal - b.ordinal);
    indices.forEach((index, ordinal) => { output[index] = ranked[ordinal].item; });
  }
  return output;
}
