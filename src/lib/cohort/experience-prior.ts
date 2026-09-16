import type { DifficultyTier } from '@/lib/usmle/step1-adaptive';

export type CohortExperience =
  | 'just-got-here'
  | 'high-school'
  | 'undergrad'
  | 'premed'
  | 'medical-student';

export const COHORT_EXPERIENCE_OPTIONS = [
  { id: 'just-got-here', label: 'I just got here' },
  { id: 'high-school', label: 'high school' },
  { id: 'undergrad', label: 'undergrad' },
  { id: 'premed', label: 'premed' },
  { id: 'medical-student', label: 'medical student' },
] as const satisfies ReadonlyArray<{ id: CohortExperience; label: string }>;

const ALL_TIERS: DifficultyTier[] = ['easy', 'medium', 'hard'];

/**
 * Exact topic tags for questions with immediate lay purchase: familiar diseases,
 * visible clinical stakes, and public-health concepts a broad visitor can name.
 *
 * This is deliberately an auditable structured-metadata allowlist, not a stem
 * keyword classifier. It is a soft tie-break only; adaptive tier and a missed
 * question's ladder/domain remain stronger signals, and the full eligible pool
 * remains available as fallback.
 */
export const COHORT_LAY_PURCHASE_TOPIC_TAGS = [
  'diabetes',
  'diabetes mellitus',
  'type 1 diabetes',
  'diabetic ketoacidosis',
  'insulin',
  'blood glucose',
  'heart failure',
  'blood pressure',
  'blood pressure regulation',
  'hypertension',
  'cardiac output',
  'heart sounds',
  'asthma',
  'anemia',
  'iron deficiency anemia',
  'sickle cell disease',
  'seizure',
  'seizures',
  'migraine',
  'chronic kidney disease',
  'influenza',
  'hepatitis a',
  'hepatitis b',
  'hepatitis c',
  'measles',
  'tetanus',
  'tuberculosis',
  'zoster',
  'shingles',
  'meningitis',
  'pertussis',
  'polio',
  'diphtheria',
  'mumps',
  'rubella',
  'rotavirus',
  'vaccination',
  'vaccination principles',
  'vaccine classification',
  'live attenuated vaccines',
  'inactivated vaccines',
  'conjugate vaccines',
  'passive immunity',
] as const;

export interface CohortCandidatePreference {
  topicTags: readonly string[];
}

export function allowedDifficulties(
  experience: CohortExperience | undefined,
): DifficultyTier[] {
  if (experience === 'just-got-here' || experience === 'high-school') {
    return ['easy'];
  }
  if (experience === 'undergrad') return ['easy', 'medium'];
  return ALL_TIERS;
}

/**
 * Give broad-audience cohorts a recognizable first foothold after the hook.
 * Unknown is treated conservatively as a broad visitor; premed and medical
 * students retain the unmodified adaptive corpus order.
 */
export function cohortCandidatePreference(
  experience: CohortExperience | undefined,
): CohortCandidatePreference | undefined {
  if (experience === 'premed' || experience === 'medical-student') return undefined;
  return { topicTags: COHORT_LAY_PURCHASE_TOPIC_TAGS };
}
