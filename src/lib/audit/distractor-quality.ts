export interface DistractorQualityInput {
  totalDistractors: number;
  misconceptionCoverage: number; // how many have Misconception links
  deadDistractors: number;       // never selected (0 picks with enough data)
  llmPlausibility: number;       // 0-1 from complexity scorer
}

/**
 * Composite distractor quality score (0-1).
 *
 * Three signals weighted equally:
 * - Coverage: fraction of distractors with misconception links (0-1)
 * - Health: fraction of distractors that are NOT dead (0-1)
 * - Plausibility: LLM estimate of distractor quality (0-1)
 */
export function computeDistractorQuality(input: DistractorQualityInput): number {
  if (input.totalDistractors === 0) return 0;

  const coverage = input.misconceptionCoverage / input.totalDistractors;
  const health = 1 - (input.deadDistractors / input.totalDistractors);
  const plausibility = input.llmPlausibility;

  return (coverage + health + plausibility) / 3;
}
