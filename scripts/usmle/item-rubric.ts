/**
 * item-rubric — the DETERMINISTIC half of the Step 1 item-quality harness.
 *
 * Encodes the item-writing flaws that can be checked mechanically, drawn from the
 * NBME Item-Writing Guide (`Constructing Written Test Questions for the Basic and
 * Clinical Sciences`) and the Haladyna/Downing taxonomy — both now in the local
 * corpus (`audit/usmle/item-writing-research-base.txt`).
 *
 * WHY DETERMINISTIC FIRST: a flaw like "None of the above" or a negative lead-in
 * is a string fact, not a judgement, and `.claude/rules/cloze-granularity.md`'s
 * lesson applies in reverse here — use a regex for what IS mechanical, and throw a
 * model at what isn't. The semantic calls (are the distractors homogeneous and
 * plausible? is the lead-in second-order?) go to the Codex judge instead; this
 * file must never grow a "is it a good question" heuristic.
 *
 * Every rule cites its source so a disputed flag can be argued against the
 * primary document rather than against my opinion.
 */

export interface ParsedItem {
  id: string;
  stem: string;
  options: { label: string; text: string }[];
  answer?: string; // label of the correct option
  source?: string;
}

export type Severity = 'flaw' | 'warn';

export interface RuleHit {
  rule: string;
  severity: Severity;
  detail: string;
  /** Where the rule comes from, so a false positive is arguable at the source. */
  authority: string;
}

const NEGATIVE_LEADIN =
  /\b(except|not true|least likely|least appropriate|which is not|would not be)\b/i;
const NONE_ALL_OF_ABOVE = /\b(all|none) of the above\b/i;
const ABSOLUTE = /\b(always|never|all patients|no patients|invariably|exclusively|only ever)\b/i;
const VAGUE_FREQ = /\b(usually|often|frequently|sometimes|rarely|occasionally|may|might|could)\b/i;
// `hour` matters: neonatal vignettes say "a 72-hour-old boy", and omitting it
// falsely flagged a correct neonatal-jaundice item as having no vignette.
const VIGNETTE_AGE = /\b\d{1,3}[- ](?:year|month|week|day|hour)[- ]old\b|\bnewborn\b|\bneonate\b/i;
/**
 * NBME house phrasing. 100% of the 254 official sample items use "which of the
 * following", so its ABSENCE is a style signal — but not a defect.
 */
const NBME_HOUSE_LEADIN = /\bwhich of the following\b/i;
/**
 * An interrogative ANYWHERE in the lead-in, not just at the start.
 *
 * Anchoring to the opener dropped official clean from 73% to 44%, because NBME
 * routinely embeds it mid-sentence: "Invasion of which of the following layers of
 * skin carries the highest risk of mortality?" begins with a noun phrase.
 */
const INTERROGATIVE = /\b(which|what|who|whom|where|when|how)\b/i;

/**
 * PURE. The lead-in = the final sentence, which is what NBME's positive-phrasing
 * rule governs.
 *
 * Calibration forced this: scanning the WHOLE stem flagged 5% of official NBME
 * items, because vignettes legitimately say "has not started hemodialysis" or
 * "does not smoke". The flaw is a negative LEAD-IN, not a negated history.
 */
