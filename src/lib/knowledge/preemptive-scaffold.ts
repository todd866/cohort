/**
 * Pre-emptive scaffold pairing.
 *
 * Walk-audit's `no-scaffolding-on-fail` pathology measures whether a
 * complexity-1 card immediately follows each missed item. The existing
 * struggle-intervention pipeline only scaffolds items the user has
 * historically struggled with — first-encounter misses get nothing.
 *
 * This pass plugs that gap by inserting a topic-matched complexity-1 card
 * right after each high-test-pressure item — questions and complexity ≥ 2
 * cards alike. If the user misses, the next item is already a teaching
 * card. If they get it right, the C1 follows as reinforcement — small
 * cost, real upside.
 *
 * Cap scales with the number of eligible anchors: small sessions still get
 * ≥2 pairings, big sessions get more help. Hard ceiling at items.length/4
 * to keep queue growth bounded.
 *
 * When a pairable anchor exists but no topic-matched scaffold can be
 * found, the gap is recorded via `recordGap` so `scripts/ops/scaffold-needs`
 * can surface real demand instead of silent failure. Per-session topic
 * deduplication avoids logging the same missing topic ten times in a
 * single queue.
 *
 * Distinct from `applyStruggleInterventions`, which targets pre-known
 * stuck cards. This is the in-session safety net for first encounters.
 *
 * See:
 *   docs/designs/2026-04-17-scheduler-walk-audit.md
 *   docs/superpowers/specs/2026-05-03-paam-scaffolding-loop-design.md
 *   project_scheduler_no_reactive_scaffold (memory, 2026-04-29)
 */

import { shuffleWithSeed } from '@/lib/utils/shuffle';
import { isCardDueForSelection } from './card-due-eligibility';
import { specificClinicalTopics } from './specific-topic-overlap';
import type { BulkCandidates } from './bulk-candidates';
import type { UnifiedSessionItem } from './unified-scheduler';

/** Minimal candidate shape shared by DB-backed manifold rows and static
 * content-map cards on the instant path. */
export interface ScaffoldCandidateCard {
  id: string;
  clusterId: string | null;
  topics: string[];
  complexity: number;
  /** Cloze sibling identity. Real scheduler/static-map candidates carry this;
   *  optional keeps the lane-compatible shape tolerant of legacy fixtures. */
  variantGroupId?: string | null;
}

export interface ScaffoldCandidatePool {
  rotation: string;
  candidateCards: ReadonlyArray<ScaffoldCandidateCard>;
}

export interface ScaffoldGapRecord {
  rotation: string;
  topics: string[];
  anchorItemId: string;
  anchorItemType: 'card' | 'question';
  anchorComplexity: number | null;
  /**
   * Concept of the anchor item that triggered the gap. Threaded through so the
   * persisted ContentGap row can join to Concept instead of being a
   * conceptId:null row. Empty-string conceptIds (paired scaffolds carry '') are
   * normalised to null by the caller.
   */
  anchorConceptId: string | null;
}

