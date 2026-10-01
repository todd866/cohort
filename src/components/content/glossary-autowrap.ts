import { GLOSSARY } from './glossary';

/**
 * Render-time detection of OBSCURE glossary abbreviations in card text.
 *
 * Card fronts/contexts are stored as plain text (the seeder flattens authored
 * `<Term>` markup to the bare abbreviation), so the review feed needs render-time
 * detection to decode anything. This tokenizer re-detects glossary terms so they
 * can be wrapped in a hover-decode `<Term>` — without re-seeding.
 *
 * GATED, by design (the decode-everything version was retired 2026-06-11 as
 * visual noise — it font'd terms a student already knows, ECG/BP/IV):
 * - ONLY entries flagged `decode: true` match. Default-unset terms render plain.
 *   The flagged set is a curated handful of genuinely-obscure TLAs, which mostly
 *   sidesteps the English-collision problem (we never flag WHO/OR/AS etc.);
 * - case-sensitive, whole-word matches only (real uppercase TLAs, not English
 *   words that happen to spell a key);
 * - >=3 chars by default; curated 2-letter terms may opt in with `decode: true`;
 * - a key that DOES collide with an English word (ALL) carries a
 *   `decodeNotBefore` follower denylist. Suppression is the safe direction: a
 *   missed decode renders plain, a wrong one shows a false expansion.
 */
export type GlossarySegment =
  | { type: 'text'; value: string }
  | { type: 'term'; value: string; abbr: string };

// Decode-worthy keys as a Set for O(1) lookup. Deliberately NOT a giant
// alternation regex — a big alternation with look-arounds can segfault V8
// under the parallel test runner.
const DECODE_KEY_SET = new Set(
  Object.entries(GLOSSARY)
    .filter(([key, entry]) => key.length >= 2 && entry.decode === true)
    .map(([key]) => key),
);

// key -> lowercased follower words that mean "this is not the medical term".
const NOT_BEFORE = new Map<string, Set<string>>(
  Object.entries(GLOSSARY)
    .filter(([, entry]) => entry.decode === true && entry.decodeNotBefore?.length)
    .map(([key, entry]) => [key, new Set(entry.decodeNotBefore!.map((w) => w.toLowerCase()))]),
);

// The immediately-following word, ONLY when separated by a bare space run. A
// comma or full stop after the term means it is being used as a noun ("In ALL,
// the proliferating cell…"), not as ALL-CAPS emphasis ("ALL patients …").
const IMMEDIATE_FOLLOWER_RE = /^ +([A-Za-z][A-Za-z-]*)/;

function suppressedByFollower(key: string, text: string, afterIndex: number): boolean {
  const notBefore = NOT_BEFORE.get(key);
  if (!notBefore) return false;
  const follower = IMMEDIATE_FOLLOWER_RE.exec(text.slice(afterIndex));
  return follower ? notBefore.has(follower[1].toLowerCase()) : false;
}

// Word run = a letter/digit followed by letters/digits/internal hyphens, so
// hyphenated keys (M-CHAT, CA-125) match as one token while word boundaries
// are respected.
const WORD_RE = /[A-Za-z0-9][A-Za-z0-9-]*/g;

export function tokenizeGlossaryTerms(text: string): GlossarySegment[] {
  if (!text) return [{ type: 'text', value: text }];
  const segments: GlossarySegment[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0];
    if (!DECODE_KEY_SET.has(word)) continue; // case-sensitive exact key match
    const index = match.index ?? 0;
    if (suppressedByFollower(word, text, index + word.length)) continue;
    if (index > last) segments.push({ type: 'text', value: text.slice(last, index) });
    segments.push({ type: 'term', value: word, abbr: word });
    last = index + word.length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments.length > 0 ? segments : [{ type: 'text', value: text }];
}
