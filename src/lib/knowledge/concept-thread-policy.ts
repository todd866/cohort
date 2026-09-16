/**
 * Clinical concept-thread follow-up policy.
 *
 * A vector neighbour is not automatically a useful follow-up: it may be a
 * paraphrase of the same fact. A useful thread revisits the same *specific*
 * clinical topic through a different facet (cause -> presentation ->
 * investigation -> management) after enough unrelated material has elapsed.
 *
 * This module is deliberately pure. Selection paths can share the same
 * conservative matching and cadence rules without importing the database.
 */

export const CONCEPT_THREAD_POLICY_VERSION = 'clinical-thread-facets-v1';

export const CONCEPT_THREAD_MIN_AGE_MS = 15 * 60 * 1000;
export const CONCEPT_THREAD_NATURAL_BREAK_MS = 12 * 60 * 60 * 1000;
export const CONCEPT_THREAD_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CONCEPT_THREAD_MIN_INTERVENING_EXPOSURES = 5;

export type ClinicalFacet =
  | 'cause_mechanism'
  | 'presentation'
  | 'diagnosis_investigation'
  | 'management'
  | 'complications_prognosis'
  | 'unknown';

export interface ClinicalThreadItem {
  id: string;
  itemType: 'card' | 'question';
  text: string;
  topics: readonly string[];
  questionType?: string | null;
  format?: string | null;
  conceptIds?: readonly string[];
  variantGroupId?: string | null;
}

export interface ClinicalThreadAnchor extends ClinicalThreadItem {
  anchorEventId: string;
  answeredAtMs: number;
  interveningExposures: number;
}

export interface ConceptThreadMatch {
  policyVersion: typeof CONCEPT_THREAD_POLICY_VERSION;
  anchorEventId: string;
  anchorItemId: string;
  anchorFacet: Exclude<ClinicalFacet, 'unknown'>;
  targetFacet: Exclude<ClinicalFacet, 'unknown'>;
  sharedTopic: string;
  ageMs: number;
  interveningExposures: number;
  targetPreference: number;
}

type KnownClinicalFacet = Exclude<ClinicalFacet, 'unknown'>;

interface PreparedClinicalThreadItem {
  id: string;
  variantGroupId: string | null;
  facet: ClinicalFacet;
  conceptIds: ReadonlySet<string>;
  specificTopics: ReadonlySet<string>;
  normalizedText: string;
  textPhrases: ReadonlySet<string>;
}

interface PreparedClinicalThreadAnchor extends PreparedClinicalThreadItem {
  anchorEventId: string;
  ageMs: number;
  interveningExposures: number;
  inputRank: number;
  facet: KnownClinicalFacet;
}

interface PreparedAnchorTarget {
  anchor: PreparedClinicalThreadAnchor;
  targetPreference: number;
}

export interface PreparedConceptThreadMatcher {
  /** Mature, known-facet anchors retained by the frozen matcher. */
  readonly anchorCount: number;
  findMatch(candidate: ClinicalThreadItem): ConceptThreadMatch | null;
  findMatches(candidates: readonly ClinicalThreadItem[]): Array<ConceptThreadMatch | null>;
}

const GENERIC_TOPICS = new Set([
  'acute',
  'adolescent',
  'adult',
  'anatomy',
  'basic science',
  'boy',
  'boys',
  'cah',
  'cardiology',
  'child',
  'children',
  'classification',
  'clinical',
  'clinical features',
  'critical care',
  'diagnosis',
  'differential',
  'differential diagnosis',
  'emergency',
  'epidemiology',
  'girl',
  'girls',
  'health',
  'infant',
  'infants',
  'infection',
  'investigation',
  'management',
  'mechanism',
  'medicine',
  'microbiology',
  'musculoskeletal',
  'neonatal',
  'neonate',
  'newborn',
  'orthopaedics',
  'paam',
  'paediatric',
  'paediatrics',
  'pathology',
  'pathophysiology',
  'presentation',
  'pwh',
  'recall',
  'rheumatology',
  'surgical',
  'toddler',
  'toddlers',
  'treatment',
  'usmle',
  'usmle step1',
]);

