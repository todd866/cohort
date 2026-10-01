import { normalizeTopic } from '@/lib/topics';

/**
 * Population, filing and teaching labels are useful for discovery, but do not
 * establish that one item teaches another. In particular, a chapter may tag
 * every card with several specialties, so even a shared specialty is too weak
 * for a concept fallback or a pre-emptive teaching insert.
 *
 * This is a conservative metadata guard, not a clinical truth classifier. It
 * does not infer synonyms or reject explicit concept links. Missing specific
 * metadata leaves an item available to the ordinary rotation pool.
 */
const BROAD_TOPIC_WORDS = new Set([
  'a', 'an', 'and', 'of', 'in', 'the', 'with',
  'acute', 'adult', 'adults', 'adolescent', 'adolescents', 'child', 'children',
  'infant', 'infants', 'neonate', 'neonates', 'neonatal', 'newborn', 'newborns',
  'paediatric', 'paediatrics', 'pediatric', 'pediatrics', 'toddler', 'toddlers',
  'cah', 'paam', 'pwh', 'toc', 'usmle', 'critical', 'care',
  'anatomy', 'cardiac', 'cardiology', 'community', 'dental', 'dentistry',
  'dermatology', 'developmental', 'emergency', 'emergencies', 'endocrine',
  'endocrinology', 'ent', 'urology', 'psychiatry', 'radiology', 'nephrology',
  'neonatology', 'allergy', 'obstetrics', 'anaesthesia', 'anesthesia', 'trauma', 'gastroenterology', 'general', 'genetics',
  'haematology', 'hematology', 'immunology', 'infectious', 'infection',
  'infections', 'disease', 'diseases', 'medical', 'medicine', 'microbiology',
  'musculoskeletal', 'neurology', 'oncology', 'ophthalmology', 'orthopaedics',
  'orthopedics', 'pathology', 'physiology', 'renal', 'respiratory', 'rheumatology',
  'surgery', 'surgical',
  'assessment', 'basic', 'classification', 'clinical', 'complications',
  'diagnosis', 'differential', 'disorder', 'disorders', 'epidemiology',
  'examination', 'features', 'health', 'imaging', 'interpretation',
  'investigation', 'investigations', 'management', 'mechanism', 'pathophysiology',
  'presentation', 'prevention', 'prognosis', 'recall', 'recognition',
  'science', 'signs', 'status', 'symptoms', 'syndrome', 'syndromes', 'therapy',
  'treatment', 'additional', 'essentials', 'pearls', 'principles', 'sick',
]);

export function specificClinicalTopics(topics: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const topic of topics) {
    // Split filing punctuation before the shared normalizer removes it. This
    // also rejects generated labels such as "Dermatology (CAH" in their entirety.
    const normalized = normalizeTopic(topic.replace(/[()&/]/g, ' '));
    if (!normalized) continue;
    if (normalized.split(' ').every(word => BROAD_TOPIC_WORDS.has(word))) continue;
    result.add(normalized);
  }
  return result;
}

export function hasSpecificClinicalTopicOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const specificLeft = specificClinicalTopics(left);
  if (specificLeft.size === 0) return false;
  return [...specificClinicalTopics(right)].some(topic => specificLeft.has(topic));
}
