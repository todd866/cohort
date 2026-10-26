/**
 * Strand mix for decks that prepare for more than one kind of exam.
 *
 * A deck can serve several different exams from one pool. The first-year deck
 * (`md1-foundations`) prepares for KAT4, a written knowledge test, the MMCA, a
 * clinical-skills assessment, and AHCT 4, prosection identification. Its pool holds several exam items to
 * every clinical-skills item, so a ranker that knows nothing about the split
 * can fill a whole session from the larger strand. Nothing about any
 * individual item is wrong when that happens; the mix was simply nobody's job.
 *
 * This module is that job, and only that. It decides strand membership from
 * fields already on the candidate (rotation and source file), so it costs no
 * query, and it acts on ordering and selection among items every other gate
 * (access, due, rights, repetition, quality, difficulty) has already admitted.
 * When a strand has no eligible item the other strand fills the seat: the mix
 * never shortens or empties a session.
 *
 * The same two functions run in every delivery path that serves a configured
 * deck (live, cached queue build, offline pack, instant), so the policy cannot
 * differ between them.
 */

import { hashString } from '@/lib/utils/hash';

/** The fields strand membership may read. Both already ride on every candidate. */
export interface StrandIdentity {
  rotation?: string | null;
  sourceFile?: string | null;
}

export interface DeckStrand {
  readonly id: string;
  /** Target share of served items, 0..1. A deck's shares sum to 1. */
  readonly share: number;
  /** Membership. The LAST strand of a deck is the default and should match everything. */
  readonly matches: (item: StrandIdentity) => boolean;
}

export interface DeckStrandMix {
  readonly strands: readonly DeckStrand[];
}

/** The file name without its directory: question source files carry their bank path. */
function sourceBasename(sourceFile: string | null | undefined): string {
  if (!sourceFile) return '';
  const slash = sourceFile.lastIndexOf('/');
  return slash >= 0 ? sourceFile.slice(slash + 1) : sourceFile;
}

const MD1_DECK = 'md1-foundations';

/**
 * The companion sources that contribute clinical-skills material to the
 * first-year deck: the examination text, the examination clips and the
 * station checklists. The deck's other companions (the Year 1 and Year 2 KAT
 * banks) are exam material. Each still contributes only the items that name
 * the deck in moduleNodes; this list classifies, it grants nothing.
 */
const MD1_MMCA_COMPANION_ROTATIONS: ReadonlySet<string> = new Set([
  'physical-exam', 'toc', 'cah', 'surgical-sciences',
]);

function isMd1MmcaItem(item: StrandIdentity): boolean {
  const rotation = item.rotation ?? null;
  if (rotation && MD1_MMCA_COMPANION_ROTATIONS.has(rotation)) return true;
  // Native MMCA files are `mmca`, `mmca-histories`, `mmca-procedures-2`, ...;
  // the MMCA question bank is `mmca-findings.v1.json`. `kat4-mmca2` is a KAT4
  // paper about MMCA2 procedures, so it is matched by prefix, not substring.
  return rotation === MD1_DECK && sourceBasename(item.sourceFile).startsWith('mmca');
}

/**
 * The deck's third exam is AHCT 4, an anatomy and histology identification
 * test (owner, 2026-10-22). Its material is the Rohen prosection plates whose
 * regions the generator tags for the deck (generate-rohen-cards.py,
 * MD1_AHCT_REGIONS); they keep the `anatomy` rotation.
 */
function isMd1AhctItem(item: StrandIdentity): boolean {
  return item.rotation === 'anatomy';
}

export const DECK_STRAND_MIX: Readonly<Record<string, DeckStrandMix>> = Object.freeze({
  [MD1_DECK]: Object.freeze({
    strands: Object.freeze([
      Object.freeze({ id: 'mmca', share: 0.35, matches: isMd1MmcaItem }),
      Object.freeze({ id: 'ahct', share: 0.15, matches: isMd1AhctItem }),
      Object.freeze({ id: 'exam', share: 0.5, matches: () => true }),
    ]),
  }),
});

