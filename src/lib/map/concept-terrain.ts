/**
 * Concept "terrain" — the HONEST per-concept signal that colours the desktop
 * concept Map.
 *
 * Design principle: a single mark tells us almost nothing, and a high
 * self-rating on a *familiar* item is recognition, not knowledge ("I might rate
 * something a 4 cuz I've seen it, but try me with a slightly different wording
 * and I'll fail"). Mastery is *established* over several spaced, varied
 * iterations. So the map is TWO dimensions, kept separate:
 *
 *   - performance   — how you're doing, recency/familiarity-weighted. A
 *                     familiarity discount down-weights rapid repeats of the
 *                     SAME item so recognition can't inflate it.
 *   - established   — whether we can trust that number yet: enough DISTINCT
 *                     items tested across enough SPACED days.
 *
 * Only an *established* concept earns a strong/weak colour; everything with
 * signal-but-not-yet-established is `provisional` (renders hollow, never solid
 * green). As contrast-sets / answer-rotation accumulate, the fresh-sibling-vs-
 * seen-stem divergence becomes the gold-standard input to established-ness.
 *
 * Deliberately does NOT use ConceptState.recall* (stale/degenerate off CC; md3's
 * own 12f audit flags the recall stream as failing). Pure function — the DB
 * query + score normalisation live in the caller.
 * See docs/superpowers/specs/2026-07-22-mobile-review-desktop-concept-map.md §4.2.
 */

export type ConceptTerrainStatus = 'strong' | 'weak' | 'provisional' | 'unexplored';

export interface ConceptTerrainNode {
  conceptId: string;
  name: string;
  week: number | null;
  examWeight: number;
  /** Familiarity-discounted success over the window, [0,1]; null with no in-window signal. */
  performance: number | null;
  /** In-window attempt count. */
  attempts: number;
  /** Distinct items tested in-window (variation). */
  distinctItems: number;
  /** Distinct calendar days with an in-window attempt (spacing). */
  spacedDays: number;
  /** Enough varied, spaced iterations to trust the performance number. */
  established: boolean;
  status: ConceptTerrainStatus;
  /** ISO timestamp of the most recent attempt (all-time), or null. */
  lastStudiedAt: string | null;
}

export interface TerrainAttempt {
  conceptId: string;
  itemId: string;
  /** Normalised success in [0,1] (see attemptScore). */
  score: number;
  at: Date;
  /** Attribution weight in (0,1]. One grade on an item tagged with N concepts is
   *  1/N evidence for each, so the caller passes 1/N — otherwise a 12-concept
   *  card smears one grade equally across 12 concepts and collapses their
   *  performance to the global mean. Defaults to 1 (full attribution). */
  weight?: number;
}

export interface ConceptTerrainInput {
  concepts: Array<{ id: string; name: string; week: number | null; examWeight: number }>;
  attempts: TerrainAttempt[];
}

export interface ConceptTerrainOptions {
  now: Date;
  /** Only attempts within this many days count. Default 45. */
  windowDays?: number;
  /** performance >= this ⇒ strong, else weak (only once established). Default 0.7. */
  weakThreshold?: number;
  /** Distinct items needed to be "established". Default 2. */
  minDistinctItems?: number;
  /** Distinct days needed to be "established". Default 2. */
  minSpacedDays?: number;
  /** A same-item attempt with a prior same-item attempt within this many hours is
   *  discounted (recognition, not fresh recall). Default 24. */
  familiarityWindowHours?: number;
  /** Weight applied to such a discounted attempt. Default 0.3. */
  familiarityWeight?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** ConfidenceButtons 1-4 are stored as quality {0,1,3,5}; map to an even [0,1] ramp. */
const CONFIDENCE_QUALITY_TO_SCORE: Record<number, number> = { 0: 0, 1: 1 / 3, 3: 2 / 3, 5: 1 };

/**
 * Normalise a LearningEvent to a success score in [0,1]. An MCQ carries objective
 * `isCorrect` (preferred — less recognition-prone than a self-rating); a cloze
 * carries `quality` (the 1-4 confidence button). Returns null when the row has
 * neither (e.g. a content_exposed impression) so the caller can skip it.
 */
export function attemptScore(row: { isCorrect: boolean | null; quality: number | null }): number | null {
  if (row.isCorrect != null) return row.isCorrect ? 1 : 0;
  if (row.quality != null) {
    return CONFIDENCE_QUALITY_TO_SCORE[row.quality] ?? Math.max(0, Math.min(1, row.quality / 5));
  }
  return null;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function computeConceptTerrain(
  input: ConceptTerrainInput,
  options: ConceptTerrainOptions,
): ConceptTerrainNode[] {
  const windowDays = options.windowDays ?? 45;
  const weakThreshold = options.weakThreshold ?? 0.7;
  const minDistinctItems = options.minDistinctItems ?? 2;
  const minSpacedDays = options.minSpacedDays ?? 2;
  const familiarityWindowMs = (options.familiarityWindowHours ?? 24) * HOUR_MS;
  const familiarityWeight = options.familiarityWeight ?? 0.3;
  const windowStartMs = options.now.getTime() - windowDays * DAY_MS;

  const byConcept = new Map<string, Array<{ itemId: string; score: number; atMs: number; attribution: number }>>();
  for (const a of input.attempts) {
    const entry = { itemId: a.itemId, score: a.score, atMs: a.at.getTime(), attribution: a.weight ?? 1 };
    const bucket = byConcept.get(a.conceptId);
    if (bucket) bucket.push(entry);
    else byConcept.set(a.conceptId, [entry]);
  }

  return input.concepts.map((concept) => {
    // Sorted ascending so the familiarity look-back only scans earlier attempts.
    const all = (byConcept.get(concept.id) ?? []).slice().sort((x, y) => x.atMs - y.atMs);
    const inWindow = all.filter((a) => a.atMs >= windowStartMs);

    const distinctItems = new Set(inWindow.map((a) => a.itemId)).size;
    const spacedDays = new Set(inWindow.map((a) => utcDay(a.atMs))).size;
    const lastStudiedMs = all.length > 0 ? all[all.length - 1].atMs : null;

    let performance: number | null = null;
    if (inWindow.length > 0) {
      let weighted = 0;
      let weight = 0;
      for (const a of inWindow) {
        const priorSameItem = all.some(
          (b) => b.itemId === a.itemId && b.atMs < a.atMs && a.atMs - b.atMs <= familiarityWindowMs,
        );
        const familiarity = priorSameItem ? familiarityWeight : 1;
        const w = familiarity * a.attribution;
        weighted += w * a.score;
        weight += w;
      }
      performance = weight > 0 ? weighted / weight : null;
    }

    const established = distinctItems >= minDistinctItems && spacedDays >= minSpacedDays;

    let status: ConceptTerrainStatus;
    if (all.length === 0) {
      status = 'unexplored';
    } else if (!established) {
      // Signal exists but too few varied/spaced iterations to trust — incl. the
      // "rated it 4 once on a familiar card" case and stale once-known concepts.
      status = 'provisional';
    } else {
      status = (performance as number) >= weakThreshold ? 'strong' : 'weak';
    }

    return {
      conceptId: concept.id,
      name: concept.name,
      week: concept.week,
      examWeight: concept.examWeight,
      performance,
      attempts: inWindow.length,
      distinctItems,
      spacedDays,
      established,
      status,
      lastStudiedAt: lastStudiedMs != null ? new Date(lastStudiedMs).toISOString() : null,
    };
  });
}
