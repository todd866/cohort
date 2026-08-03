// Detect "rename-by-edit": when a card's front/back is edited, its content-hash
// stableId changes, so the seed mints a NEW card id and soft-deletes the OLD one
// — orphaning that user's CardProgress (scheduling history + flags) onto a dead
// card. This module identifies, safely, which soon-to-be-soft-deleted card is the
// same card as which freshly-seeded card, so the seed can carry progress forward.
//
// Identity is the "slot": everything in computeStableId EXCEPT the content
// (rotation, week, sourceFile, sourceComponent, cardType) plus the blank ordinal
// (which survives content edits because split-cloze variant ids are
// `${baseStableId}:blank-N` — see split-cloze-variants.ts). A slot is stable
// across an edit; only the content hash moves.
//
// Safety: we only pair when a slot has exactly ONE departing and ONE arriving
// card (ambiguous slots are skipped — never mis-assign), and a similarity guard
// rejects unrelated add/delete pairs that happen to land 1:1 in a coarse slot.
// Worst case is strictly better than the status quo, where every edit drops
// history unconditionally.

export interface RenameCandidate {
  id: string;
  stableId: string;
  rotation: string;
  week: number | null;
  sourceFile: string | null;
  sourceComponent: string | null;
  cardType: string;
  front: string;
  back: string | null;
  backs: string[];
}

export interface RenamePair {
  fromCardId: string;
  toCardId: string;
  key: string;
}

// Minimum front token-overlap (Jaccard) to accept a 1:1 slot pair as a rename,
// unless the answer is identical. Permissive on purpose: a reworded prompt keeps
// most of its words; only genuinely unrelated cards fall below this.
const MIN_FRONT_SIMILARITY = 0.2;

/** Blank index from a variant stableId (`...:blank-N`); 0 for a plain card. */
export function blankOrdinal(stableId: string): number {
  const m = /:blank-(\d+)$/.exec(stableId);
  return m ? Number(m[1]) : 0;
}

/** Content-independent identity for a card. Equal across a front/back edit. */
export function slotKey(c: RenameCandidate): string {
  return [
    c.rotation,
    c.week ?? '',
    c.sourceFile ?? '',
    c.sourceComponent ?? '',
    c.cardType,
    blankOrdinal(c.stableId),
  ].join('|');
}

// Function words inflate the overlap of unrelated prompts (e.g. two different
// signs that both read "X sign is ...") past the guard. Dropping them keeps the
// similarity signal on content words.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'in', 'on', 'at',
  'to', 'and', 'or', 'for', 'with', 'by', 'as', 'that', 'this', 'it', 'its',
]);

function tokenize(text: string): Set<string> {
  const stripped = text
    .replace(/\{\{c\d+::[^}]*\}\}/gi, ' ') // anki cloze
    .replace(/\[___+\]/g, ' ') // [___] blanks
    .toLowerCase();
  return new Set(stripped.split(/[^a-z0-9]+/).filter((t) => t.length > 0 && !STOPWORDS.has(t)));
}

/** Jaccard overlap of front word tokens (cloze markers ignored). 0..1. */
export function frontSimilarity(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizedAnswer(c: RenameCandidate): string {
  const parts = c.backs && c.backs.length > 0 ? c.backs : c.back ? [c.back] : [];
  return parts.map((p) => p.trim().toLowerCase()).join('|');
}

function isPlausibleSameCard(stale: RenameCandidate, live: RenameCandidate): boolean {
  if (frontSimilarity(stale.front, live.front) >= MIN_FRONT_SIMILARITY) return true;
  const a = normalizedAnswer(stale);
  return a.length > 0 && a === normalizedAnswer(live);
}

function groupByKey(cards: RenameCandidate[]): Map<string, RenameCandidate[]> {
  const m = new Map<string, RenameCandidate[]>();
  for (const c of cards) {
    const k = slotKey(c);
    const arr = m.get(k);
    if (arr) arr.push(c);
    else m.set(k, [c]);
  }
  return m;
}

/**
 * Pair soon-to-be-soft-deleted (stale) cards with freshly-seeded (live) cards
 * that occupy the same slot. `stale` and `live` MUST be disjoint card sets.
 * Returns only high-confidence 1:1 matches.
 */
export function matchRenamedCards(stale: RenameCandidate[], live: RenameCandidate[]): RenamePair[] {
  const liveByKey = groupByKey(live);
  const staleByKey = groupByKey(stale);
  const pairs: RenamePair[] = [];

  for (const [key, staleArr] of staleByKey) {
    const liveArr = liveByKey.get(key);
    if (!liveArr || staleArr.length !== 1 || liveArr.length !== 1) continue;
    const s = staleArr[0];
    const l = liveArr[0];
    if (s.id === l.id) continue;
    if (!isPlausibleSameCard(s, l)) continue;
    pairs.push({ fromCardId: s.id, toCardId: l.id, key });
  }

  return pairs;
}