export interface PreemptiveScaffoldOpts {
  /**
   * Candidate matching key. Topic matching preserves the historical behavior;
   * cluster matching requires an exact, non-null cluster id on both sides and
   * never falls back to topics.
   */
  matchBy?: 'topic' | 'cluster';
  /**
   * Hard cap on insertions per session. If omitted, derived from anchor
   * count: max(2, floor(anchors/3)), then clamped to floor(items/4) so
   * queue growth stays bounded.
   */
  maxPairings?: number;
  /**
   * Optional callback invoked once per missing-topic when a pairable
   * anchor finds no topic-matched scaffold. Per-session deduplication
   * by topic key. Errors are not caught here — caller should pass a
   * callback that handles its own failure modes (fire-and-forget).
   */
  recordGap?: (gap: ScaffoldGapRecord) => void;
  /**
   * Per-session rotation seed (session id, batch id — anything that changes
   * between sessions but is stable within one).
   *
   * WHY THIS EXISTS. Candidate scaffolds used to be consumed with `.find()`
   * over a fixed build-order array, so the lowest-index eligible C1 became the
   * PERMANENT scaffold for its cluster and was re-inserted every single
   * session. Measured 2026-08-19 on the CAH corpus: one C1 emollients card
   * served 18× in ten weeks — the most-repeated card in the corpus — and the
   * `preemptive_scaffold` lane overall ran 4.26 serves/card against 1.41 on
   * the normal fill lane, taking 33% of serves from 12.7% of the pool.
   *
   * Seeding a shuffle spreads the load across equally-eligible scaffolds at
   * zero query cost, which matters because this runs on the request path
   * (.claude/rules/hot-path-latency.md). Omit for the legacy fixed order.
   */
  rotationSeed?: string;
  /**
   * Optional `cardId → CardProgress.nextDueAt` for the candidate scaffolds.
   *
   * The scaffold pass runs AFTER every selection gate and pulls from a raw
   * pool, so it bypasses the SRS due-gate that `bulk-candidates` applies at
   * pool construction (see card-due-eligibility.ts). That is how a card the
   * learner demonstrably knows — 5/7 correct, 17-day stability — kept arriving
   * as a *teaching* insert.
   *
   * A missing entry means "never seen", which stays eligible. Omit the whole
   * map and the pass degrades to no due-gate rather than blocking on a query:
   * the request degrades, it does not wait.
   */
  scaffoldDueAt?: ReadonlyMap<string, Date | null>;
  /** Injectable clock for the due-gate. Defaults to now. */
  now?: Date;
  /**
   * Concepts whose high-complexity item was just missed. A building block is
   * inserted only for those. Omit to keep the historical "pair every anchor"
   * behaviour. An empty set inserts nothing: a correct frontier card is not
   * followed by a cloze.
   */
  stepDownConceptIds?: ReadonlySet<string>;
}

const SCAFFOLD_COMPLEXITY = 1;
const MIN_ANCHOR_COMPLEXITY_FOR_CARDS = 2;
// Queue-growth cap: scaffold pass may grow the queue by up to items/CAP_DIVISOR
// items. Tightening this divisor is the single lever for trading session bloat
// against scaffolding-rate-after-miss. 2026-05-07: lowered from 4 → 3 (≈33%
// bloat allowed) so the post-miss-scaffolding metric clears the audit threshold
// in mid-length sessions where K=2 was leaving misses 3+ unscaffolded.
const QUEUE_GROWTH_CAP_DIVISOR = 3;

type SpecificTopicCache = Map<readonly string[], ReadonlySet<string>>;

function topicsOverlap(
  a: string[] | undefined,
  b: string[],
  cache: SpecificTopicCache,
): boolean {
  if (!a?.length) return false;
  const topicsFor = (topics: readonly string[]): ReadonlySet<string> => {
    const cached = cache.get(topics);
    if (cached) return cached;
    const specific = specificClinicalTopics(topics);
    cache.set(topics, specific);
    return specific;
  };
  const left = topicsFor(a);
  return [...topicsFor(b)].some(topic => left.has(topic));
}

/** Single definition of "this C1 card scaffolds this anchor", shared by the
 *  pick and the authoring-gap check so the two can never disagree. */
function matchesAnchor(
  item: PairableItem,
  card: ScaffoldCandidateCard,
  matchBy: NonNullable<PreemptiveScaffoldOpts['matchBy']>,
  topicCache: SpecificTopicCache,
): boolean {
  if (matchBy === 'cluster') {
    return item.clusterId != null && card.clusterId != null && item.clusterId === card.clusterId;
  }
  return topicsOverlap(item.topics, card.topics, topicCache);
}

