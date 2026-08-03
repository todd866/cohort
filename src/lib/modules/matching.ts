/**
 * Module tree matching utilities.
 *
 * Centralizes ancestor/descendant matching for the module tree.
 * Used by: unified-session-service, skills/trainers route, useActiveModules hook.
 */

/**
 * Check if two module slugs are related (direct match, ancestor, or descendant).
 */
export function moduleSlugsMatch(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Check if an item's moduleNodes overlap with any active modules.
 * Returns true if there's any match (direct, ancestor, or descendant).
 *
 * Special cases:
 * - No active modules → show all (no filtering)
 * - Item has no moduleNodes → show it (backwards compatibility)
 */
export function itemMatchesModules(
  itemModules: string[] | null | undefined,
  activeModules: string[],
): boolean {
  if (activeModules.length === 0) return true;
  if (!itemModules || itemModules.length === 0) return true;

  for (const itemModule of itemModules) {
    for (const activeModule of activeModules) {
      if (moduleSlugsMatch(itemModule, activeModule)) return true;
    }
  }
  return false;
}

/** Top-level slug — first segment before `/`. `cc/icu/sepsis` → `cc`. */
export function topLevelSlug(slug: string): string {
  const idx = slug.indexOf('/');
  return idx === -1 ? slug : slug.slice(0, idx);
}

/**
 * Per-item alignment check used at seed time. See
 * docs/designs/2026-05-09-rotation-vs-modulenodes.md.
 *
 * Returns null when the item's moduleNodes are empty (allowed) OR when at least
 * one moduleNode's top-level slug equals the rotation (the canonical case).
 * Returns an "unaligned" reason string otherwise — caller decides whether to
 * warn or hard-fail. Cross-rotation items are intentional but rare; we want a
 * clearly-named seam where the soft warning fires so a deliberate decision can
 * be promoted to an allowlist later.
 */
export function checkModuleNodeAlignment(item: {
  id: string;
  rotation: string;
  moduleNodes: string[] | null | undefined;
}): null | string {
  const nodes = item.moduleNodes ?? [];
  if (nodes.length === 0) return null;
  const tops = new Set(nodes.map(topLevelSlug));
  if (tops.has(item.rotation)) return null;
  return `moduleNodes [${nodes.join(', ')}] have no top-level matching rotation '${item.rotation}'`;
}
