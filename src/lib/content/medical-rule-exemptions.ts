/**
 * Rotations that are not medical teaching, and the medical content rules that
 * therefore do not apply to them. An explicit, reviewed list: a rotation is
 * never exempt by default, and an exemption names each rule it lifts. The
 * other content gates (spelling, answer leaks, context caps, card shape) still
 * run on these rotations.
 *
 * Rules (the names the audits use):
 *   missing-source               "Card has no cite attribute" (card-validators)
 *   clinical-source-correlation  clinician/setting + two-source agreement on actions
 *   plain-clinical-language      clinical wording policy beyond house spelling
 *   cloze-granularity            giveaway / granularity / span cloze detectors (flag-detectors)
 *   cloze-design-screen          the per-card cloze-design ledger the morning check fills
 */
export type MedicalContentRule =
  | 'missing-source'
  | 'clinical-source-correlation'
  | 'plain-clinical-language'
  | 'cloze-granularity'
  | 'cloze-design-screen';

const EXEMPTIONS: Readonly<Record<string, readonly MedicalContentRule[]>> = Object.freeze({
  // A linked learner profile's general-knowledge deck: not medicine. Its
  // cards are original and carry no clinical claims, so there is no source
  // to cite and no clinical action to correlate.
  lp1: Object.freeze([
    'missing-source',
    'clinical-source-correlation',
    'plain-clinical-language',
    'cloze-granularity',
    'cloze-design-screen',
  ] as const),
});

export function isMedicalRuleExempt(rotation: string | null | undefined, rule: MedicalContentRule): boolean {
  if (!rotation) return false;
  return EXEMPTIONS[rotation]?.includes(rule) ?? false;
}

export function medicalRuleExemptRotations(rule: MedicalContentRule): string[] {
  return Object.entries(EXEMPTIONS).filter(([, rules]) => rules.includes(rule)).map(([rotation]) => rotation);
}
