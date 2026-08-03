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

import type { BulkCandidates } from './bulk-candidates';
import type { UnifiedSessionItem } from './unified-scheduler';

/** Minimal candidate shape shared by DB-backed manifold rows and static
 * content-map cards on the instant path. */
export interface ScaffoldCandidateCard {
  id: string;
  clusterId: string | null;
  topics: string[];
  complexity: number;
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
}

const SCAFFOLD_COMPLEXITY = 1;
const MIN_ANCHOR_COMPLEXITY_FOR_CARDS = 2;
// Queue-growth cap: scaffold pass may grow the queue by up to items/CAP_DIVISOR
// items. Tightening this divisor is the single lever for trading session bloat
// against scaffolding-rate-after-miss. 2026-05-07: lowered from 4 → 3 (≈33%
// bloat allowed) so the post-miss-scaffolding metric clears the audit threshold
// in mid-length sessions where K=2 was leaving misses 3+ unscaffolded.
const QUEUE_GROWTH_CAP_DIVISOR = 3;

function topicsOverlap(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length === 0) return false;
  // Case-insensitive: question-bank JSON imports use lowercase topics
  // (e.g. "respiratory") while MDX <KeyPoint> blocks use TitleCase
  // ("Respiratory"). Without normalisation the bank questions never find
  // their topic-matched MDX scaffolds — measured 2026-05-07: 379 CAH topics
  // had C2+ anchors but ZERO C1 scaffolds purely because the topic strings
  // didn't compare equal.
  const bLower = new Set(b.map((t) => t.toLowerCase()));
  for (const t of a) if (bLower.has(t.toLowerCase())) return true;
  return false;
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
};

type AnchorItem = PairableItem & { type: 'card' | 'question' };

function hasMatchKey(
  item: PairableItem,
  matchBy: NonNullable<PreemptiveScaffoldOpts['matchBy']>,
): boolean {
  if (matchBy === 'cluster') return item.clusterId != null;
  return Boolean(item.topics && item.topics.length > 0);
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
  const maxPairings = opts.maxPairings ?? deriveCap(items, matchBy);
  if (maxPairings <= 0 || items.length === 0 || pool.candidateCards.length === 0) return [];

  const candidateScaffolds = pool.candidateCards.filter(
    (card) => card.complexity === SCAFFOLD_COMPLEXITY,
  );
  if (candidateScaffolds.length === 0) {
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
  // Per-session dedupe: only log a gap once per unique topic-set.
  const gapTopicsLogged = new Set<string>();
  const insertions: PreemptiveScaffoldInsertion[] = [];

  for (let i = 0; i < items.length; i++) {
    if (insertions.length >= maxPairings) break;
    const item = items[i];
    if (!isAnchor(item, matchBy)) continue;

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
        (matchBy === 'cluster'
          ? item.clusterId != null &&
            card.clusterId != null &&
            item.clusterId === card.clusterId
          : topicsOverlap(item.topics, card.topics)),
    );
    if (!scaffold) {
      if (opts.recordGap) {
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
