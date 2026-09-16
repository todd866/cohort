/**
 * Symbol closure for FOSS generated rewrites.
 *
 * Some src files are not shipped verbatim by the FOSS export: they are replaced
 * by a sanitized rewrite in `foss/distribution-policy.json` → generatedTextFiles
 * (e.g. src/lib/institution-rotations.ts, whose public copy carries no USyd
 * curriculum). The rewrite therefore has to export everything the exported
 * sources import from it.
 *
 * On 2026-08-21 it did not: `defaultPrimaryRotation` was added privately and
 * imported by exported server-bootstrap.ts, the rewrite never grew it, and the
 * clean artifact failed to typecheck. Nothing local caught it —
 * `foss:boundary:audit` checks licences and paths, not symbol closure — so it
 * cost a full CI cycle. This closes that gap statically, in milliseconds.
 */

/** Named exports declared by a TypeScript module's source text. */
export function exportedSymbols(source: string): Set<string> {
  const names = new Set<string>();
  const declaration = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) names.add(match[1]);
  // `export { a, b as c }` — the exported name is what importers reference.
  const braced = /export\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(braced)) {
    for (const clause of match[1].split(',')) {
      const parts = clause.trim().split(/\s+as\s+/);
      const name = (parts[1] ?? parts[0]).trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Named bindings a module imports from `moduleSpecifier`. Ignores type-only. */
export function namedImportsFrom(source: string, moduleSpecifier: string): string[] {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${escaped}['"]`,
    'g',
  );
  const names: string[] = [];
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue; // `import type {…}` is erased; never a runtime need
    for (const clause of match[2].split(',')) {
      const raw = clause.trim();
      if (!raw) continue;
      if (/^type\s/.test(raw)) continue; // inline `type Foo` specifier
      names.push(raw.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

export interface ClosureGap {
  /** The exported file doing the importing. */
  importer: string;
  /** The rewritten module it imports from. */
  module: string;
  symbol: string;
}

/**
 * Every symbol an exported source imports from a rewritten module, which that
 * rewrite does not export.
 */
export function findRewriteClosureGaps(
  rewrites: Array<{ path: string; text: string }>,
  exportedSources: Array<{ path: string; text: string }>,
): ClosureGap[] {
  const gaps: ClosureGap[] = [];
  for (const rewrite of rewrites) {
    // src/lib/institution-rotations.ts → '@/lib/institution-rotations'
    const specifier = rewrite.path
      .replace(/^src\//, '@/')
      .replace(/\.tsx?$/, '');
    const available = exportedSymbols(rewrite.text);
    for (const source of exportedSources) {
      if (source.path === rewrite.path) continue;
      for (const symbol of namedImportsFrom(source.text, specifier)) {
        if (!available.has(symbol)) {
          gaps.push({ importer: source.path, module: rewrite.path, symbol });
        }
      }
    }
  }
  return gaps;
}
