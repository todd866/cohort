/**
 * Final-egress safety boundary for sessions that admit entitled content from
 * another source rotation. Candidate selection has its own budget so it can
 * avoid wasted work; this pure guard exists because later scheduler passes can
 * inject items after that budget was applied.
 *
 * Callers pass an explicit seat budget from the dessert mix. When omitted, the
 * legacy two-item ceiling remains the fail-closed default.
 */

/** Default seat budget when a caller does not pass an explicit mix plan. */
export const MAX_CROSS_SOURCE_ITEMS_PER_SESSION = 2;

interface CrossSourceCapOptions<T> {
  sessionRotation: string;
  allowedCrossSourceRotations: readonly string[];
  maxCrossSourceItems?: number;
  getRotation: (item: T) => string;
  /**
   * Corpus key for FAIR seat allocation among cross-source items.
   *
   * Without it the budget is spent first-come in rank order, so a composed
   * deck — which is cross-source items and nothing else — can come back
   * entirely from whichever corpus the ranker favoured. NSx is a view over
   * BlueLink, the Netter plates and the Kubie collection, and a session of
   * pure BlueLink satisfies the cap while failing the deck's whole purpose.
   *
   * When supplied, seats are dealt round-robin across the corpora present,
   * and the survivors are emitted in the scheduler's ORIGINAL order. This
   * stays a filter: it chooses which items keep their seats, never reorders
   * the feed and never injects anything, so the repetition and novelty
   * guards downstream see what they expect.
   */
  getSourceKey?: (item: T) => string;
}

function normalizeCrossSourceLimit(value: number | undefined): number {
  if (value === undefined) return MAX_CROSS_SOURCE_ITEMS_PER_SESSION;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Preserve native items and original order while admitting at most
 * `maxCrossSourceItems` from explicitly allowed source rotations. Any
 * non-native rotation that was not authorized is removed.
 */
export function capCrossSourceSessionItems<T>(
  items: readonly T[],
  options: CrossSourceCapOptions<T>,
): T[] {
  const allowedSources = new Set(
    options.allowedCrossSourceRotations.filter(
      (sourceRotation) =>
        sourceRotation.length > 0 && sourceRotation !== options.sessionRotation,
    ),
  );
  const limit = normalizeCrossSourceLimit(options.maxCrossSourceItems);

  const isAdmissible = (item: T): boolean => {
    const itemRotation = options.getRotation(item);
    return itemRotation !== options.sessionRotation && allowedSources.has(itemRotation);
  };

  const getSourceKey = options.getSourceKey;
  if (getSourceKey && limit > 0) {
    // Queue each corpus's admissible items in rank order, then deal seats
    // round-robin. Map iteration is insertion-ordered, and insertion follows
    // the ranked list, so the allocation is deterministic for a given input.
    const queues = new Map<string, number[]>();
    items.forEach((item, index) => {
      if (!isAdmissible(item)) return;
      const key = getSourceKey(item);
      const queue = queues.get(key);
      if (queue) queue.push(index);
      else queues.set(key, [index]);
    });

    const seated = new Set<number>();
    const rings = [...queues.values()];
    let cursor = 0;
    while (seated.size < limit && rings.some((ring) => ring.length > 0)) {
      const ring = rings[cursor % rings.length];
      const next = ring.shift();
      if (next !== undefined) seated.add(next);
      cursor += 1;
    }

    return items.filter((item, index) =>
      !isAdmissible(item) ? options.getRotation(item) === options.sessionRotation
        : seated.has(index));
  }

  let emittedCrossSourceItems = 0;
  return items.filter((item) => {
    const itemRotation = options.getRotation(item);
    if (itemRotation === options.sessionRotation) return true;
    if (!allowedSources.has(itemRotation)) return false;
    if (emittedCrossSourceItems >= limit) return false;

    emittedCrossSourceItems += 1;
    return true;
  });
}
