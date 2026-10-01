/**
 * Source-level image requirement for dermatology questions.
 *
 * The classifier deliberately reads metadata only.  In particular, it does
 * not inspect stems, options, distractors, or explanations: an incidental
 * mention of a skin condition must not turn an unrelated question into a
 * blocking image requirement.
 */

export type DermatologyImageQuestion = {
  id?: unknown;
  topics?: unknown;
  topicId?: unknown;
  system?: unknown;
  moduleNodes?: unknown;
  stem?: unknown;
  context?: unknown;
  options?: unknown;
  imageUrl?: unknown;
  imageCaption?: unknown;
  imageRole?: unknown;
};

export type DermatologyImageIssue =
  | 'dermatology-image-url-required'
  | 'dermatology-image-caption-required'
  | 'dermatology-image-role-invalid';

// Keep this list conservative.  Generic rash/exanthem terms remain audit
// candidates, while an explicitly tagged named condition is a blocking match.
const CONDITION_TERMS = [
  'acne', 'alopecia areata', 'atopic dermatitis', 'basal cell carcinoma',
  'bullous impetigo', 'contact dermatitis', 'dermatitis herpetiformis',
  'eczema', 'erythema nodosum', 'erythema multiforme',
  'erythema toxicum neonatorum', 'impetigo', 'lichen planus', 'melanoma',
  'ichthyosis', 'ichthyosis vulgaris',
  'molluscum', 'molluscum contagiosum', 'nevus', 'pemphigus', 'pityriasis rosea',
  'psoriasis', 'scabies', 'seborrhoeic dermatitis', 'seborrheic dermatitis',
  'tinea', 'urticaria', 'vitiligo', 'warts',
  'dermatitis artefacta',
];

function valuesAsStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(valuesAsStrings);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(valuesAsStrings);
  }
  return [];
}

function normalise(value: string): string {
  return value.toLocaleLowerCase().replace(/[–—]/g, '-').replace(/[_/:-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function metadataSegments(value: string): string[] {
  return value.split(/[/>|,:]+/).map(normalise).filter(Boolean);
}

function isKnownCondition(value: string): boolean {
  const candidates = [normalise(value), ...metadataSegments(value)];
  return candidates.some(candidate => {
    // Haemangiomas may be internal (e.g. hepatic), so don't match the word
    // anywhere within an organ-specific tag as a skin condition.
    if (/^(?:infantile |cutaneous )?h(?:ae|e)mangioma$/.test(candidate)) return true;
    return CONDITION_TERMS.some(term =>
      new RegExp(`(?:^|\\s)${term}(?:\\s|$|\\()`).test(candidate));
  });
}

function hasExplicitDermatologyMetadata(question: DermatologyImageQuestion): boolean {
  const metadata = [question.topics, question.topicId, question.system, question.moduleNodes]
    .flatMap(valuesAsStrings)
    .filter(value => value.trim() !== '');

  return metadata.some(value => {
    if (/(?:^|\s)(?:dermatology|dermatological|derm)(?:\s|$)/.test(normalise(value))) return true;
    if (metadataSegments(value).some(segment => segment === 'skin')) return true;
    return isKnownCondition(value);
  });
}

export function isDermatologyQuestion(question: DermatologyImageQuestion): boolean {
  return hasExplicitDermatologyMetadata(question);
}

/** Metadata-only gate. Asset existence and review are intentionally CLI concerns. */
export function checkDermatologyImagePolicy(question: DermatologyImageQuestion): DermatologyImageIssue[] {
  if (!hasExplicitDermatologyMetadata(question)) return [];
  const issues: DermatologyImageIssue[] = [];
  if (typeof question.imageUrl !== 'string' || question.imageUrl.trim() === '') {
    issues.push('dermatology-image-url-required');
  }
  if (typeof question.imageCaption !== 'string' || question.imageCaption.trim() === '') {
    issues.push('dermatology-image-caption-required');
  }
  if (question.imageRole !== undefined && question.imageRole !== null && question.imageRole !== 'prompt') {
    issues.push('dermatology-image-role-invalid');
  }
  return issues;
}