function bulkCardToSessionItem(
  card: ScaffoldCandidateCard,
  rotation: string,
  anchor: Pick<PairableItem, 'id' | 'conceptId'> & { conceptName?: string },
): UnifiedSessionItem {
  return {
    type: 'card',
    id: card.id,
    rotation,
    priority: 0.5,
    // Attribute the scaffold to its anchor concept. The final scheduler cap
    // needs this identity to count injected teaching cards against the same
    // concept budget as the item they support.
    conceptId: anchor.conceptId ?? '',
    conceptName: anchor.conceptName ?? '',
    topics: card.topics,
    complexity: card.complexity,
    clusterId: card.clusterId,
    variantGroupId: card.variantGroupId ?? null,
    interventionReason: 'preemptive_scaffold',
    struggleIntervention: {
      strategy: 'preemptive',
      isScaffold: true,
      targetCardId: anchor.id,
    },
  } satisfies UnifiedSessionItem;
}

type PairableItem = {
  type: string;
  id: string;
  rotation?: string;
  topics?: string[];
  complexity?: number;
  conceptId?: string;
  clusterId?: string | null;
  variantGroupId?: string | null;
};

type AnchorItem = PairableItem & { type: 'card' | 'question' };

function hasMatchKey(
  item: PairableItem,
  matchBy: NonNullable<PreemptiveScaffoldOpts['matchBy']>,
): boolean {
  if (matchBy === 'cluster') return item.clusterId != null;
  return specificClinicalTopics(item.topics ?? []).size > 0;
}

function isAnchor(
  item: PairableItem,
  matchBy: NonNullable<PreemptiveScaffoldOpts['matchBy']>,
): item is AnchorItem {
  // Questions are pure test items with no internal scaffolding tier — every
  // question is a pairing anchor regardless of difficulty.
  if (item.type === 'question') {
    return hasMatchKey(item, matchBy);
  }
  // Cards: only pair after high-pressure items. C1 cards are themselves
  // scaffolds — pairing another C1 after them is redundant. Untagged
  // cards (null/0) have unknown difficulty so we skip them too.
  if (item.type === 'card') {
    if (item.complexity == null || item.complexity < MIN_ANCHOR_COMPLEXITY_FOR_CARDS) {
      return false;
    }
    return hasMatchKey(item, matchBy);
  }
  return false;
}

function deriveCap(
  items: PairableItem[],
  matchBy: NonNullable<PreemptiveScaffoldOpts['matchBy']>,
): number {
  const anchors = items.reduce((acc, it) => acc + (isAnchor(it, matchBy) ? 1 : 0), 0);
  // Target: pair every anchor where a topic-matched scaffold exists. This is
  // the full-reactive ideal — every miss is immediately followed by a teaching
  // card. Earlier policy (anchors/3) capped pairings at ~33% of anchors so
  // anchor 4+ in a session was unscaffolded; the audit's post-miss-scaffolding
  // rate then sat well below the 0.2 floor when miss-heavy sessions hit those
  // late anchors. The QUEUE_GROWTH_CAP_DIVISOR ceiling is the safety brake
  // that keeps session bloat bounded.
  const scaled = Math.max(2, anchors);
  const ceiling = Math.floor(items.length / QUEUE_GROWTH_CAP_DIVISOR);
  // Always allow at least 2 even on tiny queues — the ceiling is an upper
  // bound for queue-growth control, not a lower bound for fix usefulness.
  return Math.max(2, Math.min(scaled, Math.max(2, ceiling)));
}

export interface PreemptiveScaffoldInsertion {
  /** Zero-based index in the original item list after which to insert. */
  afterIndex: number;
  card: ScaffoldCandidateCard;
  rotation: string;
  anchorItemId: string;
  anchorConceptId: string;
  anchorConceptName: string;
}

/**
 * Plan scaffold insertions without deciding how a serving lane hydrates the
 * selected card. The manifold wrapper below converts DB rows to scheduler
 * items; the instant lane hydrates static cards through its signed-image path.
 * Keeping candidate choice here prevents the two lanes' pairing policy from
 * drifting.
 */
