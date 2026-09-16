/**
 * Split `unsupported` into a corpus gap and an UNVERIFIED NUMBER.
 *
 * Why this exists, precisely. On 2026-09-13 a learner reported that md3 taught
 * the adult Parkland constant (4 mL/kg/%TBSA) on paediatric burns cards. Morning
 * check had audited those cards — 72 ledger rows — and every verdict was
 * `unsupported-by-evidence`: the judge retrieved the right RCH guideline and
 * honestly reported that the coefficient was not in the retrieved passage.
 *
 * The rubric then routed that to the ACQUISITION queue, because `unsupported` is
 * defined as a corpus gap and never opens a ContentIssue. Nobody was ever asked
 * "this paediatric card asserts 4 mL/kg and nothing supports it — should a human
 * look?" The card kept serving, and md3 already held the correct 3 mL/kg in two
 * other places.
 *
 * The flaw is not the judge. It is that `unsupported` on a NUMERIC claim is
 * treated purely as a retrieval problem when it is also a risk signal: an
 * unverifiable number is exactly where a wrong number hides. Measured over
 * audit/content-factual/ledger.jsonl (19,842 rows), 1,248 rows are
 * unsupported/insufficient AND assert a specific number; 520 of those are doses
 * or volumes (critical-care 269, cah 97, pwh 74, malleus 66).
 *
 * This module does not judge correctness. It decides which unsupported verdicts
 * deserve a human, and in what order.
 */

/** Units ordered by harm-if-wrong, highest first. */
const UNIT_PATTERNS: ReadonlyArray<{ unit: string; weight: number; pattern: RegExp }> = Object.freeze([
  // A wrong dose or volume is administered to a patient.
  { unit: 'mmol', weight: 10, pattern: /\d+(?:\.\d+)?\s*mmol/i },
  { unit: 'mg', weight: 10, pattern: /\d+(?:\.\d+)?\s*mg\b/i },
  { unit: 'mL', weight: 10, pattern: /\d+(?:\.\d+)?\s*m[lL]\b/ },
  { unit: 'microg', weight: 10, pattern: /\d+(?:\.\d+)?\s*(?:mcg|microg|µg)/i },
  { unit: 'units', weight: 8, pattern: /\d+(?:\.\d+)?\s*units?\b/i },
  // A wrong threshold or weight-band changes management.
  { unit: 'kg', weight: 6, pattern: /\d+(?:\.\d+)?\s*kg\b/i },
  { unit: 'mmHg', weight: 6, pattern: /\d+\s*mmHg/i },
  // A wrong interval delays or rushes an intervention.
  { unit: 'hours', weight: 4, pattern: /\d+\s*(?:hours?|hrs?)\b/i },
  { unit: 'days', weight: 4, pattern: /\d+\s*days?\b/i },
  { unit: 'minutes', weight: 3, pattern: /\d+\s*(?:minutes?|mins?)\b/i },
  // A wrong prevalence misleads but rarely harms directly.
  { unit: '%', weight: 2, pattern: /\d+(?:\.\d+)?\s*%/ },
]);

/**
 * Rotations where the patient is a child, so an adult constant applied to them
 * is the specific failure this lane was built after. Weighted, not gated — an
 * adult dose can be wrong too.
 */
const PAEDIATRIC_ROTATIONS: ReadonlyArray<string> = Object.freeze(['cah', 'year3-common']);

export interface NumericClaimInput {
  /** The judge's verdict category, e.g. `unsupported-by-evidence`. */
  category?: string | null;
  /** The judge's prose explaining what it could not entail. */
  detail?: string | null;
  rotation?: string | null;
}

export interface NumericClaimRisk {
  /** 0 when this is an ordinary corpus gap and belongs in the harvest queue. */
  score: number;
  /** Units detected in the claim, so a worklist row can be checked by eye. */
  units: string[];
}

function isUnsupportedVerdict(category: string | null | undefined): boolean {
  const c = (category ?? '').toLowerCase();
  return c.includes('unsupport') || c.includes('insufficient') || c.includes('ungrounded');
}

function detectUnits(detail: string | null | undefined): Array<{ unit: string; weight: number }> {
  const text = detail ?? '';
  return UNIT_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ unit, weight }) => ({ unit, weight }));
}

/**
 * True when an unsupported verdict is about a specific number rather than a
 * missing topic. These are the ones that need a human, not more papers.
 */
export function isUnverifiedNumericAssertion(input: NumericClaimInput): boolean {
  if (!isUnsupportedVerdict(input.category)) return false;
  return detectUnits(input.detail).length > 0;
}

/**
 * Rank an unverified numeric claim by harm-if-wrong.
 *
 * Score is the heaviest unit found, doubled when the patient is a child —
 * a paediatric dose asserted without support is the exact shape of the defect
 * that prompted this. Returns 0 for anything that is not an unverified number,
 * so ordinary corpus gaps keep flowing to the harvest queue untouched.
 */
export function assessNumericClaimRisk(input: NumericClaimInput): NumericClaimRisk {
  if (!isUnsupportedVerdict(input.category)) return { score: 0, units: [] };

  const found = detectUnits(input.detail);
  if (found.length === 0) return { score: 0, units: [] };

  const heaviest = Math.max(...found.map((f) => f.weight));
  const paediatric = PAEDIATRIC_ROTATIONS.includes((input.rotation ?? '').toLowerCase());
  return {
    score: paediatric ? heaviest * 2 : heaviest,
    units: found.map((f) => f.unit),
  };
}