// Used only when neither item has a specific authored topic. Removing these
// common prompt/facet words lets a shared condition phrase such as
// "septic arthritis" survive without treating "most likely diagnosis" as a
// clinical family. Text fallback requires at least two remaining contiguous
// tokens; single-word overlap is too ambiguous to override sparse metadata.
const GENERIC_TEXT_TOKENS = new Set([
  'a',
  'about',
  'acute',
  'adult',
  'after',
  'an',
  'and',
  'are',
  'best',
  'by',
  'case',
  'cause',
  'caused',
  'causes',
  'causative',
  'child',
  'children',
  'chronic',
  'clinical',
  'common',
  'complication',
  'condition',
  'definitive',
  'diagnosis',
  'diagnosed',
  'does',
  'disease',
  'disorder',
  'emergency',
  'female',
  'features',
  'following',
  'for',
  'how',
  'in',
  'investigation',
  'is',
  'like',
  'look',
  'management',
  'male',
  'man',
  'medical',
  'mechanism',
  'most',
  'next',
  'of',
  'old',
  'organism',
  'patient',
  'presentation',
  'presents',
  'sign',
  'signs',
  'symptom',
  'symptoms',
  'syndrome',
  'the',
  'therapy',
  'to',
  'treat',
  'treated',
  'treatment',
  'what',
  'which',
  'with',
  'woman',
  'year',
]);

const FACET_TARGETS: Record<KnownClinicalFacet, readonly KnownClinicalFacet[]> = {
  cause_mechanism: ['presentation', 'diagnosis_investigation', 'management'],
  presentation: ['diagnosis_investigation', 'management', 'complications_prognosis'],
  diagnosis_investigation: ['management', 'complications_prognosis', 'cause_mechanism'],
  management: ['complications_prognosis', 'diagnosis_investigation', 'cause_mechanism'],
  complications_prognosis: ['management', 'diagnosis_investigation', 'cause_mechanism'],
};

export function normalizeClinicalThreadText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizedTopic(topic: string): string | null {
  const normalized = normalizeClinicalThreadText(topic);
  if (normalized.length < 4 || GENERIC_TOPICS.has(normalized)) return null;
  return normalized;
}

function normalizedConceptIds(conceptIds: readonly string[] | undefined): Set<string> {
  return new Set(
    (conceptIds ?? [])
      .map(id => id.trim())
      .filter(Boolean),
  );
}

function conceptsAreCompatible(
  anchorConceptIds: ReadonlySet<string>,
  candidateConceptIds: ReadonlySet<string>,
): boolean {
  // A missing attribution is not evidence against a strong specific-topic
  // match. When both sides are attributed, however, fail closed on conflict.
  if (anchorConceptIds.size === 0 || candidateConceptIds.size === 0) return true;
  for (const id of candidateConceptIds) {
    if (anchorConceptIds.has(id)) return true;
  }
  return false;
}

function inferClinicalFacetFromNormalized(
  questionType: string,
  text: string,
): ClinicalFacet {
  // Explicit authored type is stronger than incidental words in a topic or
  // vignette (for example, a presentation item whose explanation mentions
  // treatment). Legacy catch-all types such as "knowledge" fall through to
  // the wording classifier below.
  if (['management', 'next step', 'treatment', 'therapy'].includes(questionType)) return 'management';
  if (['complication', 'complications', 'prognosis', 'adverse effect', 'outcome'].includes(questionType)) {
    return 'complications_prognosis';
  }
  if (['clinical features', 'presentation'].includes(questionType)) return 'presentation';
  if ([
    'diagnosis',
    'investigation',
    'interpretation',
    'image interpretation',
    'clinical reasoning',
    'discrimination',
  ].includes(questionType)) {
    return 'diagnosis_investigation';
  }
  if ([
    'mechanism',
    'basic science',
    'pathophysiology',
    'risk factors',
    'epidemiology',
    'physiology',
    'aetiology',
    'etiology',
  ].includes(questionType)) {
    return 'cause_mechanism';
  }

  if (/\b(causative|caused by|cause of|causes of|organism|aetiolog|etiolog|mechanism|pathophysiolog|risk factor)\b/.test(text)) {
    return 'cause_mechanism';
  }
  if (/\b(clinical features|presents with|presentation|signs and symptoms|what does .* look like)\b/.test(text)) {
    return 'presentation';
  }
  if (/\b(diagnos(?:is|e|ed|tic|tics)?|investigat(?:e|ed|ion|ions|ive)?|test confirms|most likely diagnosis|differentiat(?:e|es|ing|ion)|criteria)\b/.test(text)) {
    return 'diagnosis_investigation';
  }
  if (/\b(complication|complications|prognosis|outcome|sequela|sequelae|adverse effect)\b/.test(text)) {
    return 'complications_prognosis';
  }
  if (/\b(manage|management|treat|treatment|therapy|first line|next best step|definitive management)\b/.test(text)) {
    return 'management';
  }
  return 'unknown';
}

/**
 * Infer a coarse clinical facet. Explicit question type wins; wording/topics
 * are a fallback for legacy question types and cards.
 */
