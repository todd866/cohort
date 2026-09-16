export const REVIEW_FILTERS = ['at-risk', 'due', 'new'] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];
export type ReviewTopic = string;

/**
 * The item type a review request is narrowed to. Only `question` (MCQ-only
 * review) is a product mode: `card`/`group` exist in the serving API but have
 * no selector, no fast lane, and no reason to be reachable from a URL.
 */
export type ReviewItemType = 'question';
export type ReviewTopicRotations = Readonly<Record<string, string>>;

/**
 * Which rotations each cluster actually has cards in.
 *
 * Clusters are CROSS-ROTATION by design — `Cluster.rotations` is an array, and
 * 17 of 872 span more than one. So a cluster id alone does not name a scope, and
 * a rotation+cluster pair can be mutually contradictory.
 */
export type ReviewClusterRotations = Readonly<Record<string, readonly string[]>>;

export interface ReviewIntent {
  rotation?: string;
  week?: number;
  filter?: ReviewFilter;
  itemType?: ReviewItemType;
  topics?: ReviewTopic[];
  /**
   * A manifold cluster to narrow the session to — what a square on the profile
   * knowledge heatmap links to. Only ever meaningful inside a rotation the
   * caller can already select, so it can never widen serving scope on its own.
   */
  cluster?: string;
}

interface SearchParamReader {
  get(name: string): string | null;
}

const REVIEW_FILTER_SET = new Set<string>(REVIEW_FILTERS);
const MIN_WEEK = 1;
const MAX_WEEK = 52;

/**
 * Cluster ids are cuids or the `cluster-N` slugs the backfill mints. Bounded
 * and conservative: the value reaches a database filter, so anything that is
 * not plainly an id is dropped rather than sanitised.
 */
const CLUSTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Parse the homepage's public review-link contract.
 *
 * Rotation values are entitlement-sensitive, so callers provide the rotations
 * the current user can actually select. Invalid or inactive values disappear
 * instead of widening the user's serving scope.
 */
export function parseReviewIntent(
  searchParams: SearchParamReader,
  selectableRotations: readonly string[],
  reviewTopicRotations: ReviewTopicRotations = {},
  reviewClusterRotations: ReviewClusterRotations = {},
): ReviewIntent {
  const intent: ReviewIntent = {};

  const rotation = searchParams.get('rotation');
  if (rotation) {
    // A supplied rotation owns the rest of the deep-link scope. If it is no
    // longer selectable (unenrolled, inactive, or malformed), discard the
    // complete intent instead of applying its week/filter to the normal
    // multi-rotation schedule.
    if (!selectableRotations.includes(rotation)) return intent;
    intent.rotation = rotation;
  }

  const rawWeek = searchParams.get('week');
  if (intent.rotation && rawWeek && /^\d+$/.test(rawWeek)) {
    const week = Number(rawWeek);
    if (week >= MIN_WEEK && week <= MAX_WEEK) intent.week = week;
  }

  const filter = searchParams.get('filter');
  if (filter && REVIEW_FILTER_SET.has(filter)) {
    intent.filter = filter as ReviewFilter;
  }

  // MCQ-only. Orthogonal to rotation: an unselectable rotation already discards
  // the whole intent above, so reaching here means the scope is legitimate.
  if (searchParams.get('type') === 'question') intent.itemType = 'question';

  // Scoped by the rotation above: without one there is nothing to narrow, and
  // an unselectable rotation has already discarded the whole intent.
  // A cluster must actually HAVE cards in this rotation, exactly as a topic must
  // belong to it two blocks below. Until 2026-09-15 this was a format check
  // only, so a well-formed id was accepted whatever it contained.
  //
  // Reported that day: the CAH heatmap offered a square labelled "ABG & VBG
  // Interpretation", and clicking it served an unrelated question. That cluster
  // holds 359 live cards across critical-care, paam, usmle-step1 and three KAT
  // rotations, and NONE in CAH. The pair `rotation=cah&cluster=<that>` is
  // self-contradictory, and nothing was positioned to notice: the two arrive as
  // independent parameters and only the cluster's SHAPE was ever examined.
  //
  // Rejecting it here is what makes the downstream guard work. The client
  // refuses to broaden a rejected cluster into whole-rotation review, so an
  // impossible scope now surfaces as "unavailable" rather than silently
  // becoming a generic session — which is what a learner experiences as their
  // topic square serving them something else.
  //
  // An EMPTY map means "unknown", not "nothing is valid": callers without the
  // lookup keep the old format-only behaviour rather than losing every scoped
  // link.
  const cluster = searchParams.get('cluster');
  if (intent.rotation && cluster && CLUSTER_ID_RE.test(cluster)) {
    const clusterRotations = reviewClusterRotations[cluster];
    if (!clusterRotations || clusterRotations.includes(intent.rotation)) {
      intent.cluster = cluster;
    }
  }

  const topics = searchParams.get('topics');
  if (
    intent.rotation
    && topics
    && reviewTopicRotations[topics] === intent.rotation
  ) {
    intent.topics = [topics];
  }

  return intent;
}

/** Build every review CTA against the same canonical root-query contract. */
export function buildReviewHref(
  intent: ReviewIntent,
  reviewTopicRotations: ReviewTopicRotations = {},
): string {
  const params = new URLSearchParams();
  if (intent.rotation) params.set('rotation', intent.rotation);
  if (intent.week !== undefined) params.set('week', String(intent.week));
  if (intent.filter) params.set('filter', intent.filter);
  if (intent.itemType) params.set('type', intent.itemType);
  if (intent.rotation && intent.cluster) params.set('cluster', intent.cluster);
  const topics = intent.rotation
    ? intent.topics?.filter((topic) => (
        reviewTopicRotations[topic] === intent.rotation
      ))
    : undefined;
  if (topics?.length === 1) params.set('topics', topics[0]);
  const query = params.toString();
  return query ? `/?${query}` : '/';
}
