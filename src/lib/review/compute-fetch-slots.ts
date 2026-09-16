import type { FetchSlot } from '@/components/review/hooks/useReviewSession';
import type { ReviewFeedMode } from '@/components/review/hooks/useReviewFeedMode';

const BATCH_SIZE = 15;

export interface ComputeFetchSlotsArgs {
  /**
   * The resolved current exam. Arrays remain accepted only so stale callers
   * fail closed to their first already-resolved objective.
   */
  primary: string | string[];
  /** @deprecated Default review no longer fans out across scheduled rotations. */
  allRotations: string[];
  /** @deprecated Target allocation is server-owned. */
  track: number | null;
  /** @deprecated Answer count no longer unlocks unrelated rotation requests. */
  todayReviewed: number;
  feedMode: ReviewFeedMode;
  /** @deprecated Multi-objective weighting is not part of the homepage policy. */
  weights?: Record<string, number>;
  /** Explicit focus still resolves to one exact source rotation. */
  focus?: boolean;
  /**
   * @deprecated Source partitions compete inside the target request after
   * server-side relevance and entitlement checks; they never receive slots.
   */
  supplementary?: string[];
}

/**
 * Build the one request owned by a default review batch.
 *
 * The client chooses only the current exam (or an explicit focus rotation).
 * Due/relearn protection, the term-aware objective-core gate, and the capped
 * target-matched source pool are all server-side concerns. Keeping those
 * policies inside one request prevents a second scheduled rotation or source
 * partition from bypassing the current exam's core.
 */
export function computeFetchSlots(args: ComputeFetchSlotsArgs): FetchSlot[] {
  const target = Array.isArray(args.primary) ? args.primary[0] : args.primary;
  if (!target) return [];
  return [{ rotation: target, size: BATCH_SIZE, blendTier: 'primary' }];
}