export function deckStrandMixFor(deck: string | null | undefined): DeckStrandMix | null {
  if (!deck || !Object.hasOwn(DECK_STRAND_MIX, deck)) return null;
  return DECK_STRAND_MIX[deck];
}

export function deckStrandOf(mix: DeckStrandMix, item: StrandIdentity): string {
  for (const strand of mix.strands) {
    if (strand.matches(item)) return strand.id;
  }
  return mix.strands[mix.strands.length - 1].id;
}

/** Whole seats per strand for `seats` items, by largest remainder (earlier strands win ties). */
export function strandSeatTargets(mix: DeckStrandMix, seats: number): Map<string, number> {
  const total = Math.max(0, Math.floor(seats));
  const exact = mix.strands.map((strand, index) => ({ id: strand.id, index, value: strand.share * total }));
  const targets = new Map(exact.map((entry) => [entry.id, Math.floor(entry.value)]));
  let assigned = [...targets.values()].reduce((sum, value) => sum + value, 0);
  const byRemainder = [...exact].sort((left, right) => (
    (right.value - Math.floor(right.value)) - (left.value - Math.floor(left.value)) || left.index - right.index
  ));
  for (const entry of byRemainder) {
    if (assigned >= total) break;
    targets.set(entry.id, (targets.get(entry.id) ?? 0) + 1);
    assigned += 1;
  }
  return targets;
}

/**
 * Strand identity of a delivered session item. Native items carry their source
 * file in the deck's content map; companion items are told apart by rotation.
 */
export function sessionItemStrandIdentity(
  item: { type: string; id: string; rotation?: string | null },
  content: {
    cards: Readonly<Record<string, { sourceFile?: string | null } | undefined>>;
    questions: Readonly<Record<string, { sourceFile?: string | null } | undefined>>;
  },
  sessionRotation: string,
): StrandIdentity {
  const source = item.type === 'question' ? content.questions[item.id] : content.cards[item.id];
  return { rotation: item.rotation ?? sessionRotation, sourceFile: source?.sourceFile ?? null };
}

export interface OrderByDeckStrandsOptions<T> {
  deck: string | null | undefined;
  /** Per-session seed (the session id). Sets the phase of the interleave. */
  seed: string;
  identify: (item: T) => StrandIdentity;
  /**
   * Items that must stay directly behind the item before them, such as a
   * scaffold paired with its anchor. They move with it as one unit.
   */
  keepWithPrevious?: (item: T, previous: T) => boolean;
  /**
   * `target` (default) interleaves at the configured shares: right for a
   * candidate pool, whose prefix becomes the selection. `present` interleaves
   * at the shares actually in `items`: right for an already-selected batch,
   * where it spreads a short strand evenly instead of front-loading it.
   */
  shareBasis?: 'target' | 'present';
}

/**
 * Reorder `items` so every prefix, and every window, holds each strand close to
 * its share while that strand has supply. Within a strand the caller's order is
 * kept exactly, so whatever ranking produced `items` still decides which item
 * of a strand comes first. Returns a permutation: nothing is added or dropped.
 *
 * The interleave is the smooth weighted round-robin (pick the strand furthest
 * below its share), started at a seeded phase so the opening strand varies
 * between sessions instead of always being the same one.
 */
