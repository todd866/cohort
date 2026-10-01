/** Public, answer-safe Cohort topic-catalog contract. */
export const COHORT_SEARCH_MODALITIES = [
  'text',
  'ecg',
  'cxr',
  'paeds-derm',
] as const;

export type CohortSearchModality = (typeof COHORT_SEARCH_MODALITIES)[number];

export interface CohortSearchTopicV1 {
  id: string;
  label: string;
  aliases: string[];
  searchIntents: string[];
  learningOutcomes: string[];
  modalities: CohortSearchModality[];
  eligibleItemCount: number;
  eligibleAssetCount: number;
}
