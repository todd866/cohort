/**
 * Parse a cite reference string into its components.
 *
 * Formats supported:
 * - "source-slug" → { sourceSlug: "source-slug" }
 * - "source-slug#section" → { sourceSlug: "source-slug", section: "section" }
 * - "source-slug:doc-id:version#section" → { sourceSlug: "source-slug", section: "section" }
 */
export function parseCiteReference(cite: string): {
  sourceSlug: string;
  section?: string;
} | null {
  if (!cite) return null;

  const hashIndex = cite.indexOf('#');
  let sourceSlug: string;
  let section: string | undefined;

  if (hashIndex !== -1) {
    const beforeHash = cite.substring(0, hashIndex);
    section = cite.substring(hashIndex + 1);
    // Extract source slug (first part before any colons)
    sourceSlug = beforeHash.split(':')[0];
  } else {
    // No section, just source slug (potentially with doc-id:version)
    sourceSlug = cite.split(':')[0];
  }

  return { sourceSlug, section };
}

/**
 * Parse one or more cite references separated by semicolons.
 */
export function parseCiteReferenceList(cite: string): Array<{
  sourceSlug: string;
  section?: string;
}> {
  if (!cite) return [];

  return cite
    .split(';')
    .map((part) => parseCiteReference(part.trim()))
    .filter((parsed): parsed is { sourceSlug: string; section?: string } => parsed !== null);
}
