/**
 * resolve-source-path — turn a `Card.sourceFile` basename into the real path.
 *
 * `Card.sourceFile` holds a bare basename, so callers used to rebuild the path
 * as `content/<rotation>/<sourceFile>.mdx`. That is right for the 321 files at
 * a rotation root and wrong for the 1,046 in subdirectories (`anki-imports/`,
 * `anki-imports-y3g/`, `deep-dives/cards/`, `gamsat/s1/` …) — i.e. wrong for
 * most of the corpus. Flag triage then handed the morning-check agent a path
 * that does not exist, and a wrong path is worse than none: the agent either
 * cannot find the source or creates a file at the phantom location.
 *
 * Pure, so it is unit-tested without touching the filesystem: the caller passes
 * the candidate paths it already knows about.
 */

/** Normalise "foo" / "foo.mdx" to "foo". */
function baseName(sourceFile: string): string {
  return sourceFile.replace(/\.mdx$/i, '');
}

/**
 * Resolve a card's source path within its rotation.
 *
 * Preference order: the rotation-root path, then a unique nested match inside
 * the same rotation. Never leaves the rotation, because basenames repeat across
 * rotations (`week4-adolescent-health` exists under both cah and pwh).
 *
 * Returns null when nothing matches — the caller should report the target id
 * rather than a guess.
 */
export function resolveCardSourcePath(
  rotation: string | null | undefined,
  sourceFile: string | null | undefined,
  candidates: readonly string[],
): string | null {
  if (!rotation || !sourceFile) return null;
  const base = baseName(sourceFile.trim());
  if (!base) return null;

  const direct = `content/${rotation}/${base}.mdx`;
  if (candidates.includes(direct)) return direct;

  const prefix = `content/${rotation}/`;
  const nested = candidates.filter((p) => p.startsWith(prefix) && baseName(p.slice(p.lastIndexOf('/') + 1)) === base);

  // Exactly one match is a resolution; several is genuine ambiguity, and
  // picking one arbitrarily would reintroduce a confidently-wrong path.
  return nested.length === 1 ? nested[0] : null;
}
