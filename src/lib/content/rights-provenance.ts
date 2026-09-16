/**
 * Per-item rights provenance — whose words does this card hold?
 *
 * See docs/designs/2026-09-13-content-rights-provenance.md. This is the field
 * the export boundary selects on, so that publishing to cohort.md is a property
 * of the data rather than a path allowlist somebody maintains by memory.
 *
 * THE DEFAULT IS CLOSED AND THE BACKFILL ONLY RULES THINGS OUT.
 * `classifyCardProvenance` can return `import` or `unreviewed`; it can never
 * return `authored`. Nothing becomes publishable because a pipeline ran — which
 * is exactly how `Card.importEpochId` failed. That field was designed for this
 * job and is NULL on all 97,835 cards, so it reports every AnKing card as
 * not-an-import. An unpopulated field that fails open is worse than no field.
 *
 * Promotion to `authored` is a separate, evidenced decision requiring
 * guideline-tier grounding AND non-import provenance — see
 * `cardMayBePromoted` in ./source-tier.
 */

export const RIGHTS_PROVENANCE_VALUES = [
  'authored',
  'derived-expression',
  'import',
  'unreviewed',
] as const;

export type RightsProvenance = (typeof RIGHTS_PROVENANCE_VALUES)[number];

export interface ProvenanceResult {
  provenance: RightsProvenance;
  /** Why, so a classification can be audited rather than trusted. */
  reason: string;
}

export interface ProvenanceInput {
  stableId?: string | null;
  rotation?: string | null;
  sourceFile?: string | null;
  /**
   * The card's context prose. Attribution frequently lives HERE rather than in
   * the filename — the 4,747 BlueLink anatomy cards have body-region source
   * files (`bones-joints`, `orbit`) and name their atlas only in the context.
   */
  context?: string | null;
}

/** stableId prefixes that are third-party decks by construction. */
const IMPORT_STABLE_ID_PREFIXES: ReadonlyArray<string> = Object.freeze(['anki', 'anking']);

/** Whole rotations that exist to hold imported material. */
const IMPORT_ROTATIONS: ReadonlyArray<string> = Object.freeze([
  'anking',
  'malleus',
  'surgical-sciences', // Netter plate prompts
  'anatomy',           // BlueLink Atlas plate prompts — explicitly not openly licensed
]);

/**
 * sourceFile markers for material that entered through an import even though it
 * was rendered into MDX and therefore carries the `mdx:` prefix. This is the
 * set a prefix-only rule misses, and it is not small: `netter-*` alone is
 * 17,128 cards.
 */
const IMPORT_SOURCE_MARKERS: ReadonlyArray<string> = Object.freeze([
  'netter',    // Netter's Atlas of Human Anatomy — copyrighted plates
  'stuanki',   // another student's Anki deck
  'malleus',
  'anki-',
  'anking',
  'pedi-boards',
  'queso',
  'zanki',
  'bluelink',  // BlueLink Anatomy Atlas (U. Michigan) — "not openly licensed"
]);

export function classifyCardProvenance(input: ProvenanceInput): ProvenanceResult {
  const stableId = (input.stableId ?? '').toLowerCase();
  const rotation = (input.rotation ?? '').toLowerCase();
  const sourceFile = (input.sourceFile ?? '').toLowerCase();

  const prefix = stableId.includes(':') ? stableId.split(':')[0] : '';
  if (prefix && IMPORT_STABLE_ID_PREFIXES.includes(prefix)) {
    return { provenance: 'import', reason: `stableId prefix "${prefix}:"` };
  }

  const marker = IMPORT_SOURCE_MARKERS.find((m) => sourceFile.includes(m));
  if (marker) {
    return { provenance: 'import', reason: `sourceFile matches import marker "${marker}"` };
  }

  // Attribution often lives in the context rather than the path. Checked before
  // the rotation rule so the reason names the actual source.
  const context = (input.context ?? '').toLowerCase();
  const contextMarker = IMPORT_SOURCE_MARKERS.find((m) => context.includes(m));
  if (contextMarker) {
    return { provenance: 'import', reason: `context attributes import source "${contextMarker}"` };
  }

  if (rotation && IMPORT_ROTATIONS.includes(rotation)) {
    return { provenance: 'import', reason: `rotation "${rotation}" holds imported material` };
  }

  // Everything else is UNREVIEWED, never authored. An ordinary authored-pipeline
  // card is a candidate for promotion, not a publishable item.
  return { provenance: 'unreviewed', reason: 'no import marker; awaiting evidenced promotion' };
}

/** The only provenance permitted to leave the building. */
export function mayExport(provenance: RightsProvenance): boolean {
  return provenance === 'authored';
}
