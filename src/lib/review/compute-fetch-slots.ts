import type { FetchSlot } from '@/components/review/hooks/useReviewSession';
import type { ReviewFeedMode } from '@/components/review/hooks/useReviewFeedMode';

/** Track-ordered rotations: upcoming rotations come first in cross-rotation blend */
const TRACK_ORDER: Record<number, string[]> = {
  1: ['cah', 'pwh', 'critical-care', 'paam'],
  2: ['pwh', 'cah', 'paam', 'critical-care'],
  3: ['critical-care', 'paam', 'cah', 'pwh'],
  4: ['paam', 'critical-care', 'pwh', 'cah'],
};

const BATCH_SIZE = 15;
const REREVIEW_START = 30;
const CROSS_START = 60;
const CROSS_FULL = 90;
const REREVIEW_SIZE = 3;
const MAX_CROSS_SIZE = 4;

/**
 * Distribute a total integer across n buckets so that earlier buckets absorb
 * the remainder (e.g. distribute(15, 2) → [8, 7]).
 */
function distribute(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * Distribute `total` across rotations proportional to `weights` using the
 * largest-remainder method, so the result always sums to `total`. Rotations
 * with weight 0 get 0. Order of `rotations` is preserved.
 */
function distributeWeighted(
  total: number,
  rotations: string[],
  weights: Record<string, number>,
): number[] {
  const w = rotations.map(r => Math.max(0, weights[r] ?? 0));
  const sumW = w.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return distribute(total, rotations.length);
  const raw = w.map(x => (x / sumW) * total);
  const floors = raw.map(Math.floor);
  let used = floors.reduce((a, b) => a + b, 0);
  const remainders = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  let k = 0;
  while (used < total && k < remainders.length) {
    out[remainders[k].i] += 1;
    used += 1;
    k += 1;
  }
  return out;
}

/**
 * Three-tier blend used in Mixed mode (single-primary):
 *
 * Tier 1 (primary): Unseen cards from user's current rotation — normal spaced rep.
 * Tier 2 (rereview): Cards from primary rotation the user got wrong today.
 * Tier 3 (cross-rotation): Easy content from other rotations, prioritizing upcoming.
 *
 * Blend curve (out of 15 items per batch):
 *   0-29 reviews:  15 primary
 *   30-59:         12 primary + 3 rereview
 *   60-89:         10 primary + 3 rereview + 2 cross-rotation (easy)
 *   90+:            8 primary + 3 rereview + 4 cross-rotation (easy)
 */
function computeBlendSlots(
  primary: string,
  allRotations: string[],
  track: number | null,
  todayReviewed: number,
): FetchSlot[] {
  const slots: FetchSlot[] = [];

  let primarySize = BATCH_SIZE;

  if (todayReviewed >= REREVIEW_START) {
    primarySize -= REREVIEW_SIZE;
    slots.push({
      rotation: primary,
      size: REREVIEW_SIZE,
      mode: 'rereview',
      blendTier: 'rereview',
    });
  }

  if (todayReviewed >= CROSS_START) {
    const crossRatio = Math.min(1, (todayReviewed - CROSS_START) / (CROSS_FULL - CROSS_START));
    const crossSize = Math.max(1, Math.round(MAX_CROSS_SIZE * crossRatio));
    primarySize -= crossSize;

    const trackRotations = (track != null ? TRACK_ORDER[track] : null) ?? allRotations;
    const primaryIdx = trackRotations.indexOf(primary);
    const others = trackRotations
      .filter(r => r !== primary)
      .sort((a, b) => {
        const aIdx = trackRotations.indexOf(a);
        const bIdx = trackRotations.indexOf(b);
        const aDist = (aIdx - primaryIdx + trackRotations.length) % trackRotations.length;
        const bDist = (bIdx - primaryIdx + trackRotations.length) % trackRotations.length;
        return aDist - bDist;
      });

    const perOther = Math.max(1, Math.floor(crossSize / others.length));
    let remaining = crossSize;
    for (const r of others) {
      const size = Math.min(perOther, remaining);
      if (size <= 0) break;
      remaining -= size;
      slots.push({
        rotation: r,
        size,
        difficulty: 'easy',
        blendTier: 'cross-rotation',
      });
    }
  }

  slots.unshift({
    rotation: primary,
    size: Math.max(1, primarySize),
    blendTier: 'primary',
  });

  return slots;
}

/**
 * Multi-primary blend: split BATCH_SIZE evenly across all primaries; per-primary
 * rereview above threshold; no cross-rotation tier (the user is already studying
 * multiple rotations as primary, so cross-rotation is redundant).
 */
function computeMultiPrimarySlots(
  primaries: string[],
  todayReviewed: number,
  feedMode: ReviewFeedMode,
  weights?: Record<string, number>,
): FetchSlot[] {
  const slots: FetchSlot[] = [];

  const includeRereview = feedMode === 'mixed' && todayReviewed >= REREVIEW_START;
  // Per-primary rereview budget — keeps total at BATCH_SIZE.
  const rereviewSizes = includeRereview
    ? (weights
        ? distributeWeighted(REREVIEW_SIZE, primaries, weights)
        : distribute(REREVIEW_SIZE, primaries.length))
    : primaries.map(() => 0);
  const rereviewTotal = rereviewSizes.reduce((a, b) => a + b, 0);

  const primarySizes = weights
    ? distributeWeighted(BATCH_SIZE - rereviewTotal, primaries, weights)
    : distribute(BATCH_SIZE - rereviewTotal, primaries.length);

  primaries.forEach((rotation, i) => {
    // Even split guarantees ≥1 per primary; weighted split honours the curve
    // (a 0-weight rotation, e.g. MND post-exam, drops out entirely).
    const size = weights ? primarySizes[i] : Math.max(1, primarySizes[i]);
    if (size > 0) slots.push({ rotation, size, blendTier: 'primary' });
  });

  if (includeRereview) {
    primaries.forEach((rotation, i) => {
      const size = rereviewSizes[i];
      if (size > 0) {
        slots.push({ rotation, size, mode: 'rereview', blendTier: 'rereview' });
      }
    });
  }

  return slots;
}

export interface ComputeFetchSlotsArgs {
  /** Single primary rotation, or list of primaries for multi-rotation users. */
  primary: string | string[];
  allRotations: string[];
  track: number | null;
  todayReviewed: number;
  feedMode: ReviewFeedMode;
  /**
   * Per-rotation blend weights for a weighted multi-primary split. When present
   * slots are allocated proportionally instead of evenly. The homepage does not
   * use this for opt-in personal decks; those are explicit focus sessions only.
   */
  weights?: Record<string, number>;
  /** Focus mode: serve ONLY `primary` (a single rotation), no cross-rotation tier. */
  focus?: boolean;
}

/**
 * Build the fetch-slot list for a review session. In 'new-only' mode this
 * collapses to a single primary-rotation slot (no rereview, no cross-rotation —
 * both serve already-seen content by definition). When `primary` is a list with
 * more than one entry, the batch is split evenly across those primaries.
 */
export function computeFetchSlots(args: ComputeFetchSlotsArgs): FetchSlot[] {
  const primaries = Array.isArray(args.primary) ? args.primary : [args.primary];

  // Focus mode: a single rotation, reusing the multi-primary builder with a
  // one-element list so the cross-rotation tier (single-primary blend) can
  // never fire. new-only collapses to one 15-item primary slot inside it.
  if (args.focus) {
    return computeMultiPrimarySlots([primaries[0]], args.todayReviewed, args.feedMode);
  }

  if (primaries.length > 1) {
    return computeMultiPrimarySlots(primaries, args.todayReviewed, args.feedMode, args.weights);
  }

  const single = primaries[0];
  if (args.feedMode === 'new-only') {
    return [{ rotation: single, size: BATCH_SIZE, blendTier: 'primary' }];
  }
  return computeBlendSlots(single, args.allRotations, args.track, args.todayReviewed);
}
