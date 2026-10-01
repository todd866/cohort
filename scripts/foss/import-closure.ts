/**
 * Import-closure check for the FOSS distribution.
 *
 * The boundary audit validates which files are SELECTED — paths, licences,
 * forbidden prefixes, symlinks. It never resolves an import, so a distributed
 * file may import a module that was left behind and the audit still reports
 * PASS. The export is then unbuildable in a way nothing detects until someone
 * clones it, which is the worst place to find out.
 *
 * This closes that gap: every `@/…` specifier AND every relative (`./`, `../`)
 * specifier in a distributed JavaScript or TypeScript module must resolve to a
 * file that is also distributed.
 *
 * Relative imports were added 2026-09-23. Until then the check only followed
 * `@/` aliases under src/, and the public Cohort CI failed typecheck on three
 * consecutive releases because `scripts/lib/db.ts` shipped without three
 * sibling helpers it imports by relative path. Nothing on this side noticed.
 *
 * Build-generated modules are the one legitimate exception. `src/lib/generated/`
 * is produced by `npm run build`, so it is absent from a source manifest by
 * design and present by the time anything imports it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

/** Prefixes produced at build time, so legitimately absent from the manifest. */
export const GENERATED_PREFIXES = ['src/lib/generated/'];

/** `images:index` writes these at prebuild; `.gitignore` keeps them out of git. */
const GENERATED_DATA_RE = /^src\/data\/[^/]+\.generated\.json$/;

/** Distributed files whose imports are resolved: any JS or TS module. */
const MODULE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * Extensions tried for a relative specifier, in TypeScript's order. A `.js`
 * family specifier may name its TypeScript source (`./b.js` → `b.ts`).
 */
const RELATIVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs', '.json'];
const INDEX_SUFFIXES = ['/index.ts', '/index.tsx', '/index.mjs', '/index.js'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
};

export interface UnresolvedImport {
  /** The distributed file containing the import. */
  importer: string;
  /** The `@/…` or relative specifier as written. */
  specifier: string;
  /** Repo-relative path it resolves to on disk, or null if nothing matched. */
  target: string | null;
}

/**
 * Every static import, re-export, dynamic `import('…')` and `require('…')`
 * specifier, as TypeScript's own pre-processor sees them. A regex over the
 * text cannot tell an import from a doc-comment example or from a generator
 * that emits import lines as strings; this can, and it skips template-literal
 * specifiers, which have no static target to check.
 */
function moduleSpecifiers(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((file) => file.fileName);
}

export function extractAliasImports(source: string): string[] {
  return moduleSpecifiers(source).filter((specifier) => specifier.startsWith('@/'));
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

export function extractRelativeImports(source: string): string[] {
  return moduleSpecifiers(source)
    .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'));
}

/**
 * Resolve a `./` or `../` specifier against the importing file's directory.
 * Returns null for alias or bare specifiers, for a path that climbs out of the
 * repo, and when nothing on disk matches.
 */
export function resolveRelativeImport(
  specifier: string,
  importer: string,
  root: string,
  exists: (p: string) => boolean = (p) => existsSync(p) && statSync(p).isFile(),
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (base.startsWith('../')) return null;
  const candidates = RELATIVE_SUFFIXES.map((suffix) => `${base}${suffix}`);
  const ext = posix.extname(base);
  for (const tsExt of JS_TO_TS[ext] ?? []) candidates.push(`${base.slice(0, -ext.length)}${tsExt}`);
  candidates.push(...INDEX_SUFFIXES.map((suffix) => `${base}${suffix}`));
  for (const candidate of candidates) {
    if (exists(join(root, candidate))) return candidate;
  }
  return null;
}

export function isGenerated(path: string): boolean {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix)) || GENERATED_DATA_RE.test(path);
}

/**
 * Every distributed `@/…` or relative import whose target is missing from the
 * manifest.
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
  const sources = distributedPaths.filter((p) => MODULE_RE.test(p));
  const problems: UnresolvedImport[] = [];

  for (const importer of sources) {
    const source = readFile(join(root, importer));
    for (const specifier of extractRelativeImports(source)) {
      const target = resolveRelativeImport(specifier, importer, root, exists);
      if (target === null) {
        const lexical = posix.normalize(posix.join(posix.dirname(importer), specifier));
        if (!lexical.startsWith('../') && !isGenerated(lexical)) {
          problems.push({ importer, specifier, target: null });
        }
        continue;
      }
      if (isGenerated(target) || distributed.has(target)) continue;
      problems.push({ importer, specifier, target });
    }
    for (const specifier of extractAliasImports(source)) {
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
