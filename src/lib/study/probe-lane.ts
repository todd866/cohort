/**
 * The probe lane: one card per topic per day, at the rung that best locates
 * the learner.
 *
 * A SECOND scheduler beside the existing one, not a replacement. The manifold
 * answers "what should this person study next". This lane answers "where is
 * this person" — stated 2026-09-17 as the product question: it is not Anki, it
 * is "does this person know this thing that they need to know?"
 *
 * Why a separate lane rather than a change to the selection rule. Three
 * measurements from the same day: readiness takes 94 days to fade with the exam
 * 15 days out, so due-date scheduling tracks a variable that is not moving; a
 * red square is made of items NEVER seen, which score zero, so the lever is
 * coverage; and readiness already weights hard items 4x, so it is already asking
 * how deep a learner can go while being fed by an unrelated rule. One probe per
 * square is also the right daily volume.
 *
 * How the rung adapts. A cluster's DEMONSTRATED level is the highest rung the
 * learner has answered well recently. The next probe aims one rung above it —
 * the question is always "can you go further?" — unless the last probe was a
 * miss, in which case it aims one rung below what was missed. No history at all
 * probes at C2, the corpus's bulk. Nothing is stored: the level is derived from
 * responses, which is what "where are you" means.
 *
 * Supply is the constraint, not the algorithm. 91% of CAH sits at C1-C2 and 37
 * of 107 squares hold no C3-or-harder card, so "harder" often has nowhere to
 * go. `nearestRung` degrades to the closest available rung and the caller can
 * see the gap: a cluster whose target rung has no card is an authoring ask.
 *
 * Ships behind a share that defaults to ZERO, like every lane. A bad version
 * costs a fraction of a batch, never the serving path.
 */

export const PROBE_TARGET_DEFAULT = 2;
export const PROBE_RUNG_MIN = 1;
export const PROBE_RUNG_MAX = 5;

/** Share of a batch reserved for probes. Zero ships the lane dark. */
export const PROBE_RESERVE_RATIO_DEFAULT = 0;

export interface ProbeCandidate {
  id: string;
  clusterId: string;
  complexity: number;
}

export interface ClusterProbeHistory {
  /** Highest rung answered with quality ≥ 3 in the recent window, if any. */
  demonstrated: number | null;
  /** Rung of the most recent probe if it was a miss, else null. */
  lastMissRung: number | null;
  /** Whether this cluster has already received a probe today. */
  probedToday: boolean;
}

/**
 * The rung the next probe should aim at.
 *
 * A miss dominates: if the last probe at rung L was wrong, aim at L-1 rather
 * than at demonstrated+1, because the learner just told us where the edge is.
 * Otherwise aim one above what they have shown. Clamped to the rung range.
 */
export function targetRung(history: Pick<ClusterProbeHistory, 'demonstrated' | 'lastMissRung'>): number {
  const clamp = (r: number) => Math.min(PROBE_RUNG_MAX, Math.max(PROBE_RUNG_MIN, r));
  if (history.lastMissRung !== null) return clamp(history.lastMissRung - 1);
  if (history.demonstrated === null) return PROBE_TARGET_DEFAULT;
  return clamp(history.demonstrated + 1);
}

/**
 * The closest available rung to the target, preferring easier on a tie.
 *
 * Returns null when the cluster has no candidates at all. Prefers easier on a
 * tie because an over-hard probe teaches nothing when it is missed, while an
 * over-easy one still confirms the floor.
 */
export function nearestRung(target: number, available: ReadonlySet<number>): number | null {
  if (available.size === 0) return null;
  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const rung of available) {
    const dist = Math.abs(rung - target);
    if (dist < bestDist || (dist === bestDist && best !== null && rung < best)) {
      best = rung;
      bestDist = dist;
    }
  }
  return best;
}

export interface ProbeSelection {
  cardId: string;
  clusterId: string;
  rung: number;
  target: number;
}

export interface ProbeGap {
  clusterId: string;
  target: number;
  /** The rung actually available nearest the target, or null if nothing at all. */
  served: number | null;
}

/**
 * Deterministic shuffle keyed on a seed, so the same session gets the same
 * order and different sessions differ. Never `.find()` on fixed order — see
 * `.claude/rules/repetition-guards.md`.
 */
function seededOrder<T>(items: readonly T[], key: (item: T) => string, seed: string): T[] {
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  };
  return [...items].sort((a, b) => hash(seed + key(a)) - hash(seed + key(b)));
}

/**
 * Pick one probe per cluster, up to `seats`.
 *
 * Skips clusters already probed today — one question per square per day is the
 * whole contract. Within a cluster, chooses a card at the nearest available rung
 * to the target, selected by seeded shuffle rather than first-in-list so the
 * same card does not become a cluster's permanent probe.
 *
 * `gaps` reports every cluster whose target rung had no card, whether or not a
 * probe was served at a different rung. That list is the authoring worklist
 * this lane exists to produce: the squares where "can you go further?" has
 * nothing to ask.
 */
export function selectProbes(
  candidates: readonly ProbeCandidate[],
  histories: ReadonlyMap<string, ClusterProbeHistory>,
  seats: number,
  seed: string,
): { probes: ProbeSelection[]; gaps: ProbeGap[] } {
  const probes: ProbeSelection[] = [];
  const gaps: ProbeGap[] = [];
  if (seats <= 0) return { probes, gaps };

  const byCluster = new Map<string, ProbeCandidate[]>();
  for (const card of candidates) {
    const bucket = byCluster.get(card.clusterId) ?? [];
    bucket.push(card);
    byCluster.set(card.clusterId, bucket);
  }

  // Clusters in seeded order too, so a batch that cannot fit every square does
  // not always starve the same ones.
  const clusterIds = seededOrder([...byCluster.keys()], (id) => id, seed);

  for (const clusterId of clusterIds) {
    if (probes.length >= seats) break;
    const history = histories.get(clusterId) ?? { demonstrated: null, lastMissRung: null, probedToday: false };
    if (history.probedToday) continue;

    const cards = byCluster.get(clusterId)!;
    const target = targetRung(history);
    const available = new Set(cards.map((c) => c.complexity));
    const rung = nearestRung(target, available);
    if (rung === null) {
      gaps.push({ clusterId, target, served: null });
      continue;
    }
    if (rung !== target) gaps.push({ clusterId, target, served: rung });

    const atRung = cards.filter((c) => c.complexity === rung);
    const pick = seededOrder(atRung, (c) => c.id, seed)[0];
    if (!pick) continue;
    probes.push({ cardId: pick.id, clusterId, rung, target });
  }

  return { probes, gaps };
}