export function leadIn(stem: string): string {
  const parts = (stem || '').split(/(?<=[.?])\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : (stem || '');
}

/**
 * PURE. Is the lead-in a single closed question?
 *
 * Measured against generated items: an earlier version accepted only the literal
 * "which of the following", so it flagged 12 of 12 perfectly good lead-ins like
 * "Which circulating change most directly links placental ischaemia to her renal
 * findings?" as open. That rule was encoding NBME's PHRASING, not closedness.
 * House phrasing is now a separate, softer signal.
 */
export function isClosedLeadIn(stem: string): boolean {
  const li = leadIn(stem).trim();
  if (!li.endsWith('?')) return false;
  // ONE question per item. Measured: 0 of 232 official Step 1/Step 3 items contain
  // more than one '?', so a second question mark anywhere in the stem is a stacked
  // or multi-part lead-in. Counting over the whole stem (not just the final
  // sentence) is what makes a stacked pair detectable at all.
  if (((stem || '').match(/\?/g) || []).length > 1) return false;
  return INTERROGATIVE.test(li);
}

function words(s: string): string[] {
  return (s || '').trim().split(/\s+/).filter(Boolean);
}

function normWords(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

/** PURE. Median of a numeric list (0 for empty). */
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * PURE. Is the correct option conspicuously longer than the distractors?
 *
 * NBME guide: the correct answer being the longest, most-qualified option is one
 * of the commonest unintended cues, because writers pad it to be defensible.
 * Threshold is deliberately generous (1.5× the median distractor) so ordinary
 * variation does not fire.
 */
export function longestAnswerCue(item: ParsedItem): boolean {
  if (!item.answer || item.options.length < 3) return false;
  const correct = item.options.find((o) => o.label === item.answer);
  if (!correct) return false;
  const others = item.options.filter((o) => o.label !== item.answer).map((o) => words(o.text).length);
  const med = median(others);
  return med > 0 && words(correct.text).length >= Math.max(med * 1.5, med + 3);
}

/**
 * PURE. Is the correct option conspicuously the SHORTEST?
 *
 * The mirror of longestAnswerCue, and I only had the one direction. md3's own
 * db:seed quality gate BLOCKS on "correct answer is shortest" and caught three of
 * my generated items that this harness had passed — a gap in my gate that the
 * repo's existing gate covered.
 *
 * Calibrated at 8% on both the official Step 1 and Step 3 sets, so it is a warn
 * (same order as clang-cue at 10%), not a flaw. The seed gate is stricter than
 * NBME's own practice; authoring should avoid it either way.
 */
export function shortestAnswerCue(item: ParsedItem): boolean {
  if (!item.answer || item.options.length < 3) return false;
  const correct = item.options.find((o) => o.label === item.answer);
  if (!correct) return false;
  const cl = correct.text.length;
  const others = item.options.filter((o) => o.label !== item.answer).map((o) => o.text.length);
  const minOther = Math.min(...others);
  return cl < minOther && (minOther - cl) / Math.max(1, cl) >= 0.25;
}

/**
 * PURE. Does a distinctive stem word reappear only in the correct option?
 *
 * Haladyna/Downing call this a clang/word-association cue. Only content words
 * ≥6 chars count — short function words repeat harmlessly.
 */
export function clangCue(item: ParsedItem): string | null {
  if (!item.answer) return null;
  const correct = item.options.find((o) => o.label === item.answer);
  if (!correct) return null;
  const stem = new Set(normWords(item.stem).filter((w) => w.length >= 6));
  const inCorrect = new Set(normWords(correct.text).filter((w) => w.length >= 6));
  const others = new Set(
    item.options.filter((o) => o.label !== item.answer).flatMap((o) => normWords(o.text)),
  );
  for (const w of inCorrect) {
    if (stem.has(w) && !others.has(w)) return w;
  }
  return null;
}

/**
 * PURE. Are the options grammatically/structurally homogeneous?
 *
 * NBME: options should be a single homogeneous series. A crude but reliable proxy
 * is dispersion of option length — a set mixing one-word drugs with clauses is
 * heterogeneous, and heterogeneity is itself a cue.
 */
export function optionHeterogeneity(item: ParsedItem): number {
  const lens = item.options.map((o) => words(o.text).length);
  if (lens.length < 2) return 0;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean === 0) return 0;
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
  return sd / mean; // coefficient of variation
}

/** PURE. Run every mechanical rule. Ordered most→least severe. */
export function checkItem(item: ParsedItem): RuleHit[] {
  const hits: RuleHit[] = [];
  const stem = item.stem || '';
  const optText = item.options.map((o) => o.text).join(' ');

  if (NONE_ALL_OF_ABOVE.test(optText)) {
    hits.push({
      rule: 'none-or-all-of-the-above',
      severity: 'flaw',
      detail: 'An "all/none of the above" option tests test-wiseness, not knowledge.',
      authority: 'NBME Item-Writing Guide; Haladyna taxonomy',
    });
  }
  if (NEGATIVE_LEADIN.test(leadIn(stem))) {
    hits.push({
      rule: 'negative-lead-in',
      severity: 'flaw',
      detail: 'Negatively-phrased lead-in ("EXCEPT", "least likely"); NBME writes lead-ins positively.',
      authority: 'NBME Item-Writing Guide',
    });
  }
  if (ABSOLUTE.test(optText)) {
    hits.push({
      rule: 'absolute-term-in-option',
      severity: 'flaw',
      detail: 'Absolute term ("always"/"never") makes an option reflexively rejectable.',
      authority: 'Haladyna/Downing taxonomy',
    });
  }
  if (longestAnswerCue(item)) {
    hits.push({
      rule: 'longest-answer-cue',
      severity: 'flaw',
      detail: 'Correct option is conspicuously the longest — the commonest unintended cue.',
      authority: 'NBME Item-Writing Guide',
    });
  }
  if (shortestAnswerCue(item)) {
    hits.push({
      rule: 'shortest-answer-cue',
      severity: 'warn',
      detail: 'Correct option is conspicuously the shortest; md3\'s seed gate blocks this.',
      authority: 'md3 question-bank quality gate; calibrated 8% on official Step 1/3',
    });
  }
  const clang = clangCue(item);
  if (clang) {
    hits.push({
      rule: 'clang-cue',
      severity: 'flaw',
      detail: `Distinctive stem word "${clang}" appears only in the correct option.`,
      authority: 'Haladyna/Downing taxonomy',
    });
  }
  if (!isClosedLeadIn(stem)) {
    hits.push({
      rule: 'open-lead-in',
      severity: 'warn',
      detail: 'The final sentence is not a single closed question.',
      authority: 'NBME Item-Writing Guide',
    });
  } else if (!NBME_HOUSE_LEADIN.test(leadIn(stem))) {
    hits.push({
      rule: 'non-house-lead-in',
      severity: 'warn',
      detail: 'Closed, but not phrased "Which of the following…" — every official item is.',
      authority: 'USMLE Step 1/2/3 sample items (254/254 measured)',
    });
  }
  if (!VIGNETTE_AGE.test(stem)) {
    hits.push({
      rule: 'no-patient-vignette',
      severity: 'warn',
      detail: 'No patient age/demographics — Step 1 items are clinical vignettes.',
      authority: 'NBME Item-Writing Guide; USMLE Step 1 sample items',
    });
  }
  // DELIBERATELY NO 'no-quantitative-data' RULE.
  // It fired on 56% of the 104 official NBME sample items, so absence of labs is
  // house-style variation, not a defect — plenty of legitimate Step 1 items are
  // pharmacology-mechanism or communication items with no numbers at all. A rule
  // that flags a third of the gold standard measures my expectations, not quality.
  if (VAGUE_FREQ.test(optText)) {
    hits.push({
      rule: 'vague-frequency-in-option',
      severity: 'warn',
      detail: 'Vague frequency term in an option ("usually", "may") blurs the correct/incorrect boundary.',
      authority: 'Haladyna/Downing taxonomy',
    });
  }
  const cv = optionHeterogeneity(item);
  if (cv > 0.75) {
    hits.push({
      rule: 'heterogeneous-options',
      severity: 'warn',
      detail: `Option lengths vary widely (CV ${cv.toFixed(2)}); options should form one homogeneous series.`,
      authority: 'NBME Item-Writing Guide',
    });
  }
  if (words(stem).length < 25) {
    hits.push({
      rule: 'stem-too-short',
      severity: 'warn',
      detail: `Stem is ${words(stem).length} words; a Step 1 vignette runs ~60-90.`,
      authority: 'USMLE Step 1 sample items (measured)',
    });
  }
  return hits;
}

export interface ItemScore {
  id: string;
  stemWords: number;
  optionCount: number;
  flaws: number;
  warns: number;
  rules: string[];
  /** 1.0 = no mechanical defect. A flaw costs 0.2, a warn 0.05, floored at 0. */
  score: number;
}

/** PURE. Score one item. */
export function scoreItem(item: ParsedItem): ItemScore {
  const hits = checkItem(item);
  const flaws = hits.filter((h) => h.severity === 'flaw').length;
  const warns = hits.filter((h) => h.severity === 'warn').length;
  return {
    id: item.id,
    stemWords: words(item.stem).length,
    optionCount: item.options.length,
    flaws,
    warns,
    rules: hits.map((h) => h.rule),
    score: Math.max(0, 1 - flaws * 0.2 - warns * 0.05),
  };
}
