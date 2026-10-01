import type { ReviewClusterRotations } from './review-intent';

/**
 * Display identity of a cluster-scoped session. Mirrors the shape produced by
 * the server bootstrap; kept structural so this module stays free of React.
 */
export interface ClusterScopeVerdict {
  id: string;
  label: string;
  cardCount: number;
  rotation: string | null;
}

export interface ClusterVerdictSource {
  reviewClusterRotations?: ReviewClusterRotations | null;
  reviewClusterScope?: ClusterScopeVerdict | null;
}

export interface ClusterVerdict {
  reviewClusterRotations: ReviewClusterRotations;
  reviewClusterScope: ClusterScopeVerdict | null;
}

const EMPTY_ROTATIONS: ReviewClusterRotations = {};

/**
 * Which server-resolved cluster verdict the review client should trust.
 *
 * The verdict answers "does this cluster have live cards in this rotation, and
 * what is it called" — a question keyed to the URL, which only the server can
 * answer. It is therefore valid for as long as the bootstrap was computed for
 * the current URL, and has nothing to do with whether the client's preference
 * hooks are still loading. Reading it only while prefs load (2026-09-18) made
 * the scope banner flash and disappear on every heatmap deep link.
 */
export function pickClusterVerdict(args: {
  bootstrapLocationMatches: boolean;
  bootstrap: ClusterVerdictSource | null | undefined;
  initialUserContext: ClusterVerdictSource | null | undefined;
  contextMatchesOwner: boolean;
}): ClusterVerdict {
  const source = args.bootstrapLocationMatches && args.bootstrap
    ? args.bootstrap
    : args.contextMatchesOwner && args.initialUserContext
      ? args.initialUserContext
      : null;
  return {
    reviewClusterRotations: source?.reviewClusterRotations ?? EMPTY_ROTATIONS,
    reviewClusterScope: source?.reviewClusterScope ?? null,
  };
}