export function inferClinicalFacet(item: ClinicalThreadItem): ClinicalFacet {
  const normalizedText = normalizeClinicalThreadText(item.text);
  const normalizedFormat = normalizeClinicalThreadText(item.format ?? '');
  return inferClinicalFacetFromNormalized(
    normalizeClinicalThreadText(item.questionType ?? ''),
    [normalizedText, normalizedFormat].filter(Boolean).join(' '),
  );
}

export function conceptThreadAnchorIsMature(
  anchor: Pick<ClinicalThreadAnchor, 'answeredAtMs' | 'interveningExposures'>,
  nowMs: number,
): boolean {
  const ageMs = nowMs - anchor.answeredAtMs;
  if (!Number.isFinite(ageMs) || ageMs < CONCEPT_THREAD_MIN_AGE_MS) return false;
  if (ageMs > CONCEPT_THREAD_MAX_AGE_MS) return false;
  return ageMs >= CONCEPT_THREAD_NATURAL_BREAK_MS
    || anchor.interveningExposures >= CONCEPT_THREAD_MIN_INTERVENING_EXPOSURES;
}

function textContainsTopic(text: string, topic: string): boolean {
  return ` ${text} `.includes(` ${topic} `);
}

function topicCanBridgeIntoText(topic: string): boolean {
  // A single authored word is often a population, anatomy, or curriculum tag
  // (for example "children" or "neonatal"), not a condition identity. It may
  // be retained only when it is a non-generic specific topic on both items; it
  // is too weak to infer a family merely because it appears in one item's stem.
  return topic.includes(' ');
}

function specificTextPhrasesFromNormalizedText(normalizedText: string): Set<string> {
  const tokens = normalizedText
    .split(' ')
    .filter(token => token.length >= 3 && !GENERIC_TEXT_TOKENS.has(token));
  const phrases = new Set<string>();
  for (let size = 2; size <= Math.min(4, tokens.length); size++) {
    for (let index = 0; index + size <= tokens.length; index++) {
      phrases.add(tokens.slice(index, index + size).join(' '));
    }
  }
  return phrases;
}

function prepareClinicalThreadItem(item: ClinicalThreadItem): PreparedClinicalThreadItem {
  // Read each potentially computed content field once. Live static-map rows can
  // expose getters, and repeated reads here would defeat the prepared matcher.
  const text = item.text;
  const topics = item.topics;
  const conceptIds = item.conceptIds;
  const questionType = item.questionType ?? '';
  const format = item.format ?? '';
  const normalizedText = normalizeClinicalThreadText(text);
  const normalizedFormat = normalizeClinicalThreadText(format);

  return {
    id: item.id,
    variantGroupId: item.variantGroupId ?? null,
    facet: inferClinicalFacetFromNormalized(
      normalizeClinicalThreadText(questionType),
      [normalizedText, normalizedFormat].filter(Boolean).join(' '),
    ),
    conceptIds: normalizedConceptIds(conceptIds),
    specificTopics: new Set(
      topics.map(normalizedTopic).filter((topic): topic is string => topic !== null),
    ),
    normalizedText,
    textPhrases: specificTextPhrasesFromNormalizedText(normalizedText),
  };
}

function sharedPreparedClinicalThreadTopic(
  anchor: PreparedClinicalThreadItem,
  candidate: PreparedClinicalThreadItem,
): string | null {
  if (!conceptsAreCompatible(anchor.conceptIds, candidate.conceptIds)) return null;

  const matches = new Set<string>();
  for (const topic of candidate.specificTopics) {
    if (
      anchor.specificTopics.has(topic)
      || (topicCanBridgeIntoText(topic) && textContainsTopic(anchor.normalizedText, topic))
    ) {
      matches.add(topic);
    }
  }
  for (const topic of anchor.specificTopics) {
    if (
      candidate.specificTopics.has(topic)
      || (topicCanBridgeIntoText(topic) && textContainsTopic(candidate.normalizedText, topic))
    ) {
      matches.add(topic);
    }
  }

  if (matches.size === 0) {
    for (const phrase of candidate.textPhrases) {
      if (anchor.textPhrases.has(phrase)) matches.add(phrase);
    }
  }

  if (matches.size === 0) return null;
  return [...matches].sort((left, right) => {
    const leftTokens = left.split(' ').length;
    const rightTokens = right.split(' ').length;
    return rightTokens - leftTokens || right.length - left.length || left.localeCompare(right);
  })[0];
}

/**
 * Find the strongest specific topic shared by an anchor and candidate.
 * Generic curriculum/domain labels are deliberately ignored.
 */
export function sharedClinicalThreadTopic(
  anchor: ClinicalThreadItem,
  candidate: ClinicalThreadItem,
): string | null {
  return sharedPreparedClinicalThreadTopic(
    prepareClinicalThreadItem(anchor),
    prepareClinicalThreadItem(candidate),
  );
}