export function planPreemptiveScaffoldInsertions<T extends PairableItem>(
  items: T[],
  pool: ScaffoldCandidatePool,
  opts: PreemptiveScaffoldOpts = {},
): PreemptiveScaffoldInsertion[] {
  const matchBy = opts.matchBy ?? 'topic';
  if (opts.stepDownConceptIds && opts.stepDownConceptIds.size === 0) return [];
  // Normalize each item's topics once per plan, not once per candidate pair.
  const topicCache: SpecificTopicCache = new Map();
  const maxPairings = opts.maxPairings ?? deriveCap(items, matchBy);
  if (maxPairings <= 0 || items.length === 0 || pool.candidateCards.length === 0) return [];

  const allScaffolds = pool.candidateCards.filter(
    (card) => card.complexity === SCAFFOLD_COMPLEXITY,
  );
  // Due-gate first, then rotate. Both are no-ops unless the caller opts in, so
  // an un-migrated lane keeps its previous behaviour instead of silently
  // changing selection.
  const now = opts.now ?? new Date();
  const dueAt = opts.scaffoldDueAt;
  const dueScaffolds = dueAt
    ? allScaffolds.filter((card) => isCardDueForSelection(dueAt.get(card.id), now))
    : allScaffolds;
  const candidateScaffolds = opts.rotationSeed
    ? shuffleWithSeed(dueScaffolds, opts.rotationSeed)
    : dueScaffolds;
  // `allScaffolds` (pre-due-gate) is what decides whether an unpaired anchor is
  // a genuine AUTHORING gap. A scaffold that exists but is parked until its due
  // date is a serving decision, and reporting it as missing content is how a
  // scheduler defect gets laundered into a request to write more cards.
  const scaffoldExistsIgnoringDueGate = (item: PairableItem): boolean =>
    allScaffolds.some((card) => matchesAnchor(item, card, matchBy, topicCache));
  if (allScaffolds.length === 0) {
    // Still record gaps so the dashboard knows demand exists even when the
    // candidate pool has no scaffolds at all.
    if (opts.recordGap) {
      const seenTopics = new Set<string>();
      for (const item of items) {
        if (!isAnchor(item, matchBy)) continue;
        const topics = item.topics ?? [];
        const gapKey = matchBy === 'cluster'
          ? `cluster:${item.clusterId}`
          : topics.slice().sort().join('|');
        if (seenTopics.has(gapKey)) continue;
        seenTopics.add(gapKey);
        opts.recordGap({
          rotation: item.rotation ?? pool.rotation,
          topics,
          anchorItemId: item.id,
          anchorItemType: item.type,
          anchorComplexity: item.complexity ?? null,
          anchorConceptId: item.conceptId || null,
        });
      }
    }
    return [];
  }

  const usedScaffoldIds = new Set<string>();
  // Avoid pairing items that are already in the session (e.g. already on a C1
  // earlier in the queue or already enqueued elsewhere).
  const presentItemIds = new Set(items.map((item) => item.id));
  // The normal-feed selector enforces at most one card per variant group, but
  // this planner runs after that selection pass. Seed its own set from every
  // card already committed to the session and extend it as scaffolds are
  // planned so late insertion cannot bypass the session-wide guarantee.
  const selectedCardVariantGroups = new Set(
    items.flatMap((item) =>
      item.type === 'card' && item.variantGroupId ? [item.variantGroupId] : [],
    ),
  );
  // Per-session dedupe: only log a gap once per unique topic-set.
  const gapTopicsLogged = new Set<string>();
  const insertions: PreemptiveScaffoldInsertion[] = [];

  for (let i = 0; i < items.length; i++) {
    if (insertions.length >= maxPairings) break;
    const item = items[i];
    if (!isAnchor(item, matchBy)) continue;
    if (opts.stepDownConceptIds && !opts.stepDownConceptIds.has(item.conceptId ?? '')) continue;

    // If the next item is already a complexity-1 card, the existing ordering
    // already provides scaffolding — don't pair redundantly.
    const next = items[i + 1];
    if (next && next.type === 'card' && next.complexity === SCAFFOLD_COMPLEXITY) {
      continue;
    }

    const scaffold = candidateScaffolds.find(
      (card) =>
        !usedScaffoldIds.has(card.id) &&
        !presentItemIds.has(card.id) &&
        (!card.variantGroupId || !selectedCardVariantGroups.has(card.variantGroupId)) &&
        matchesAnchor(item, card, matchBy, topicCache),
    );
    if (!scaffold) {
      // Only a true content gap counts. If a matching scaffold exists but the
      // due-gate parked it, stay silent — see scaffoldExistsIgnoringDueGate.
      if (opts.recordGap && !scaffoldExistsIgnoringDueGate(item)) {
        const topics = item.topics ?? [];
        const gapKey = matchBy === 'cluster'
          ? `cluster:${item.clusterId}`
          : topics.slice().sort().join('|');
        if (!gapTopicsLogged.has(gapKey)) {
          gapTopicsLogged.add(gapKey);
          opts.recordGap({
            rotation: item.rotation ?? pool.rotation,
            topics,
            anchorItemId: item.id,
            anchorItemType: item.type,
            anchorComplexity: item.complexity ?? null,
            anchorConceptId: item.conceptId || null,
          });
        }
      }
      continue;
    }

    usedScaffoldIds.add(scaffold.id);
    if (scaffold.variantGroupId) selectedCardVariantGroups.add(scaffold.variantGroupId);
    insertions.push({
      afterIndex: i,
      card: scaffold,
      rotation: item.rotation ?? pool.rotation,
      anchorItemId: item.id,
      anchorConceptId: item.conceptId ?? '',
      anchorConceptName: 'conceptName' in item && typeof item.conceptName === 'string'
        ? item.conceptName
        : '',
    });
  }

  return insertions;
}

