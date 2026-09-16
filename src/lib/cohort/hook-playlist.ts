/** Fixed first-three playlist for every new cohort.md visitor. */
export const COHORT_HOOK_V1_IDS = [
  'bank:usmle-step1:phys-diabetes-high-glucose:v1',
  'bank:usmle-step1:phys-htn-arterial-force:v1',
  'bank:usmle-step1:phys-hf-inadequate-pump:v1',
] as const;

export type CohortHookQuestionId = (typeof COHORT_HOOK_V1_IDS)[number];
