/**
 * clean-tree-guard — release fingerprints must not absorb foreign WIP.
 *
 * ## The failure this prevents (batch 9, 2026-08-04)
 *
 * Release fingerprints are recomputed from the corpus files ON DISK. When a
 * concurrent lane had uncommitted edits in the working tree (a figure lane
 * injecting `media`/`imageUrl` blocks), a fingerprint refresh silently baked those
 * foreign, uncommitted fields into `release-v1.json`. The result passed locally and
 * failed on every clean checkout — the worst kind of drift, because the artifact
 * looked fine to the author who produced it.
 *
 * ## What is blocked vs allowed on a fingerprint WRITE
 *
 * The dangerous case is a **tracked** question/source file that differs from HEAD
 * (status ` M`, `M `, `MM`, `D `, …): those edits change fingerprints of already-
 * released items without being part of the intentional release. Untracked new
 * question files (`??`) are allowed — that is how a new ladder lands. A dirty
 * `release-v1.json` is allowed — the write is about to rewrite it.
 *
 * The parser is PURE and unit-tested; only the thin `git` shell-out is impure.
 */
import { execFileSync } from 'node:child_process';

/** Paths whose TRACKED modifications block a fingerprint write. */
export const DEFAULT_CORPUS_PREFIXES = [
  'open-content/usmle/step1/questions/',
  'open-content/usmle/step1/baseline-v1.json',
  'open-content/usmle/step1/sources.json',
];

/** Always allowed dirty during a fingerprint write (the write rewrites it). */
export const FINGERPRINT_WRITE_ALLOW_DIRTY = [
  'open-content/usmle/step1/release-v1.json',
] as const;

export interface PorcelainEntry {
  /** Two-char porcelain status (e.g. ` M`, `??`, `R `). */
  status: string;
  path: string;
}

/**
 * PURE. Parse `git status --porcelain` into normalised entries.
 *
 * Porcelain v1 lines look like `XY <path>` (e.g. ` M a/b.json`, `?? a/c.json`, and
 * for renames `R  old -> new`). For a rename take the destination (after ` -> `),
 * since that is the path now on disk that a fingerprint run would read.
 */
export function parsePorcelainEntries(porcelain: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const rawLine of (porcelain || '').split('\n')) {
    if (!rawLine.trim()) continue;
    const status = rawLine.slice(0, 2);
    let p = rawLine.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow > -1) p = p.slice(arrow + 4).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    out.push({ status, path: p });
  }
  return out;
}

/**
 * PURE. Dirty paths under the guarded prefixes (any status, including untracked).
 * Kept for diagnostics / full-clean checks.
 */
export function parseDirtyCorpusFiles(
  porcelain: string,
  prefixes: readonly string[] = DEFAULT_CORPUS_PREFIXES,
): string[] {
  const dirty: string[] = [];
  for (const { path: p } of parsePorcelainEntries(porcelain)) {
    if (prefixes.some((prefix) => p === prefix || p.startsWith(prefix))) {
      dirty.push(p);
    }
  }
  return [...new Set(dirty)].sort();
}

/**
 * PURE. Paths that would silently corrupt a fingerprint write: UNSTAGED tracked
 * modifications under the corpus prefixes.
 *
 * Untracked (`??`) files are NOT blocking — new ladder items arrive as untracked.
 * Staged tracked edits (`M `, `A `, …) are NOT blocking — staging declares them
 * intentional for this release. Unstaged tracked edits (` M`, ` D`, …) ARE
 * blocking — that is the foreign-WIP signature from batch 9.
 */
export function parseFingerprintBlockingDirt(
  porcelain: string,
  prefixes: readonly string[] = DEFAULT_CORPUS_PREFIXES,
  allowDirty: readonly string[] = FINGERPRINT_WRITE_ALLOW_DIRTY,
): string[] {
  const allow = new Set(allowDirty);
  const blocking: string[] = [];
  for (const { status, path: p } of parsePorcelainEntries(porcelain)) {
    if (allow.has(p)) continue;
    if (status === '??') continue; // untracked = intentional new content
    // Staged-only changes (index dirty, worktree clean relative to index): first
    // status char is M/A/D/R/C and second is space.
    const stagedOnly = status[1] === ' ' && status[0] !== ' ' && status[0] !== '?';
    if (stagedOnly) continue;
    if (prefixes.some((prefix) => p === prefix || p.startsWith(prefix))) {
      blocking.push(p);
    }
  }
  return [...new Set(blocking)].sort();
}

export interface CleanTreeOptions {
  cwd?: string;
  prefixes?: readonly string[];
  allowDirty?: readonly string[];
  /** Injectable for tests; defaults to a real `git status --porcelain`. */
  gitStatus?: (cwd: string) => string;
}

function realGitStatus(cwd: string): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Throw if TRACKED corpus files carry uncommitted modifications. The error names
 * every offending path so the author can commit or revert foreign WIP first.
 *
 * Call this at the top of a `--write-release-fingerprints` branch — never on the
 * read-only release gate, which must still run on any tree.
 *
 * Non-git trees (FOSS tarball checkouts) are treated as clean: there is no
 * tracked WIP that could silently corrupt fingerprints.
 */
export function assertCorpusTreeClean(options: CleanTreeOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const prefixes = options.prefixes ?? DEFAULT_CORPUS_PREFIXES;
  const allowDirty = options.allowDirty ?? FINGERPRINT_WRITE_ALLOW_DIRTY;
  const gitStatus = options.gitStatus ?? realGitStatus;
  let porcelain: string;
  try {
    porcelain = gitStatus(cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(message)) porcelain = '';
    else throw error;
  }
  const dirty = parseFingerprintBlockingDirt(porcelain, prefixes, allowDirty);
  if (dirty.length > 0) {
    throw new Error(
      'Refusing to write release fingerprints: unstaged tracked corpus files differ from HEAD.\n'
      + 'Stage intentional edits (git add) before fingerprinting, or revert foreign WIP.\n'
      + 'Unstaged edits to already-released items get baked into fingerprints\n'
      + '(see batch 9, 2026-08-04). Offending paths:\n'
      + dirty.map((f) => `  - ${f}`).join('\n'),
    );
  }
}
