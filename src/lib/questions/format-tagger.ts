/**
 * Heuristic format tagger for question stems.
 *
 * Maps a `(stem, topics, questionType)` triple to one of seven probe formats.
 * The format axis is orthogonal to topic — it captures the cognitive operation
 * the student must perform: recognition, mechanism, scenario reasoning, etc.
 *
 * Used by:
 * - `scripts/audit/concept-cluster-report.ts` — coverage analysis
 * - (future) scheduler — to prefer un-seen formats within a recently-served
 *   concept cluster
 *
 * Priority order matters: cloze > trap > comparison > mechanism > interpretation
 * > scenario > recall > unknown. The first matching rule wins.
 */

export type QuestionFormat =
  | 'cloze'
  | 'recall'
  | 'mechanism'
  | 'interpretation'
  | 'trap'
  | 'comparison'
  | 'scenario'
  | 'unknown';

export const ALL_FORMATS: QuestionFormat[] = [
  'cloze',
  'recall',
  'mechanism',
  'interpretation',
  'trap',
  'comparison',
  'scenario',
];

const PATTERNS = {
  cloze: /\[_+\]/,

  trap: /\bappears? normal\b|\bwould be reassuring\b|\bdeceptively normal\b|'normal'|"normal"|‘normal’|'reassuring'|\blooks normal\b|\bactually represents\b/i,

  comparison: /\bdistinguishe?s?\b|\bdifferentiate\b|\bcompared to\b|\bcompared with\b|\b versus \b|\b vs\.? \b|\b(?:more|less) likely than\b|\bbetter discriminat(?:es|ing)\b|\bbest discriminator\b/i,

  // Why / mechanism / cause / mediator / pathophysiology
  mechanism: /\bwhat is the (?:underlying )?mechanism\b|\bwhy does\b|\bwhy is\b|\bwhy are\b|\bwhat causes\b|\bwhich (?:mediator|cytokine|receptor|channel|enzyme|pathway)\b|\bvia which receptor\b|\bbest explains? the (?:cause|mechanism|pathophysiology)\b|\bwhat (?:is|are) responsible for\b|\bwhat underlies\b|\bwhat drives the\b|\bprimary driver\b|^why\b|\bwhy\??\s*$/i,

  // Lab tables/values strongly imply interpretation
  labTable: /\|\s*[^|\n]+\|[^|\n]+\|/,
  labValues: /\bABG\b|\bVBG\b|\bblood gas\b|\bPaCO[₂2]?\b|\bPaO[₂2]?\b|\bHCO[₃3]?\b|\bspo[₂2]\b|\bsao[₂2]\b|\bfio[₂2]\b|\betco[₂2]\b|\banion gap\b|\blactate\b/i,
  // pH 7.x or other lab readings inline
  inlineLab: /\bpH\s*\d+\.\d+\b|\bpH\s*\d{1}\.?\d?\b/i,
  interpretCue: /\binterpret(?:ation)?\b|\bmost likely interpretation\b|\bspirometry results\b|\bflow[/\\-]volume loop\b|\bECG (?:shows|demonstrates)\b|\bCXR (?:shows|demonstrates)\b/i,

  // Vignette: starts with a patient demographic OR mid-stem clinical narrative
  ageVignette: /^\s*(?:a |an )?\d+[\-\s/]*(?:year|month|week|day)[\s-]*old\b/i,
  patientVignette: /^\s*(?:a |an )\s*(?:[\w-]+\s+){0,3}(?:woman|man|child|infant|baby|newborn|girl|boy|patient|adolescent|teenager|elderly|pregnant|gravida|primigravida|multigravida)\b/i,
  professionalNarrative: /^\s*you are (?:a |an |the )?(?:gp|doctor|nurse|consultant|registrar|intern|resident|midwife|paramedic)\b/i,

  // Recall: terse factual ask, no vignette
  recallOpener: /^\s*(?:what|which|where|when|who|how (?:much|many|long|often)|by what|at what|in (?:what|which)|name |list )/i,
};

export interface TagFormatOptions {
  /** When true, returns 'unknown' rather than falling back to 'recall' for terse stems with `questionType="recall"`. */
  strict?: boolean;
}

export function tagFormat(
  stem: string,
  topics: string[] | null | undefined,
  questionType: string | null | undefined,
  options: TagFormatOptions = {},
): QuestionFormat {
  const s = (stem ?? '').trim();
  const lower = s.toLowerCase();
  const t = (topics ?? []).map((x) => x.toLowerCase());

  if (!s) return 'unknown';

  // 1. Cloze beats everything — physical [___] markers
  if (PATTERNS.cloze.test(s)) return 'cloze';

  // 2. Trap framing
  if (t.includes('trap')) return 'trap';
  if (PATTERNS.trap.test(lower)) return 'trap';

  // 3. Comparison framing
  if (PATTERNS.comparison.test(lower)) return 'comparison';

  // 4. Mechanism — explicit "why/mechanism/cause/responsible-for" cues
  if (PATTERNS.mechanism.test(lower)) return 'mechanism';

  // 5. Interpretation — table or lab values, or explicit "interpret"
  if (PATTERNS.labTable.test(s)) return 'interpretation';
  if (PATTERNS.interpretCue.test(lower)) return 'interpretation';
  if (PATTERNS.inlineLab.test(s) && PATTERNS.labValues.test(lower)) return 'interpretation';

  // 6. Scenario — vignette starter
  if (PATTERNS.ageVignette.test(s)) return 'scenario';
  if (PATTERNS.patientVignette.test(s)) return 'scenario';
  if (PATTERNS.professionalNarrative.test(s)) return 'scenario';

  // 7. Plain recall opener — what/which/where/etc. without case framing
  if (PATTERNS.recallOpener.test(s)) return 'recall';

  // 8. Fallback — use questionType if it gives a hint
  if (!options.strict && questionType === 'recall') return 'recall';

  return 'unknown';
}

/** Counts each format across an iterable of (stem, topics, questionType) inputs. */
export function tallyFormats<T>(
  items: Iterable<T>,
  pick: (it: T) => { stem: string; topics?: string[] | null; questionType?: string | null },
): Record<QuestionFormat, number> {
  const counts: Record<QuestionFormat, number> = {
    cloze: 0, recall: 0, mechanism: 0, interpretation: 0,
    trap: 0, comparison: 0, scenario: 0, unknown: 0,
  };
  for (const it of items) {
    const { stem, topics, questionType } = pick(it);
    counts[tagFormat(stem, topics, questionType)] += 1;
  }
  return counts;
}
