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
  | 'factual' // grounded factual audit found a clinical-truth defect → verify vs the guideline, fix at source
  | 'jurisdiction' // AU card stands; author a locale twin only for a real AU-vs-US difference
  | 'augment' // too-easy / giveaway → KEEP the easy rung, add a harder companion (loop 8c)
  | 'image' // needs image/picture/diagram/figure → image-gaps loop (8f)
  | 'decode' // TLA/acronym hover-decode missing → glossary decode:true (8d)
  | 'hand-fix' // construction defect (formatting, grammar, truncation, unclear) → fix at source
  | 'teach' // "what *is* X" / needs scaffolding/teaching content → author C1 teaching
  | 'judgment' // ambiguous subjective report → human call, maybe wont-fix
  | 'systemic' // a detector-generated ContentIssue (audit-systemic-flags), NOT a user flag
  | 'needs-read' // has real prose but matched no rule → UNREVIEWED; read it and route it
  | 'unclassified'; // blank / no-reason → read the card to diagnose

export const LANE_ACTION: Record<FlagLane, string> = {
  factual: 'Clinical-truth defect from the grounded audit. VERIFY each against the named Australian guideline (RCH CPG / RANZCOG / eTG) before editing — a grounded verdict is a candidate, not a finding, and adjudication historically rejects over half of them. Then fix at source and re-seed. NOTE: an open issue withholds the item from serving, so leaving it open silently removes content from the queue.',
  jurisdiction: 'The AU teaching stands. Confirm this is genuinely an AU-vs-US practice difference, then tag the AU card and author the US sibling with the same conceptId. WHO/European, adult-vs-paediatric, or retrieval-only mismatches are not US twins and should be closed as non-applicable. This issue type does not withhold the AU card.',
  augment: 'KEEP the easy card; append a harder multi-format companion (harder cloze + MCQ). Never rewrite/delete the easy rung. → augment loop (step 8c).',
  image: 'Run the image-gaps sieve (step 8f); wire a genuine subject-matching figure if one exists, else it is a corpus gap (note, do not force).',
  decode: 'Add/flag the obscure TLA `decode: true` in glossary-data.json (step 8d). Never flag a trivial acronym.',
  'hand-fix': 'Fix the construction defect at source (formatting / grammar / truncated context / unclear), then re-seed.',
  teach: 'Author a complexity-1 teaching companion (KeyPoint) for the concept the flag says is under-explained.',
  judgment: 'The report is subjective or ambiguous — make a keep/wont-fix call; do not silently leave it open.',
  systemic: 'Detector-generated (audit-systemic-flags), NOT a user flag — managed by `audit:systemic:apply` (auto-resolves when the pattern is fixed). Work it via the systemic queue (step 6), not user-flag triage.',
  'needs-read':
    'The reporter wrote something the classifier could not route. It is UNREVIEWED, not unactionable — read the note, do the work it names, and if the phrasing is one that will recur, add it to classifyFlagLane so the next run routes it automatically.',
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
 * The premortem harness records ContentIssues as `premortem-<lane>`; it has
 * already judged AND adversarially verified each defect, so its output is the
 * most-vetted queue in the system and must land in a lane that gets worked.
 */
const PREMORTEM_LANES: Record<string, FlagLane> = {
  factual: 'factual',
  'too-easy': 'augment',
  'acronym-decode': 'decode',
  'context-teaches': 'teach',
};

/**
 * Classify a flag's free-text reason into a lane. Order encodes precedence:
 * premortem (already judged) → decode (a TLA signal is specific) → augment (the
 * keep-but-scaffold directive) → image → teach → hand-fix → judgment.
 *
 * Anything non-blank that matches none of them is `needs-read`, NOT
 * `unclassified` — see the fallthrough comment below.
 */
export function classifyFlagLane(text: string | null | undefined): FlagLane {
  const t = normalise(text);
  if (!t) return 'unclassified';

  // Detector output recorded as `premortem-<lane>` routes to that lane's treatment.
  const premortem = /^premortem-(.+)$/.exec(t);
  if (premortem) return PREMORTEM_LANES[premortem[1]] ?? 'needs-read';

  // decode first: "needs tla decode" must not be swallowed by the generic "needs … image" check
  if (/\btla\b|\bdecode\b|\bacronym\b/.test(t)) return 'decode';

  // augment: the keep-but-scaffold directive owns too-easy / giveaway / answer-visible.
  // The owner's own shorthand (2026-09-16): "easy cloze", "trivially easy",
  // "seen it a lot", "the hint makes this c1", "quiz differently".
  if (
    /too.?easy|give.?away|answer is visible|answer.{0,12}(visible|obvious|given)|keep but augment|keep.{0,20}augment|supplement.{0,12}harder|harder (variant|card|version)|scaffold.{0,15}harder|what'?s the point|\beasy (cloze|question|guess)|trivially easy|very easy|seen (it|this).{0,20}a lot|makes this c1|quiz differently/.test(
      t,
    )
  ) {
    return 'augment';
  }

  // image / picture / diagram / figure / x-ray / a described tracing with no media
  if (
    /\bimage\b|\bpicture\b|\bpic\b|\bdiagram\b|x-?ray|\bfigure\b|\bphoto\b|koplik|no xray|(cannot|can'?t|couldn'?t) see|should have the right (ecg|cxr|tracing|film)|discusses an ecg/.test(
      t,
    )
  ) {
    return 'image';
  }

  // teach: requests for an explanation / more scaffolding of the underlying concept
  if (/what \*?is|what is |need to know more|scaffolding content|flesh(ed)? out|could be fleshed|better explain|explain(s|ing)? (what|the concept)|needs? context explain|context needs to remind|remind what|context needs expansion|expansion of what/.test(t)) {
    return 'teach';
  }

  // hand-fix: concrete construction defects
  if (/broken formatting|formatting|broken grammar|grammar|cut.?off|truncat|doesn'?t make sense|don'?t understand|doesn'?t understand|restates|makes no sense|(not|isn'?t) (really )?(sure|clear)|phrased poorly|poorly phrased|badly (worded|phrased)|not a good (question|card)|too.?long context|context is too long|awkward phrasing|\brewrite\b|context needs fixing|needs fixing/.test(t)) {
    return 'hand-fix';
  }

  // judgment: explicit ambivalence
  if (/not really the vibe|not the vibe|\bvibe\b|i guess keep|\bdumb (card|question)|useless (card|question)|doesn'?t need to be a flashcard/.test(t)) return 'judgment';

  // The reporter wrote something real. Silent exclusion here is the recurring
  // defect (see detector-lane.test.ts): unmatched prose is UNREVIEWED work.
  return 'needs-read';
}

/**
 * Lane for a DETECTOR-generated issue, keyed on `metadata.detectedBy`.
 *
 * Returns null for user flags so the free-text classifier still owns those.
 * Grounded factual defects get their own lane rather than `systemic`: they are
 * hand-fixable content work with a written correction attached, whereas
 * `systemic` is the auto-resolving construction queue.
 */
export function laneForDetectedIssue(
  detectedBy: string | null | undefined,
  issueType?: string | null,
): FlagLane | null {
  if (!detectedBy) return null;
  if (issueType === 'jurisdiction-twin') return 'jurisdiction';
  return detectedBy === 'factual-audit' ? 'factual' : 'systemic';
}
