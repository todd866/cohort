/**
 * How a delivered item came to be picked, recorded in
 * `ServeDecision.payload.selection` so a later analysis can weight a serve by
 * the chance it had of happening.
 *
 * The lane is the row's `decisionPath`. What this adds is the policy that
 * made the pick, the size of the eligible pool it picked from, and the
 * probability of the pick where the policy makes that knowable. Where it does
 * not, the record says `unknown` and why; it never guesses.
 *
 * Pure: no I/O and no clock.
 */

/** Bump a lane's identifier when its selection rule changes. */
export const INSTANT_SELECTION_POLICY = 'instant-shuffle-v1';

/** A lane that has not named its policy yet. */
export function unversionedSelectionPolicy(lane: string): string {
  return `${lane}:unversioned`;
}

export interface ServeSelectionRecord {
  lane: string;
  policy: string;
  /** Eligible items of this item's type the pick was made from. */
  eligiblePool: number | null;
  /** Seats of this item's type the policy was filling. */
  requested?: number | null;
  /** Chance this item was among the picks, or `unknown`. */
  pickProbability: number | 'unknown';
  /** Why the chance is not a plain k-of-n draw. Empty or absent when it is. */
  nonUniform?: string[];
  /** `cache-build` when the pick was made earlier than the delivery. */
  basis?: 'delivery' | 'cache-build';
}

/** The record for a lane that states no probability. */
export function unknownSelection(input: {
  lane: string;
  policy?: string | null;
  eligiblePool?: number | null;
  basis?: ServeSelectionRecord['basis'];
}): ServeSelectionRecord {
  return {
    lane: input.lane,
    policy: input.policy || unversionedSelectionPolicy(input.lane),
    eligiblePool: typeof input.eligiblePool === 'number' && Number.isFinite(input.eligiblePool)
      ? input.eligiblePool
      : null,
    pickProbability: 'unknown',
    ...(input.basis ? { basis: input.basis } : {}),
  };
}

/**
 * A uniform draw of `requested` items from `eligiblePool` without replacement
 * includes each item with probability requested / eligiblePool. Any reason in
 * `nonUniform` (a partition, a preference, a reserved seat, grouped siblings
 * that share one seat) makes the items unequal, and the answer is `unknown`.
 */
export function uniformPickProbability(input: {
  requested: number;
  eligiblePool: number;
  nonUniform: readonly string[];
}): number | 'unknown' {
  if (input.nonUniform.length > 0) return 'unknown';
  if (!Number.isFinite(input.requested) || !Number.isFinite(input.eligiblePool)) return 'unknown';
  if (input.eligiblePool <= 0 || input.requested < 0) return 'unknown';
  return Math.min(1, input.requested / input.eligiblePool);
}

export interface InstantSelectionFacts {
  /** Reasons that apply to every card or question in the batch. */
  batchReasons: { card: readonly string[]; question: readonly string[] };
  eligiblePool: { card: number; question: number };
  requested: { card: number; question: number };
  /** Policy id for card seats when it is not the lane default. */
  cardPolicy?: string;
}

/** The selection record for one item the instant lane delivered. */
export function instantSelectionRecord(
  item: { type: string },
  itemReasons: readonly string[],
  facts: InstantSelectionFacts,
): ServeSelectionRecord {
  if (item.type !== 'card' && item.type !== 'question') {
    return unknownSelection({ lane: 'instant', policy: INSTANT_SELECTION_POLICY });
  }
  const nonUniform = [...new Set([...facts.batchReasons[item.type], ...itemReasons])];
  return {
    lane: 'instant',
    policy: item.type === 'card' && facts.cardPolicy ? facts.cardPolicy : INSTANT_SELECTION_POLICY,
    eligiblePool: facts.eligiblePool[item.type],
    requested: facts.requested[item.type],
    pickProbability: uniformPickProbability({
      requested: facts.requested[item.type],
      eligiblePool: facts.eligiblePool[item.type],
      nonUniform,
    }),
    ...(nonUniform.length > 0 ? { nonUniform } : {}),
    basis: 'delivery',
  };
}

/** Read `payload.selection` back, or null when absent or malformed. */
export function parseServeSelection(payload: unknown): ServeSelectionRecord | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).selection;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.lane !== 'string' || typeof row.policy !== 'string') return null;
  const probability = typeof row.pickProbability === 'number'
    && Number.isFinite(row.pickProbability) && row.pickProbability > 0 && row.pickProbability <= 1
    ? row.pickProbability
    : 'unknown';
  return {
    lane: row.lane,
    policy: row.policy,
    eligiblePool: typeof row.eligiblePool === 'number' && Number.isFinite(row.eligiblePool)
      ? row.eligiblePool
      : null,
    ...(typeof row.requested === 'number' && Number.isFinite(row.requested)
      ? { requested: row.requested }
      : {}),
    pickProbability: probability,
    ...(Array.isArray(row.nonUniform)
      ? { nonUniform: row.nonUniform.filter((reason): reason is string => typeof reason === 'string') }
      : {}),
    ...(row.basis === 'delivery' || row.basis === 'cache-build' ? { basis: row.basis } : {}),
  };
}
