/**
 * Adaptive difficulty for the public Step 1 reviewer.
 *
 * The promise on cohort.md/tech is: answer one, get it right and the next is
 * harder, get it wrong and it steps down until you can. Before this, the
 * reviewer ranked by unseen-then-stale and never read the outcome, so a doctor
 * and a first-year got the same sequence.
 *
 * Pure and dependency-free so the rule is testable without a database, a
 * corpus, or a session. The server decides WHICH pool to pass in; this decides
 * the order.
 */

export const DIFFICULTY_TIERS = ['easy', 'medium', 'hard'] as const;
export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

export interface AdaptiveQuestion {
  id: string;
  difficulty?: string;
  domain?: string;
  /** Lower wins only after tier and missed-concept scaffolding signals tie. */
  preferenceRank?: number;
  /**
   * Groups rungs that build to one concept. The open corpus already carries 43
   * complete ladders (easy/medium/hard, 126 questions) and the reviewer was
   * ignoring them — this is the strongest scaffolding signal available.
   */
  ladderId?: string;
}

export interface AdaptiveHistoryRow {
  questionId: string;
  isCorrect: boolean;
  createdAt: Date;
}

/**
 * The open corpus labels the middle rung both 'medium' (96 questions) and
 * 'moderate' (26). Treating those as separate tiers would make a climbing
 * learner bounce between two rungs that mean the same thing. Anything
 * unrecognised also lands in the middle: guessing 'easy' strands a strong
 * reader, guessing 'hard' buries a weak one.
 */
export function normaliseDifficulty(raw: string | undefined | null): DifficultyTier {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'easy') return 'easy';
  if (value === 'hard') return 'hard';
  return 'medium';
}

/**
 * Consecutive correct answers required at a tier before climbing.
 *
 * Promoting on ONE correct answer produces a sawtooth. Simulating the real
 * corpus (scripts/audit/simulate-visitor-walks.ts) showed a pre-clinical
 * persona oscillating M✓ H✗ M✓ H✗ across 40 questions and failing half of
 * them: pushed up by a single success, dropped by the inevitable failure,
 * never consolidating. Demotion stays immediate — nobody should have to fail
 * twice to be helped — so the ladder is deliberately asymmetric.
 */
export const PROMOTION_STREAK = 2;

/** Climb on success, step down on failure, and clamp at both ends. */
export function nextTier(current: DifficultyTier, wasCorrect: boolean): DifficultyTier {
  const i = DIFFICULTY_TIERS.indexOf(current);
  const moved = wasCorrect ? i + 1 : i - 1;
  // Clamping at the floor is the load-bearing half: a learner who keeps missing
  // easy questions must keep getting easy ones rather than falling out of the
  // ladder entirely.
  return DIFFICULTY_TIERS[Math.min(DIFFICULTY_TIERS.length - 1, Math.max(0, moved))];
}

/**
 * Order unanswered questions for this learner.
 *
 * Distance from the target tier is the sort key, so an exhausted tier falls
 * back to the nearest neighbour rather than ending the session — a visitor
 * should never hit a dead end mid-demo.
 */
export function rankAdaptive(
  questions: AdaptiveQuestion[],
  history: AdaptiveHistoryRow[],
  size: number,
): AdaptiveQuestion[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answered = new Set(history.map((row) => row.questionId));

  let target: DifficultyTier = 'medium';
  // Set only when the learner just got something WRONG. Stepping down to an
  // easier question is not teaching: after missing an SGLT2 vignette they need
  // SGLT2 groundwork, not an unrelated easy question. On the way UP the
  // opposite is true — the concept is proved, so breadth beats drilling it.
  let scaffoldDomain: string | null = null;
  let scaffoldLadder: string | null = null;
  if (history.length > 0) {
    const latest = history.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
    const asked = byId.get(latest.questionId);
    const askedTier = normaliseDifficulty(asked?.difficulty);
    // Count the run of consecutive correct answers ending here, at this tier.
    // A miss, or an answer at a different tier, ends the run.
    let streak = 0;
    const ordered = [...history].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = ordered.length - 1; i >= 0; i--) {
      const row = ordered[i];
      if (!row.isCorrect) break;
      if (normaliseDifficulty(byId.get(row.questionId)?.difficulty) !== askedTier) break;
      streak += 1;
    }
    target = latest.isCorrect && streak < PROMOTION_STREAK
      ? askedTier
      : nextTier(askedTier, latest.isCorrect);
    if (!latest.isCorrect) {
      scaffoldLadder = asked?.ladderId ?? null;
      scaffoldDomain = asked?.domain ?? null;
    }
  }
  const targetIndex = DIFFICULTY_TIERS.indexOf(target);

  return questions
    .filter((q) => !answered.has(q.id))
    .map((q) => ({
      q,
      distance: Math.abs(DIFFICULTY_TIERS.indexOf(normaliseDifficulty(q.difficulty)) - targetIndex),
      // Preferences, not filters. An exhausted ladder or domain must not end the
      // session, so everything still ranks — just later.
      offLadder: scaffoldLadder !== null && q.ladderId !== scaffoldLadder ? 1 : 0,
      offDomain: scaffoldDomain !== null && q.domain !== scaffoldDomain ? 1 : 0,
      preferenceRank: Number.isFinite(q.preferenceRank) ? q.preferenceRank! : 0,
    }))
    // Tier, then the ladder that was missed, then its domain, then id.
    // Deterministic: same learner, same pool, same order, so a reload cannot
    // reshuffle the sequence mid-session.
    .sort((a, b) =>
      a.distance - b.distance
      || a.offLadder - b.offLadder
      || a.offDomain - b.offDomain
      || a.preferenceRank - b.preferenceRank
      || a.q.id.localeCompare(b.q.id))
    .slice(0, size)
    .map((x) => x.q);
}
