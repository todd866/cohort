/**
 * Pre-serve predictions recorded on a delivered ServeDecision.
 *
 * A prediction can only be scored against the answer if it was written before
 * the answer and says when it was computed. Two kinds are recorded:
 *
 *   - `delivery`: computed while the batch was being handed to the learner.
 *   - `cache-build`: computed when a background queue was built and delivered
 *     later. It keeps its build time and age, so a stale number is never read
 *     as a fresh one.
 *
 * The ServeDecision `predictedRecall` column only ever holds a `delivery`
 * prediction. Every prediction, of either kind, is listed in
 * `payload.predictions`, so no schema change is needed.
 *
 * Pure: no I/O and no clock, so the audit scripts can read the same records.
 */

export type ServePredictionBasis = 'delivery' | 'cache-build';

export interface ServePrediction {
  /** Predictor name and version, e.g. `item-facility-v1`. */
  predictor: string;
  /** Predicted probability of a correct answer, 0-1. */
  p: number;
  basis: ServePredictionBasis;
  /** When the number was computed (ISO). */
  computedAt: string;
  /** Age of the number at delivery. Zero for a delivery-time prediction. */
  ageMs: number;
  source?: string;
  status?: string;
  /** How much evidence stood behind the number (counts, window sizes). */
  inputs?: Record<string, number | string>;
}

export const UNLABELLED_PREDICTOR = 'unlabelled';

export function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

interface PredictionCarrier {
  predictedRecall?: number | null;
  predictedRecallModel?: string | null;
  predictedRecallSource?: string | null;
  predictedRecallStatus?: string | null;
}

/** The delivery-time prediction an item carries, if any. */
export function deliveryPredictionFromItem(
  item: PredictionCarrier,
  now: Date,
): ServePrediction | null {
  if (!isProbability(item.predictedRecall)) return null;
  return {
    predictor: item.predictedRecallModel || UNLABELLED_PREDICTOR,
    p: item.predictedRecall,
    basis: 'delivery',
    computedAt: now.toISOString(),
    ageMs: 0,
    ...(item.predictedRecallSource ? { source: item.predictedRecallSource } : {}),
    ...(item.predictedRecallStatus ? { status: item.predictedRecallStatus } : {}),
  };
}

/**
 * The prediction a cache-build decision made, restated at delivery with its
 * build time and age.
 */
export function cacheBuildPredictionFromParent(
  parent: { predictedRecall: number | null; payload: unknown; decidedAt: Date | null },
  now: Date,
): ServePrediction | null {
  if (!isProbability(parent.predictedRecall) || !(parent.decidedAt instanceof Date)) return null;
  const payload = parent.payload && typeof parent.payload === 'object' && !Array.isArray(parent.payload)
    ? parent.payload as Record<string, unknown>
    : {};
  return {
    predictor: typeof payload.predictedRecallModel === 'string' && payload.predictedRecallModel
      ? payload.predictedRecallModel
      : UNLABELLED_PREDICTOR,
    p: parent.predictedRecall,
    basis: 'cache-build',
    computedAt: parent.decidedAt.toISOString(),
    ageMs: Math.max(0, now.getTime() - parent.decidedAt.getTime()),
    ...(typeof payload.predictedRecallSource === 'string' ? { source: payload.predictedRecallSource } : {}),
    ...(typeof payload.predictedRecallStatus === 'string' ? { status: payload.predictedRecallStatus } : {}),
  };
}

/** Read `payload.predictions` back, dropping anything malformed. */
export function parseServePredictions(payload: unknown): ServePrediction[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const raw = (payload as Record<string, unknown>).predictions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ServePrediction[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.predictor !== 'string' || !row.predictor || !isProbability(row.p)) return [];
    if (row.basis !== 'delivery' && row.basis !== 'cache-build') return [];
    return [{
      predictor: row.predictor,
      p: row.p,
      basis: row.basis,
      computedAt: typeof row.computedAt === 'string' ? row.computedAt : '',
      ageMs: typeof row.ageMs === 'number' && Number.isFinite(row.ageMs) ? Math.max(0, row.ageMs) : 0,
      ...(typeof row.source === 'string' ? { source: row.source } : {}),
      ...(typeof row.status === 'string' ? { status: row.status } : {}),
      ...(predictionInputs(row.inputs) ? { inputs: predictionInputs(row.inputs)! } : {}),
    }];
  });
}

function predictionInputs(raw: unknown): Record<string, number | string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, number | string] => (
      typeof entry[1] === 'string' || (typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    ),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** One record per `predictor@basis`; the first given wins. */
export function mergeServePredictions(
  ...lists: ReadonlyArray<ReadonlyArray<ServePrediction | null | undefined> | null | undefined>
): ServePrediction[] {
  const seen = new Set<string>();
  const merged: ServePrediction[] = [];
  for (const list of lists) {
    for (const prediction of list ?? []) {
      if (!prediction) continue;
      const key = `${prediction.predictor}@${prediction.basis}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(prediction);
    }
  }
  return merged;
}
