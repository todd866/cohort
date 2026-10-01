/**
 * Per-item rights provenance — whose words does this card hold?
 *
 * See docs/designs/2026-09-13-content-rights-provenance.md. The decision it
 * yields is recorded per item in a committed, private rights layer built from
 * SOURCE FILES (docs/designs/2026-09-23-cohort-mirror.md), and the Cohort
 * export selects on that layer, so publishing is a property of the data rather
 * than a path allowlist somebody maintains by memory. There is no database
 * column for it; a Card row cannot see the frontmatter or path that decide it.
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
  /**
   * Repo-relative path of the source file. A Card row stores only the basename,
   * and an import directory (`content/cah/anki-imports-y3g/`) is often the only
   * place the path says so. Supply it from `buildSourceScopeIndex`.
   */
  sourcePath?: string | null;
  /**
   * The source file's frontmatter `source:` value — where the author wrote down
   * what the file was made from (`anki-cah`, `rch-neonatal-antimicrobial`).
   */
  frontmatterSource?: string | null;
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
  'kubie',     // Kubie neuroanatomy lab collection (SUNY Downstate) — "no licence has been granted"
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

  const frontmatterSource = (input.frontmatterSource ?? '').toLowerCase();
  const fmMarker = frontmatterSource.startsWith('anki')
    ? 'anki'
    : IMPORT_SOURCE_MARKERS.find((m) => frontmatterSource.includes(m));
  if (fmMarker) {
    return { provenance: 'import', reason: `frontmatter source names import "${fmMarker}"` };
  }

  const sourcePath = (input.sourcePath ?? '').toLowerCase();
  const pathMarker = IMPORT_SOURCE_MARKERS.find((m) => sourcePath.includes(m));
  if (pathMarker) {
    return { provenance: 'import', reason: `source path matches import marker "${pathMarker}"` };
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

export interface SourceScope {
  sourcePath: string;
  frontmatterSource: string | null;
}

function frontmatterValue(frontmatter: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm').exec(frontmatter);
  return match ? match[1].trim() : null;
}

/**
 * Map each content MDX file to the `(rotation, basename)` scope its cards are
 * seeded under — `${rotation}\t${basename}` — so a classifier handed a Card row
 * can recover the path and frontmatter the row does not store.
 *
 * Rotation comes from frontmatter when set, otherwise the first directory under
 * `content/`. Two files sharing a scope are indistinguishable to a Card row, so
 * their paths and sources are JOINED: if either names an import, the card is
 * treated as one. That is the fail-closed direction.
 */
export function buildSourceScopeIndex(
  files: ReadonlyArray<{ path: string; text: string }>,
): Map<string, SourceScope> {
  const index = new Map<string, SourceScope>();
  for (const { path, text } of files) {
    if (!path.endsWith('.mdx')) continue;
    const fm = text.startsWith('---') ? text.slice(3, Math.max(3, text.indexOf('\n---', 3))) : '';
    const rotation = frontmatterValue(fm, 'rotation') ?? path.split('/')[1] ?? '';
    const basename = path.slice(path.lastIndexOf('/') + 1, -'.mdx'.length);
    const key = `${rotation}\t${basename}`;
    const source = frontmatterValue(fm, 'source');
    const prior = index.get(key);
    index.set(key, prior
      ? {
          sourcePath: `${prior.sourcePath} | ${path}`,
          frontmatterSource: [prior.frontmatterSource, source].filter(Boolean).join(' | ') || null,
        }
      : { sourcePath: path, frontmatterSource: source });
  }
  return index;
}

/** The only provenance permitted to leave the building. */
export function mayExport(provenance: RightsProvenance): boolean {
  return provenance === 'authored';
}
