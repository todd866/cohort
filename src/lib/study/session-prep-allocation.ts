/** Pure allocation over an already eligible pool. Never restores a gated item. */
export interface SessionPrepAllocation {
  share: number;
  sessions?: readonly { share: number; itemIds: readonly string[] }[];
  /** Type-qualified keys (card:id / question:id), never bare ids. */
  itemIds: readonly string[];
  weakItemIds?: readonly string[];
  unseenItemIds?: readonly string[];
}

/**
 * Keep protected work first and spread prep across the discretionary prefix.
 * Within prep, alternate weak and unseen gaps (unseen first below 25%) so first sights have time for a
 * later spaced review. Input order breaks ties (the caller's session shuffle).
 * If either side runs out, ordinary eligible work fills the remaining seats.
 */
export function orderSessionPrepCandidates<T>(
  items: readonly T[],
  plan: SessionPrepAllocation | null | undefined,
  options: { size: number; key: (item: T) => string; protected?: (item: T) => boolean; prepSeats?: number },
): T[] {
  if (!plan || !Number.isFinite(plan.share) || plan.share <= 0) return [...items];
  const prepKeys = new Set(plan.itemIds);
  const weakKeys = new Set(plan.weakItemIds);
  const unseenKeys = new Set(plan.unseenItemIds);
  const protectedItems: T[] = [], ordinary: T[] = [], weak: T[] = [], unseen: T[] = [], otherPrep: T[] = [];
  for (const item of items) {
    const key = options.key(item);
    if (options.protected?.(item)) protectedItems.push(item);
    else if (!prepKeys.has(key)) ordinary.push(item);
    else if (weakKeys.has(key)) weak.push(item);
    else if (unseenKeys.has(key)) unseen.push(item);
    else otherPrep.push(item);
  }
  const prep: T[] = [];
  for (let i = 0; i < Math.max(weak.length, unseen.length); i++) {
    if (plan.share < 0.25 && i < unseen.length) prep.push(unseen[i]);
    if (i < weak.length) prep.push(weak[i]);
    if (plan.share >= 0.25 && i < unseen.length) prep.push(unseen[i]);
  }
  prep.push(...otherPrep);
  if ((plan.sessions?.length ?? 0) > 1) {
    const byKey = new Map(prep.map(item => [options.key(item), item]));
    const keys = orderPrepKeys(prep.map(options.key), plan);
    prep.splice(0, prep.length, ...keys.map(key => byKey.get(key)!));
  }
  const seats = Math.max(0, Math.floor(options.size) - protectedItems.length);
  const wanted = Math.min(prep.length, seats, Math.max(0, Math.floor(options.prepSeats ?? seats * Math.min(0.5, plan.share))));
  const prefix: T[] = [...protectedItems];
  let p = 0, o = 0;
  for (let slot = 0; slot < seats; slot++) {
    const prepDue = Math.floor((slot + 1) * wanted / seats) > p;
    if ((prepDue || o >= ordinary.length) && p < prep.length) prefix.push(prep[p++]);
    else if (o < ordinary.length) prefix.push(ordinary[o++]);
    else break;
  }
  return [...prefix, ...ordinary.slice(o), ...prep.slice(p)];
}

/** Round once across modalities; a small mixed batch still starts preparation. */
export function prepModalityBudgets(share: number, cardSeats: number, questionSeats: number, cardSupply: number, questionSupply: number): { cards: number; questions: number } {
  const total = Math.floor((cardSeats + questionSeats) * Math.max(0, Math.min(0.5, share)));
  let cards = Math.min(cardSupply, cardSeats, Math.floor(cardSeats * Math.min(0.5, share)));
  let questions = Math.min(questionSupply, questionSeats, total - cards);
  cards += Math.min(Math.max(0, cardSupply - cards), Math.max(0, cardSeats - cards), total - cards - questions);
  questions += Math.min(Math.max(0, questionSupply - questions), Math.max(0, questionSeats - questions), total - cards - questions);
  return { cards, questions };
}

/** Share overlapping sessions without letting a large distant deck crowd out a near class. */
export function orderPrepKeys(keys: readonly string[], plan: SessionPrepAllocation): string[] {
  const weak = new Set(plan.weakItemIds);
  const unseen = new Set(plan.unseenItemIds);
  const interleave = (pool: readonly string[]) => {
    const w = pool.filter(key => weak.has(key)), u = pool.filter(key => unseen.has(key));
    const out: string[] = [];
    for (let i = 0; i < Math.max(w.length, u.length); i++) {
      if (plan.share < 0.25 && i < u.length) out.push(u[i]);
      if (i < w.length) out.push(w[i]);
      if (plan.share >= 0.25 && i < u.length) out.push(u[i]);
    }
    return [...out, ...pool.filter(key => !weak.has(key) && !unseen.has(key))];
  };
  const sessions = plan.sessions?.filter(session => session.share > 0) ?? [];
  if (sessions.length < 2) return interleave(keys);
  const queues = sessions.map(session => {
    const ids = new Set(session.itemIds);
    return { share: session.share, taken: 0, keys: interleave(keys.filter(key => ids.has(key))) };
  });
  const used = new Set<string>(), out: string[] = [];
  while (true) {
    for (const queue of queues) while (queue.keys.length && used.has(queue.keys[0])) queue.keys.shift();
    const available = queues.filter(queue => queue.keys.length);
    if (!available.length) break;
    available.sort((a, b) => (a.taken + 1) / a.share - (b.taken + 1) / b.share);
    const queue = available[0], key = queue.keys.shift()!;
    queue.taken++;
    used.add(key); out.push(key);
  }
  return [...out, ...keys.filter(key => !used.has(key))];
}
