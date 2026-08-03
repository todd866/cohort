/**
 * Modality-Run Breaker
 *
 * Walk-audit fires `modality-monotony` when ≥6 consecutive items of the same
 * `sourceType` (card or question) appear in a session. The unified scheduler
 * has a per-step quota cap that breaks runs while concept-driven candidates
 * are available, but the rotation top-up step (8c) and final card backfill
 * can re-introduce monotony when one pool is exhausted.
 *
 * This guard is the last-mile defence: a post-rhythm pass that scans the
 * built session and rearranges items so no trailing same-type run trips the
 * audit. It only mutates ordering — never adds, drops, or substitutes items —
 * so it cannot fight the scheduler's other invariants.
 *
 * Two-stage approach:
 *   1. Forward swap pass (cheap, minimal disturbance): when a trailing run
 *      reaches the cap, swap a later different-type item forward.
 *   2. Stride redistribution fallback: if minority items are clustered at
 *      the head of the queue, the forward pass can't reach them. Rebuild
 *      the queue by placing minority-type items at evenly-spaced positions
 *      with majority-type items filling the gaps. Relative order WITHIN
 *      each type is preserved, so the manifold walk's intra-type ordering
 *      survives.
 *
 * The threshold is one below the audit fire-point so the guard always leaves
 * a one-item buffer.
 */
import { MODALITY_RUN_THRESHOLD } from '@/lib/audit/walk-pathologies';

/**
 * Maximum consecutive same-type run permitted by the guard.
 * Audit fires at MODALITY_RUN_THRESHOLD (6); we keep runs strictly below that.
 */
export const MODALITY_MAX_SAME_TYPE_RUN = MODALITY_RUN_THRESHOLD - 1;

/**
 * Minimal contract: the guard only inspects `.type`. Both UnifiedSessionItem
 * (scheduler output) and UnifiedItem (instant-path output) satisfy this, so
 * the guard can run on either path's items.
 */
type Typed = { type: string };

export function maxSameTypeRun<T extends Typed>(items: T[]): number {
  if (items.length === 0) return 0;
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < items.length; i++) {
    if (items[i].type === items[i - 1].type) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
    }
  }
  return maxRun;
}

/**
 * Rebuild the queue by placing minority-type items at evenly-spaced positions.
 *
 * Algorithm: pick the most-numerous type as "majority"; treat the rest as
 * "minority". With m majority and k minority items (m + k = total), place
 * minority item i at output position `ceil((i+1) * m / (k+1)) + i` so the
 * minority items act as separators between majority groups of size at most
 * `ceil(m / (k+1))`. Majority items fill the remaining slots in input order.
 *
 * Pre-condition: maxSameTypeRun(items) > MODALITY_MAX_SAME_TYPE_RUN. This
 * fallback is intentionally aggressive — the forward pass had already failed,
 * so we accept losing some of the rhythm/manifold inter-type ordering in
 * exchange for breaking a run that would otherwise trip the audit.
 *
 * If `ceil(m / (k+1)) > MODALITY_MAX_SAME_TYPE_RUN` (e.g., 12 cards / 1
 * question = 6-run), the redistribution returns the best achievable layout
 * — the audit will still fire, signalling a genuinely one-sided candidate
 * pool that the scheduler upstream needs to address.
 */
function strideRedistribute<T extends Typed>(items: T[]): T[] {
  const total = items.length;
  if (total <= MODALITY_MAX_SAME_TYPE_RUN) return [...items];

  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
  if (counts.size <= 1) return [...items];

  let majType: string = items[0].type;
  let majCount = counts.get(majType) ?? 0;
  for (const [t, c] of counts) {
    if (c > majCount) {
      majType = t;
      majCount = c;
    }
  }

  const majQueue = items.filter((it) => it.type === majType);
  const minQueue = items.filter((it) => it.type !== majType);
  if (minQueue.length === 0) return [...items];

  const m = majQueue.length;
  const k = minQueue.length;
  const result: Array<T | null> = new Array(total).fill(null);

  for (let i = 0; i < k; i++) {
    const target = Math.ceil(((i + 1) * m) / (k + 1)) + i;
    const clamped = Math.max(0, Math.min(total - 1, target));
    let p = clamped;
    while (p < total && result[p] !== null) p += 1;
    if (p >= total) {
      p = clamped - 1;
      while (p >= 0 && result[p] !== null) p -= 1;
    }
    if (p < 0) {
      for (let q = 0; q < total; q++) {
        if (result[q] === null) {
          p = q;
          break;
        }
      }
    }
    result[p] = minQueue[i];
  }

  let mIdx = 0;
  for (let i = 0; i < total; i++) {
    if (result[i] === null) {
      result[i] = majQueue[mIdx];
      mIdx += 1;
    }
  }

  return result as T[];
}

/**
 * Scan a built session and break any same-type run that would trip the audit.
 *
 * Stage 1: forward-swap pass. Walk left-to-right. Whenever the trailing run
 * reaches MODALITY_MAX_SAME_TYPE_RUN of the same type, look ahead for the
 * nearest item of a *different* type and swap it into the position
 * immediately after the run. O(n²) worst-case but n ≤ 30 in practice.
 *
 * Stage 2 (fallback): if any same-type run still exceeds the cap after the
 * forward pass — typically because the minority items were clustered at the
 * head of the queue with no swap target available later — rebuild with
 * stride redistribution. This loses some of the manifold-walk inter-type
 * ordering but preserves relative order within each type.
 *
 * If the input is genuinely one-sided (only one type, or the minority count
 * is too small to bound runs at the cap), the run is left as-is and the
 * audit will still fire — that is the correct signal that the upstream
 * candidate pool needs widening.
 */
export function breakModalityRuns<T extends Typed>(items: T[]): T[] {
  if (items.length <= MODALITY_MAX_SAME_TYPE_RUN) return [...items];

  const result = [...items];

  // Stage 1: forward-swap sweep. Each iteration either swaps or leaves the run intact.
  for (let i = 0; i < result.length; i++) {
    if (i < MODALITY_MAX_SAME_TYPE_RUN - 1) continue;

    const runType: string = result[i].type;
    let runLength = 1;
    for (let j = i - 1; j >= 0 && result[j].type === runType; j--) {
      runLength += 1;
    }

    if (runLength < MODALITY_MAX_SAME_TYPE_RUN) continue;
    if (i + 1 >= result.length) break; // run is at end; forward pass cannot fix
    if (result[i + 1].type !== runType) continue; // run already broken at i+1

    let swapIdx = -1;
    for (let k = i + 2; k < result.length; k++) {
      if (result[k].type !== runType) {
        swapIdx = k;
        break;
      }
    }
    if (swapIdx === -1) break; // forward pass exhausted; fallback below
    [result[i + 1], result[swapIdx]] = [result[swapIdx], result[i + 1]];
  }

  // Stage 2: stride redistribution if the forward pass left a run too long.
  if (maxSameTypeRun(result) > MODALITY_MAX_SAME_TYPE_RUN) {
    return strideRedistribute(items);
  }

  return result;
}
