import { GLOSSARY } from './glossary';

/**
 * Exact-token matching for item-authored hover decodes. An explicit map is
 * authoritative, including {}. Only unmigrated null/undefined maps use the
 * legacy obscure-term glossary and its English-follower guard.
 */
export type GlossarySegment =
  | { type: 'text'; value: string }
  | { type: 'term'; value: string; abbr: string; expansion?: string };

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

export function tokenizeGlossaryTerms(text: string, abbreviations?: Readonly<Record<string, string>> | null): GlossarySegment[] {
  if (!text) return [{ type: 'text', value: text }];
  const segments: GlossarySegment[] = [];
  let last = 0;
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0];
    // Existing unmigrated content retains the legacy curated glossary. Once
    // authored, the item's map is complete: no missing key falls back globally.
    const itemScoped = abbreviations != null;
    const expansion = itemScoped && Object.hasOwn(abbreviations, word)
      ? abbreviations[word] : undefined;
    if (itemScoped ? typeof expansion !== 'string' || !expansion.trim() : !DECODE_KEY_SET.has(word)) continue;
    const index = match.index ?? 0;
    if (suppressedByFollower(word, text, index + word.length)) continue;
    if (index > last) segments.push({ type: 'text', value: text.slice(last, index) });
    segments.push({ type: 'term', value: word, abbr: word, ...(itemScoped ? { expansion } : {}) });
    last = index + word.length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments.length > 0 ? segments : [{ type: 'text', value: text }];
}
