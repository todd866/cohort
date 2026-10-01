/**
 * Naive-concept pre-teach.
 *
 * For any concept the user has zero prior exposure to (exposureCount === 0),
 * inject a complexity-1 teaching card BEFORE the scheduler's regular item
 * pick — so the first encounter with a new concept is a teaching moment,
 * not a cold test.
 *
 * Why this exists
 *   The historical bug: a naive user encounters concept X via a C2/C3
 *   item from the regular fill loop. They fail it. The "preemptive
 *   scaffold" pairs a C1 *after* the failed item — too late; the
 *   conceptual cold-start damage is already done. With ~60% of items
 *   labelled C1 being empirically hard (see commit 4d863d17), even
 *   pairing a C1 doesn't guarantee teaching — it might be another
 *   stealth test. Pre-teach prepends explicit teaching content
 *   *before* any test pressure.
 *
 * Why not also videos
 *   Videos make sense for naive concepts (full visual + audio intro)
 *   but the existing video pre-teach (section 7a in unified-scheduler.ts)
 *   already targets `recallOnExamDay < 0.4 && confidence < 0.6` which
 *   captures naive concepts plus struggling-after-exposure ones. We
 *   leave videos to that path; this hook handles the card fallback when
 *   no video is available.
 *
 * Pure function, given bulk + naive concept candidates. Caller decides
 * when to run it (between section 7a and 7b in the scheduler), how many
 * to inject (`maxPreTeach`), and what the addItem callback does.
 */

import type { BulkCandidates, BulkCardRow } from '@/lib/knowledge/bulk-candidates';

const SCAFFOLD_COMPLEXITY = 1;

export interface NaivePreTeachConcept {
  conceptId: string;
  conceptName: string;
  topics: string[];
  priority: number;
}

export interface NaivePreTeachPick {
  conceptId: string;
  conceptName: string;
  priority: number;
  card: BulkCardRow;
}

export interface NaivePreTeachOptions {
  /** Cap insertions per session. Default 3 — generous enough for a
   *  research-block user with multiple new rotations, bounded enough
   *  not to crowd out the regular fill loop. */
  maxPreTeach?: number;
  /** Card IDs already selected by earlier scheduler sections (videos);
   *  pre-teach won't re-pick them. */
  alreadySelectedCardIds?: Set<string>;
}

function topicsOverlap(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length === 0) return false;
  const bLower = new Set(b.map((t) => t.toLowerCase()));
  for (const t of a) if (bLower.has(t.toLowerCase())) return true;
  return false;
}

/**
 * Pick one C1 card per naive concept, up to maxPreTeach. Returns the picks
 * in the order they should be injected. Caller is responsible for actually
 * adding them via its own addItem path (so quota tracking + selectedItem
 * sets stay consistent with the rest of the scheduler).
 */
export function pickNaivePreTeachCards(
  naiveConcepts: readonly NaivePreTeachConcept[],
  bulk: Pick<BulkCandidates, 'unseenCards'>,
  options: NaivePreTeachOptions = {},
): NaivePreTeachPick[] {
  const maxPreTeach = options.maxPreTeach ?? 3;
  if (maxPreTeach <= 0 || naiveConcepts.length === 0 || bulk.unseenCards.length === 0) {
    return [];
  }

  const used = new Set<string>(options.alreadySelectedCardIds ?? []);
  const candidateScaffolds = bulk.unseenCards.filter(
    (c) => c.complexity === SCAFFOLD_COMPLEXITY,
  );
  if (candidateScaffolds.length === 0) return [];

  // Naive concepts are processed in priority order. Tie-broken by name for
  // stable behaviour across runs (otherwise concept ordering depends on
  // Map iteration order which is technically undefined in some engines).
  const ordered = [...naiveConcepts].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.conceptName.localeCompare(b.conceptName);
  });

  const picks: NaivePreTeachPick[] = [];
  for (const concept of ordered) {
    if (picks.length >= maxPreTeach) break;
    const scaffold = candidateScaffolds.find(
      (c) => !used.has(c.id) && topicsOverlap(concept.topics, c.topics),
    );
    if (!scaffold) continue;
    used.add(scaffold.id);
    picks.push({
      conceptId: concept.conceptId,
      conceptName: concept.conceptName,
      priority: concept.priority,
      card: scaffold,
    });
  }

  return picks;
}