/**
 * Insert a topic-matched complexity-1 card right after each high-test-pressure
 * anchor (question or C≥2 card), up to the derived cap. See file header for
 * rationale.
 */
export function injectPreemptiveScaffolds(
  items: UnifiedSessionItem[],
  bulk: Pick<BulkCandidates, 'rotation' | 'unseenCards'>,
  opts: PreemptiveScaffoldOpts = {},
): UnifiedSessionItem[] {
  return injectPreemptiveScaffoldsFromPool(items, {
    rotation: bulk.rotation,
    candidateCards: bulk.unseenCards,
  }, opts);
}

/**
 * Insert matching complexity-1 cards from a lane-agnostic candidate pool.
 * Callers choose topic matching (the default) or strict cluster matching via
 * `opts.matchBy` without having to construct the full bulk-candidate object.
 */
export function injectPreemptiveScaffoldsFromPool(
  items: UnifiedSessionItem[],
  pool: ScaffoldCandidatePool,
  opts: PreemptiveScaffoldOpts = {},
): UnifiedSessionItem[] {
  const insertions = planPreemptiveScaffoldInsertions(items, {
    rotation: pool.rotation,
    candidateCards: pool.candidateCards,
  }, opts);
  if (insertions.length === 0) return items;

  const insertionByIndex = new Map(insertions.map((insertion) => [insertion.afterIndex, insertion]));
  const out: UnifiedSessionItem[] = [];
  for (let i = 0; i < items.length; i++) {
    out.push(items[i]);
    const insertion = insertionByIndex.get(i);
    if (insertion) {
      out.push(bulkCardToSessionItem(insertion.card, insertion.rotation, {
        id: insertion.anchorItemId,
        conceptId: insertion.anchorConceptId,
        conceptName: insertion.anchorConceptName,
      }));
    }
  }

  return out;
}