export function orderByDeckStrands<T>(items: readonly T[], options: OrderByDeckStrandsOptions<T>): T[] {
  const mix = deckStrandMixFor(options.deck);
  if (!mix || items.length < 2) return items as T[];

  // Units: an item plus the items glued behind it.
  const units: Array<{ strand: string; items: T[] }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const previousUnit = units[units.length - 1];
    if (previousUnit && index > 0 && options.keepWithPrevious?.(item, items[index - 1])) {
      previousUnit.items.push(item);
      continue;
    }
    units.push({ strand: deckStrandOf(mix, options.identify(item)), items: [item] });
  }

  const queues = new Map(mix.strands.map((strand) => [strand.id, [] as Array<{ strand: string; items: T[] }>]));
  for (const unit of units) queues.get(unit.strand)?.push(unit);
  if ([...queues.values()].filter((queue) => queue.length > 0).length < 2) return items as T[];

  const presentCount = new Map<string, number>();
  for (const unit of units) presentCount.set(unit.strand, (presentCount.get(unit.strand) ?? 0) + unit.items.length);
  const shareOf = (strand: DeckStrand): number => (
    options.shareBasis === 'present' ? (presentCount.get(strand.id) ?? 0) / items.length : strand.share
  );
  const emitted = new Map(mix.strands.map((strand) => [strand.id, 0]));
  let total = 0;
  const choose = (available: (strandId: string) => boolean): string | null => {
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const strand of mix.strands) {
      if (!available(strand.id)) continue;
      const score = shareOf(strand) * (total + 1) - (emitted.get(strand.id) ?? 0);
      if (score > bestScore + 1e-9) {
        best = strand.id;
        bestScore = score;
      }
    }
    return best;
  };

  // Seeded phase: advance the same sequence a few virtual steps first. The
  // sequence is balanced from any starting point, so this only rotates it.
  const phase = hashString(`${options.seed}\0deck-strand-phase`) % 10;
  for (let step = 0; step < phase; step += 1) {
    const strand = choose(() => true);
    if (!strand) break;
    emitted.set(strand, (emitted.get(strand) ?? 0) + 1);
    total += 1;
  }

  const out: T[] = [];
  const cursor = new Map(mix.strands.map((strand) => [strand.id, 0]));
  while (out.length < items.length) {
    const strand = choose((id) => (cursor.get(id) ?? 0) < (queues.get(id)?.length ?? 0));
    if (!strand) break;
    const position = cursor.get(strand) ?? 0;
    const unit = queues.get(strand)![position];
    cursor.set(strand, position + 1);
    for (const item of unit.items) {
      out.push(item);
      const itemStrand = deckStrandOf(mix, options.identify(item));
      emitted.set(itemStrand, (emitted.get(itemStrand) ?? 0) + 1);
      total += 1;
    }
  }
  return out;
}

export interface SelectByDeckStrandsOptions<T> {
  deck: string | null | undefined;
  identify: (item: T) => StrandIdentity;
  /** Items that are always kept (a due review), whatever their strand. */
  isPinned?: (item: T) => boolean;
}

/**
 * Choose `limit` items so the strands hold their shares where supply allows.
 * Pinned items are taken first and count towards their strand; each strand
 * then takes its remaining seats in caller order; any seat a strand cannot
 * fill goes to the next item in caller order. The result keeps caller order.
 */
export function selectByDeckStrands<T>(items: readonly T[], limit: number, options: SelectByDeckStrandsOptions<T>): T[] {
  const seats = Math.max(0, Math.floor(limit));
  const mix = deckStrandMixFor(options.deck);
  if (!mix) return items.slice(0, seats);
  if (items.length <= seats) return [...items];

  const chosen = new Set<number>();
  const targets = strandSeatTargets(mix, seats);
  const strandAt = items.map((item) => deckStrandOf(mix, options.identify(item)));
  for (let index = 0; index < items.length && chosen.size < seats; index += 1) {
    if (!options.isPinned?.(items[index])) continue;
    chosen.add(index);
    targets.set(strandAt[index], (targets.get(strandAt[index]) ?? 0) - 1);
  }
  for (let index = 0; index < items.length && chosen.size < seats; index += 1) {
    if (chosen.has(index)) continue;
    const remaining = targets.get(strandAt[index]) ?? 0;
    if (remaining <= 0) continue;
    chosen.add(index);
    targets.set(strandAt[index], remaining - 1);
  }
  for (let index = 0; index < items.length && chosen.size < seats; index += 1) {
    chosen.add(index);
  }
  return items.filter((_, index) => chosen.has(index));
}
