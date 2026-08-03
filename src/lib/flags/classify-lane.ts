/**
 * classify-lane — route an open card/question flag into an ACTIONABLE lane so a
 * morning-check agent works every fixable flag, not just the loud ones.
 *
 * Product feedback required every actionable flag to be handled without a
 * manual reminder, and easy cards to be scaffolded with harder variants. The
 * lanes encode the right treatment per flag kind — crucially,
 * too-easy/giveaway clozes go to `augment` (keep + add a harder variant), NOT
 * a rewrite/hand-fix.
 *
 * Pure + deterministic so the morning-check worklist is reproducible and the
 * classifier is unit-tested (no LLM variance in the routing itself).
 */

export type FlagLane =
  | 'augment' // too-easy / giveaway → KEEP the easy rung, add a harder companion (loop 8c)
  | 'image' // needs image/picture/diagram/figure → image-gaps loop (8f)
  | 'decode' // TLA/acronym hover-decode missing → glossary decode:true (8d)
  | 'hand-fix' // construction defect (formatting, grammar, truncation, unclear) → fix at source
  | 'teach' // "what *is* X" / needs scaffolding/teaching content → author C1 teaching
  | 'judgment' // ambiguous subjective report → human call, maybe wont-fix
  | 'systemic' // a detector-generated ContentIssue (audit-systemic-flags), NOT a user flag
  | 'unclassified'; // blank / no-reason → read the card to diagnose

export const LANE_ACTION: Record<FlagLane, string> = {
  augment: 'KEEP the easy card; append a harder multi-format companion (harder cloze + MCQ). Never rewrite/delete the easy rung. → augment loop (step 8c).',
  image: 'Run the image-gaps sieve (step 8f); wire a genuine subject-matching figure if one exists, else it is a corpus gap (note, do not force).',
  decode: 'Add/flag the obscure TLA `decode: true` in glossary-data.json (step 8d). Never flag a trivial acronym.',
  'hand-fix': 'Fix the construction defect at source (formatting / grammar / truncated context / unclear), then re-seed.',
  teach: 'Author a complexity-1 teaching companion (KeyPoint) for the concept the flag says is under-explained.',
  judgment: 'The report is subjective or ambiguous — make a keep/wont-fix call; do not silently leave it open.',
  systemic: 'Detector-generated (audit-systemic-flags), NOT a user flag — managed by `audit:systemic:apply` (auto-resolves when the pattern is fixed). Work it via the systemic queue (step 6), not user-flag triage.',
  unclassified: 'No reason text and not a known detector — open the card and diagnose by reading it (a blank flag still has a reason).',
};

/** Strip the leading "Other:" prefix and normalise. */
function normalise(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/^\s*other\s*:/i, '')
    .toLowerCase()
    .trim();
}

/**
 * Classify a flag's free-text reason into a lane. Order encodes precedence:
 * decode (a TLA signal is specific) → augment (the keep-but-scaffold directive)
 * → image → teach → hand-fix → judgment → unclassified.
 */
export function classifyFlagLane(text: string | null | undefined): FlagLane {
  const t = normalise(text);
  if (!t) return 'unclassified';

  // decode first: "needs tla decode" must not be swallowed by the generic "needs … image" check
  if (/\btla\b|\bdecode\b|\bacronym\b/.test(t)) return 'decode';

  // augment: the keep-but-scaffold directive owns too-easy / giveaway / answer-visible
  if (
    /too.?easy|give.?away|answer is visible|answer.{0,12}(visible|obvious|given)|keep but augment|keep.{0,20}augment|supplement.{0,12}harder|harder (variant|card)|scaffold.{0,15}harder|what'?s the point/.test(
      t,
    )
  ) {
    return 'augment';
  }

  // image / picture / diagram / figure / x-ray
  if (/\bimage\b|\bpicture\b|\bpic\b|\bdiagram\b|x-?ray|\bfigure\b|\bphoto\b|koplik|no xray/.test(t)) {
    return 'image';
  }

  // teach: requests for an explanation / more scaffolding of the underlying concept
  if (/what \*?is|what is |need to know more|scaffolding content|flesh(ed)? out|could be fleshed|better explain|explain (what|the concept)/.test(t)) {
    return 'teach';
  }

  // hand-fix: concrete construction defects
  if (/broken formatting|formatting|broken grammar|grammar|cut.?off|truncat|doesn'?t make sense|don'?t understand|doesn'?t understand|restates|makes no sense/.test(t)) {
    return 'hand-fix';
  }

  // judgment: explicit ambivalence
  if (/not really the vibe|not the vibe|\bvibe\b|i guess keep/.test(t)) return 'judgment';

  return 'unclassified';
}