function prepareClinicalThreadAnchor(
  anchor: ClinicalThreadAnchor,
  nowMs: number,
  inputRank: number,
): PreparedClinicalThreadAnchor | null {
  const answeredAtMs = anchor.answeredAtMs;
  const interveningExposures = anchor.interveningExposures;
  if (!conceptThreadAnchorIsMature({ answeredAtMs, interveningExposures }, nowMs)) {
    return null;
  }

  const prepared = prepareClinicalThreadItem(anchor);
  if (prepared.facet === 'unknown') return null;
  return {
    ...prepared,
    anchorEventId: anchor.anchorEventId,
    ageMs: nowMs - answeredAtMs,
    interveningExposures,
    inputRank,
    facet: prepared.facet,
  };
}

function comparePreparedAnchorTargets(
  left: PreparedAnchorTarget,
  right: PreparedAnchorTarget,
): number {
  return left.targetPreference - right.targetPreference
    || left.anchor.ageMs - right.anchor.ageMs
    || right.anchor.interveningExposures - left.anchor.interveningExposures
    || left.anchor.anchorEventId.localeCompare(right.anchor.anchorEventId)
    || left.anchor.inputRank - right.anchor.inputRank;
}

function matchPreparedCandidate(
  candidate: PreparedClinicalThreadItem,
  orderedAnchors: readonly PreparedAnchorTarget[],
): ConceptThreadMatch | null {
  if (candidate.facet === 'unknown') return null;

  for (const entry of orderedAnchors) {
    const anchor = entry.anchor;
    if (candidate.id === anchor.id) continue;
    if (candidate.facet === anchor.facet) continue;
    if (
      candidate.variantGroupId
      && anchor.variantGroupId
      && candidate.variantGroupId === anchor.variantGroupId
    ) {
      continue;
    }
    const sharedTopic = sharedPreparedClinicalThreadTopic(anchor, candidate);
    if (!sharedTopic) continue;

    return {
      policyVersion: CONCEPT_THREAD_POLICY_VERSION,
      anchorEventId: anchor.anchorEventId,
      anchorItemId: anchor.id,
      anchorFacet: anchor.facet,
      targetFacet: candidate.facet,
      sharedTopic,
      ageMs: anchor.ageMs,
      interveningExposures: anchor.interveningExposures,
      targetPreference: entry.targetPreference,
    };
  }
  return null;
}

/**
 * Freeze and normalize an anchor pool once for repeated candidate matching.
 * Mature anchors are grouped by target facet and pre-sorted with the legacy
 * match comparator, so candidate evaluation performs no anchor normalization
 * and no per-candidate sorting.
 */
export function prepareConceptThreadMatcher(
  anchors: readonly ClinicalThreadAnchor[],
  nowMs: number,
): PreparedConceptThreadMatcher {
  const preparedAnchors = anchors
    .map((anchor, inputRank) => prepareClinicalThreadAnchor(anchor, nowMs, inputRank))
    .filter((anchor): anchor is PreparedClinicalThreadAnchor => anchor !== null);
  const anchorsByTargetFacet = new Map<KnownClinicalFacet, PreparedAnchorTarget[]>();

  for (const anchor of preparedAnchors) {
    FACET_TARGETS[anchor.facet].forEach((targetFacet, targetPreference) => {
      const targets = anchorsByTargetFacet.get(targetFacet);
      const entry = { anchor, targetPreference };
      if (targets) targets.push(entry);
      else anchorsByTargetFacet.set(targetFacet, [entry]);
    });
  }
  for (const targets of anchorsByTargetFacet.values()) {
    targets.sort(comparePreparedAnchorTargets);
  }

  const findMatch = (candidate: ClinicalThreadItem): ConceptThreadMatch | null => {
    const preparedCandidate = prepareClinicalThreadItem(candidate);
    if (preparedCandidate.facet === 'unknown') return null;
    return matchPreparedCandidate(
      preparedCandidate,
      anchorsByTargetFacet.get(preparedCandidate.facet) ?? [],
    );
  };

  return {
    anchorCount: preparedAnchors.length,
    findMatch,
    findMatches: candidates => candidates.map(findMatch),
  };
}

/** Best mature same-thread/different-facet anchor for a candidate. */
export function findConceptThreadMatch(
  candidate: ClinicalThreadItem,
  anchors: readonly ClinicalThreadAnchor[],
  nowMs: number,
): ConceptThreadMatch | null {
  return prepareConceptThreadMatcher(anchors, nowMs).findMatch(candidate);
}
