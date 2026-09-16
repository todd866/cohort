/**
 * Which open ContentIssues are severe enough to withhold their item from study.
 *
 * Withholding is a blunt instrument: it removes the card AND its linked
 * question twin from every serving path. That is the right response to a
 * clinical-truth defect — teaching a wrong dose is worse than teaching nothing
 * — and the wrong response to everything else.
 *
 * Before this predicate existed the exclusion was unconditional on issue type,
 * which produced two bad outcomes:
 *
 *  1. It inverted the augment loop. A `too-easy` flag means "keep this rung and
 *     add a harder companion", but an open one silently deleted the rung from
 *     the queue.
 *  2. It made the systemic construction queue dangerous to grow. Scoping that
 *     audit to the whole corpus surfaces ~400 cosmetic hits (context length,
 *     scenario breaks); as withholding issues they would have removed ~400
 *     items from serving, including the public Step 1 corpus.
 *
 * The set is a deliberate ALLOW-list of severe types and fails open: an
 * unrecognised issueType does not withhold, so a newly-added detector can never
 * empty the queue by accident. A detector that genuinely needs to withhold has
 * to say so here, in a reviewed change, with a test.
 */

/** Exact issue types that impugn the correctness of what is taught. */
const SEVERE_EXACT = new Set(['incorrect', 'outdated']);

/** Prefixes for generated families whose every member is a truth defect. */
const SEVERE_PREFIXES = ['factual-'];

export function withholdsFromServing(issueType: string | null | undefined): boolean {
  if (typeof issueType !== 'string') return false;
  const normalised = issueType.trim().toLowerCase();
  if (!normalised) return false;
  if (SEVERE_EXACT.has(normalised)) return true;
  return SEVERE_PREFIXES.some((prefix) => normalised.startsWith(prefix));
}
