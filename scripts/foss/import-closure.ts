/**
 * Import-closure check for the FOSS distribution.
 *
 * The boundary audit validates which files are SELECTED — paths, licences,
 * forbidden prefixes, symlinks. It never resolves an import, so a distributed
 * file may import a module that was left behind and the audit still reports
 * PASS. The export is then unbuildable in a way nothing detects until someone
 * clones it, which is the worst place to find out.
 *
 * This closes that gap: every `@/…` specifier in a distributed TypeScript file
 * must resolve to a file that is also distributed.
 *
 * Build-generated modules are the one legitimate exception. `src/lib/generated/`
 * is produced by `npm run build`, so it is absent from a source manifest by
 * design and present by the time anything imports it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Prefixes produced at build time, so legitimately absent from the manifest. */
export const GENERATED_PREFIXES = ['src/lib/generated/'];

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"](@\/[^'"]+)['"]/g;

export interface UnresolvedImport {
  /** The distributed file containing the import. */
  importer: string;
  /** The `@/…` specifier as written. */
  specifier: string;
  /** Repo-relative path it resolves to on disk, or null if nothing matched. */
  target: string | null;
}

export function extractAliasImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) out.push(match[1]);
  return out;
}

/**
 * Resolve an `@/…` specifier the way the tsconfig path alias does: `@/x` → the
 * first of `src/x`, `src/x.ts(x)`, `src/x/index.ts(x)` that is a real file.
 * Returns null when nothing matches — a bare directory does not count.
 */
export function resolveAliasImport(
  specifier: string,
  root: string,
  exists: (p: string) => boolean = (p) => existsSync(p) && statSync(p).isFile(),
): string | null {
  if (!specifier.startsWith('@/')) return null;
  const base = `src/${specifier.slice(2)}`;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (exists(join(root, candidate))) return candidate;
  }
  return null;
}

export function isGenerated(path: string): boolean {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Every distributed `@/…` import whose target is missing from the manifest.
 * A specifier that resolves to nothing on disk is reported with target null —
 * that is a broken import in the source tree, not merely a packaging gap.
 */
export function findUnresolvedImports(
  distributedPaths: readonly string[],
  root: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  exists?: (p: string) => boolean,
): UnresolvedImport[] {
  const distributed = new Set(distributedPaths);
  const sources = distributedPaths.filter((p) => p.startsWith('src/') && /\.tsx?$/.test(p));
  const problems: UnresolvedImport[] = [];

  for (const importer of sources) {
    for (const specifier of extractAliasImports(readFile(join(root, importer)))) {
      const target = resolveAliasImport(specifier, root, exists);
      if (target === null) {
        // Unresolvable on disk: fine only if it names a build-generated module.
        if (!isGenerated(`src/${specifier.slice(2)}`)) {
          problems.push({ importer, specifier, target: null });
        }
        continue;
      }
      if (isGenerated(target) || distributed.has(target)) continue;
      problems.push({ importer, specifier, target });
    }
  }
  return problems;
}

/** Group by missing target, so the report reads as a work list. */
export function summarise(problems: readonly UnresolvedImport[]): Map<string, string[]> {
  const byTarget = new Map<string, string[]>();
  for (const p of problems) {
    const key = p.target ?? `${p.specifier} (unresolvable)`;
    const importers = byTarget.get(key) ?? [];
    importers.push(p.importer);
    byTarget.set(key, importers);
  }
  return new Map([...byTarget].sort((a, b) => b[1].length - a[1].length));
}
