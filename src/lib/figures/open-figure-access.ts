import originalFigurePaths from './original-figure-paths.json';

const originalPaths = new Set<string>(originalFigurePaths);

/**
 * Delivery boundary for repo-native, openly-licensed figures.
 *
 * `/figures/*` is fail-closed by default: it rewrites to a uniform 404 so that
 * rights-managed media (copyright-tier textbook scans, auth-tier clinical
 * images) can never be fetched by direct URL. That guard is correct and stays.
 *
 * The FOSS Step 1 corpus is a different case. Those figures are authored in
 * this repo, published under CC BY 4.0, and carry `accessTier: 'public'` in
 * their sidecars — they are part of the open corpus cohort.md exists to serve.
 * Blocking them made every Step 1 question that references a figure
 * undeliverable, which silently withheld 339 of 408 released questions,
 * including all 25 pinned baseline questions.
 *
 * The rewrite deliberately still matches ALL of `/figures/*`; the exemption
 * lives here, in reviewed and unit-tested code, rather than in a rewrite
 * pattern where a typo would unblock every rights-managed figure at once.
 *
 * The Step 1 exemption is a PATH PREFIX, which is only safe while every asset under
 * that prefix is independently declared public. `open-figure-access.test.ts`
 * asserts that invariant against the committed sidecars, so a rights-managed
 * asset dropped into the directory fails CI instead of shipping.
 * Original MIT PNGs have a separate exact manifest allowlist; an arbitrary
 * file in /figures/originals/ is never admitted by its directory alone.
 */

/** Legacy Step 1 namespace; originals are individually manifest-admitted. */
export const OPEN_FIGURE_PREFIX = '/figures/usmle/step1/';

/** Filename inside the open corpus: no nesting, no traversal, SVG only. */
const OPEN_FIGURE_ASSET = /^[a-z0-9][a-z0-9-]*\.svg$/;

/**
 * True for the open Step 1 path format or an exact reviewed original PNG.
 *
 * Deliberately strict: the value reaches both the delivery predicate and the
 * rendered `src`, so anything that is not a plain lowercase SVG filename
 * directly under the prefix is rejected rather than normalised.
 */
export function isOpenFigurePath(path: string | null | undefined): boolean {
  if (typeof path === 'string' && originalPaths.has(path)) return true;
  if (typeof path !== 'string' || !path.startsWith(OPEN_FIGURE_PREFIX)) return false;

  const asset = path.slice(OPEN_FIGURE_PREFIX.length);
  // Reject percent-encoding outright: it is never used by the authoring script
  // and is the cheapest way to smuggle a traversal past the pattern below.
  if (asset.includes('%')) return false;
  return OPEN_FIGURE_ASSET.test(asset);
}
