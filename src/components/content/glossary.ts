import glossaryData from './glossary-data.json';

/**
 * Medical terms/TLAs glossary
 * Add new terms here - they'll automatically work with the <Term> component
 *
 * NOTE: This static glossary is used as fallback when TermProvider context
 * is not available. The canonical source of truth is now the database,
 * seeded from this data via `npx prisma db seed`.
 *
 * CURATION: Only include terms where the tooltip adds value for a Year 3 med
 * student. Exclude universally known abbreviations (BP, HR, IV, ICU, ECG, etc.)
 * — highlighting them just adds noise.
 *
 * AMBIGUITY: Terms that collide with common English words or have multiple
 * medical meanings (e.g. CO = Cardiac Output vs Carbon Monoxide) should set
 * `autoDetect: false`. They'll still resolve via explicit `<Term abbr="CO">`
 * but won't be auto-highlighted by the regex. In MDX, use `<Term>` explicitly.
 * For DB-sourced text (questions/cards), inline markup is planned but not yet
 * implemented — for now, ambiguous terms simply won't get tooltips there.
 */

export type GlossaryEntry = {
  full: string;
  definition: string;
  related?: string[];
  /** Set false to suppress auto-detection — term is still available via explicit <Term>. */
  autoDetect?: boolean;
  /**
   * Opt-in hover-decode. ONLY entries with `decode: true` get the faint
   * dotted-underline + hover/tap tooltip — at render time (glossary-autowrap)
   * and for explicit `<Term>`. Reserved for genuinely-obscure TLAs a Year-3
   * student wouldn't instantly resolve (ITP, MMN, CIDP, CMAP…). Trivial terms
   * (ECG, BP, IV) leave it unset and render plain — this is what prevents the
   * visual noise that retired the old decode-everything style (2026-06-11).
   */
  decode?: boolean;
  /**
   * Suppress the decode when the term is immediately followed by one of these
   * words (single space, no intervening punctuation). For the one key that
   * collides with an English word — ALL, the leukaemia vs ALL-CAPS emphasis —
   * this keeps "ALL patients with diabetes" plain while "childhood ALL
   * prognosis" still decodes.
   *
   * Deliberately asymmetric: an over-eager guard renders plain text (harmless),
   * an under-eager one shows a student a wrong expansion. Prefer suppression.
   */
  decodeNotBefore?: string[];
};


export const GLOSSARY: Record<string, GlossaryEntry> = glossaryData as Record<string, GlossaryEntry>;


type GlossaryLookupResult = { abbr: string; entry: GlossaryEntry };

const CANONICAL_GLOSSARY_KEY_BY_UPPER: Record<string, string> = Object.create(null);
for (const key of Object.keys(GLOSSARY)) {
  const upper = key.toUpperCase();
  if (!CANONICAL_GLOSSARY_KEY_BY_UPPER[upper]) CANONICAL_GLOSSARY_KEY_BY_UPPER[upper] = key;
}

export function lookupGlossary(abbr: string): GlossaryLookupResult | null {
  const canonical = CANONICAL_GLOSSARY_KEY_BY_UPPER[abbr.toUpperCase()];
  if (!canonical) return null;
  return { abbr: canonical, entry: GLOSSARY[canonical] };
}

/**
 * Get all terms that should have definitions
 * Useful for content gap analysis
 */
export function getAllTerms(): string[] {
  return Object.keys(GLOSSARY);
}

// Auto-detection removed 2026-05-14. Any regex over the full glossary produced
// systematic false positives (the word "WHO" matched both the organisation and
// the question word, "OR" matched both the conjunction and Operating Room, etc).
// In-context decisions about which occurrences deserve a tooltip happen at
// authoring/audit time: write `<Term abbr="WHO">WHO</Term>` in MDX when it
// genuinely helps, otherwise leave the prose alone. `lookupGlossary` still
// works for explicit `<Term>` usages.
export const GLOSSARY_TERM_REGEX: RegExp | null = null;
